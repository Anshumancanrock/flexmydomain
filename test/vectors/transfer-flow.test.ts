// A whole direct-transfer escrow as the three pages run it, over a real relay. Only the chain is stubbed.

import { test, expect, afterAll } from 'bun:test'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { startRelay } from '../harness/relay.ts'
import { publishToRelays, queryRelays, type RelayAuth } from '../../net/relay.ts'
import { readMessages, wrapForEach } from '../../client/messages.ts'
import {
  ESCROW_D_PREFIX,
  buildAuthEvent,
  buildEscrowEvent,
  buildEscrowMessage,
  buildInvite,
  buildReply,
  buildRuling,
  compareViews,
  decodeInvite,
  decodeReply,
  deriveEscrowId,
  encodeInvite,
  encodeReply,
  escrowAddress,
  escrowChats,
  escrowFilters,
  escrowTree,
  giftWrapFilter,
  latestCard,
  parseEscrowEvent,
  parseRuling,
  resolveHandshake,
  signEvent,
  type ChatCard,
  type ChatRole,
  type EscrowParams,
  type EscrowParties,
  type EscrowView,
  type Invite,
} from '../../core/nostr/index.ts'
import {
  SITE_RULES,
  arbiterRule,
  collectSettlements,
  completeSettlement,
  proposalOf,
  settlementFee,
  signSettlement,
  type SignedSettlement,
} from '../../core/escrow/index.ts'

// Like relay.damus.io: a key gets its gift wraps only once it has signed in as itself.
const relay = startRelay({ requireAuth: true })
afterAll(() => relay.close())

const RULES = SITE_RULES.signet
const NOW = 1_789_430_400
const key = (f: number) => new Uint8Array(32).fill(f)
const hx = (sk: Uint8Array) => bytesToHex(schnorr.getPublicKey(sk))
// Nostr identities sign the handshake; fresh tree keys go in the escrow.
const BUYER_NOSTR = key(0x51), SELLER_NOSTR = key(0x52)
const BUYER = key(0x61), SELLER = key(0x62), ARBITER = key(0x63)
const KEYS: Record<ChatRole, Uint8Array> = { buyer: BUYER, seller: SELLER, arbiter: ARBITER }
const DEST_SELLER = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const DEST_BUYER = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7'
const VALUE = 250_000n
const F = 1000 // funding block
const TO: ChatCard = { kind: 'transfer-to', registrar: 'Namecheap', account: 'buyer_77', email: 'buyer@example.com' }
const CODE: ChatCard = { kind: 'transfer-sent', method: 'code', code: 'Xy9#auth-CODE', note: 'unlocked it for you' }
let at = NOW

async function open(salt: string) {
  const invite: Invite = {
    salt, domain: 'lumenary.com', amountSats: Number(VALUE), network: 'signet',
    timeoutBlocks: RULES.timeoutBlocks, deliverBlocks: RULES.deliverBlocks,
    arbiter: hx(ARBITER), initiatorRole: 'buyer', initiatorKey: hx(BUYER), to: hx(SELLER_NOSTR),
  }
  const inviteText = encodeInvite(signEvent(buildInvite(invite, { pubkey: hx(BUYER_NOSTR), createdAt: NOW }), BUYER_NOSTR))

  const opened = decodeInvite(inviteText)
  if (!opened.ok) throw new Error(opened.reason)
  const replyText = encodeReply(signEvent(buildReply({ joinerKey: hx(SELLER) }, { pubkey: hx(SELLER_NOSTR), createdAt: NOW, invite: opened }), SELLER_NOSTR))
  const reply = decodeReply(replyText, opened)
  if (!reply.ok) throw new Error(reply.reason)
  const r = resolveHandshake(opened.invite, reply.reply)
  const params: EscrowParams = {
    salt: r.salt, buyer: hexToBytes(r.buyerKey), seller: hexToBytes(r.sellerKey), arbiter: hexToBytes(r.arbiter),
    timeoutBlocks: r.timeoutBlocks, deliverBlocks: r.deliverBlocks, network: r.network, amountSats: r.amountSats, domain: r.domain,
  }
  const id = deriveEscrowId(params)
  // Bound to the id, as every page builds it.
  const tree = escrowTree(params)
  expect(tree.addresses[params.network]).toBe(escrowAddress(params))
  const parties: EscrowParties = { id, buyer: hx(BUYER), seller: hx(SELLER), arbiter: hx(ARBITER) }

  const publish = async (sk: Uint8Array, over: Record<string, unknown> = {}) => {
    const event = signEvent(buildEscrowEvent({ ...params, pubkey: hx(sk), createdAt: ++at, ...over }), sk)
    expect((await publishToRelays([relay.url], event)).every((x) => x.ok)).toBe(true)
  }
  await publish(BUYER)
  await publish(SELLER)

  const read = async () => {
    const events = await queryRelays([relay.url], escrowFilters(id, [hx(BUYER), hx(SELLER), hx(ARBITER)]), { timeoutMs: 2000 })
    const views = events
      .filter((e) => e.tags.some((t) => t[0] === 'd' && t[1] === ESCROW_D_PREFIX + id))
      .map((e) => parseEscrowEvent(e))
      .flatMap((x) => (x.ok ? [x.view] : []))
    const rulings = events.map((e) => parseRuling(e)).flatMap((x) => (x.ok && x.ruling.author === hx(ARBITER) ? [x.ruling] : []))
    return { c: compareViews(views, id), ruling: rulings[0] }
  }

  // As a page sends it: wrapped for the recipient and for the author.
  const say = async (from: ChatRole, to: ChatRole, text: string, card?: ChatCard) => {
    const rumor = buildEscrowMessage({ parties, sender: hx(KEYS[from]), recipient: hx(KEYS[to]), content: text, createdAt: ++at, card })
    for (const wrap of wrapForEach(rumor, KEYS[from], [hx(KEYS[to]), hx(KEYS[from])], at)) {
      expect((await publishToRelays([relay.url], wrap)).every((x) => x.ok)).toBe(true)
    }
  }
  // As a page reads them, signed in as its own escrow key.
  const chats = async (who: ChatRole) => {
    const sk = KEYS[who]
    const auth: RelayAuth = async (url, challenge) => signEvent(buildAuthEvent({ relay: url, challenge, pubkey: hx(sk), createdAt: NOW }), sk)
    const wraps = await queryRelays([relay.url], [giftWrapFilter(hx(sk))], { timeoutMs: 2000, auth })
    return escrowChats(readMessages(wraps, sk).messages, parties, hx(sk))
  }

  const outpoint = `${salt.slice(0, 2).repeat(32)}:0`
  const fee = settlementFee({ tree, settlement: { kind: 'refund', leaf: 'A', outpoint, dest: DEST_BUYER }, value: VALUE, network: 'signet', rate: 1 })
  const sign = (kind: 'release' | 'refund', leaf: 'A' | 'B' | 'C', dest: string, sk: Uint8Array): SignedSettlement =>
    signSettlement({ tree, settlement: { kind, leaf, outpoint, dest, fee }, value: VALUE, network: 'signet', secretKey: sk })
  const boardOf = (c: Awaited<ReturnType<typeof read>>['c'], ruling?: { settlement?: SignedSettlement }) => collectSettlements({
    tree, network: 'signet', outpoint, value: VALUE,
    sources: [
      { role: 'buyer', sigs: c.buyerView!.sigs },
      { role: 'seller', sigs: c.sellerView!.sigs },
      { role: 'arbiter', sigs: ruling?.settlement ? [ruling.settlement] : [] },
    ],
  })
  const rule = (state: Awaited<ReturnType<typeof read>>, tip: number) => {
    const s: EscrowView = state.c.sellerView!, b: EscrowView = state.c.buyerView!
    return arbiterRule({
      rules: RULES, fundingHeight: F, tip,
      seller: { sent: !!s.claims.sent, cancelled: !!s.claims.cancelled, disputed: !!s.claims.disputed },
      buyer: { received: !!b.claims.received, disputed: !!b.claims.disputed },
    })
  }
  // The arbiter co-signs a side's own payout and publishes it with the ruling.
  const ruleWith = async (state: Awaited<ReturnType<typeof read>>, decision: 'release' | 'refund', reason: string) => {
    const entry = proposalOf(boardOf(state.c), decision, decision === 'release' ? 'B' : 'C')!
    const mine = signSettlement({ tree, settlement: entry.settlement, value: VALUE, network: 'signet', secretKey: ARBITER })
    const ruling = signEvent(buildRuling({
      id, decision, reason, settlement: mine, parties: [hx(BUYER), hx(SELLER)], pubkey: hx(ARBITER), createdAt: ++at,
    }), ARBITER)
    expect((await publishToRelays([relay.url], ruling)).every((x) => x.ok)).toBe(true)
  }
  return { id, params, tree, publish, read, say, chats, sign, boardOf, rule, ruleWith }
}

test('a direct transfer from invite to confirmation and payout', async () => {
  const e = await open('ab'.repeat(32))
  let state = await e.read()
  expect(state.c.agreed).toBe(true)
  // The public views say nothing about where the domain goes.
  for (const v of [state.c.buyerView!, state.c.sellerView!]) expect(JSON.stringify(v.event)).not.toContain('buyer_77')

  await e.publish(BUYER, { sigs: [e.sign('refund', 'A', DEST_BUYER, BUYER), e.sign('refund', 'C', DEST_BUYER, BUYER)] })
  state = await e.read()
  expect(e.rule(state, F + 1)).toMatchObject({ action: 'wait', stage: 'awaiting-transfer' })
  expect(e.rule(state, F + RULES.deliverBlocks)).toMatchObject({ action: 'refund', stage: 'late' })

  await e.say('buyer', 'seller', 'Please transfer it to my Namecheap account.', TO)
  expect(latestCard((await e.chats('seller')).get('buyer')!, 'transfer-to')).toEqual(TO)

  await e.publish(SELLER, { claims: { sent: { at: ++at } }, sigs: [e.sign('release', 'A', DEST_SELLER, SELLER), e.sign('release', 'B', DEST_SELLER, SELLER)] })
  await e.say('seller', 'buyer', 'The code is in the card. Start the transfer at Namecheap.', CODE)
  state = await e.read()
  expect(e.rule(state, F + 1)).toMatchObject({ action: 'wait', stage: 'transferred' })
  // Once the seller says sent, the deadline no longer refunds.
  expect(e.rule(state, F + RULES.deliverBlocks + 5).stage).toBe('transferred')
  expect(latestCard((await e.chats('buyer')).get('seller')!, 'transfer-sent')).toEqual(CODE)

  // No copy of the buyer and seller's chat is even served to the arbiter's key.
  const arbiters = await e.chats('arbiter')
  expect(arbiters.get('buyer')).toEqual([])
  expect(arbiters.get('seller')).toEqual([])

  expect(e.boardOf(state.c).filter((x) => x.complete)).toEqual([])

  const releaseA = proposalOf(e.boardOf(state.c), 'release', 'A')!
  expect(releaseA.settlement.dest).toBe(DEST_SELLER)
  const cosign = signSettlement({ tree: e.tree, settlement: releaseA.settlement, value: VALUE, network: 'signet', secretKey: BUYER })
  await e.publish(BUYER, { claims: { received: { at: ++at } }, sigs: [...state.c.buyerView!.sigs, cosign] })
  state = await e.read()
  expect(e.rule(state, F + 5)).toMatchObject({ action: 'release', stage: 'received' })
  const complete = e.boardOf(state.c).filter((x) => x.complete)
  expect(complete.map((x) => `${x.settlement.kind}:${x.settlement.leaf}`)).toEqual(['release:A'])
  const tx = completeSettlement({ tree: e.tree, settlement: complete[0].settlement, value: VALUE, network: 'signet', signatures: complete[0].sigs })
  expect(tx.txid).toMatch(/^[0-9a-f]{64}$/)
})

test('a dispute the arbiter decides, talking to each side alone', async () => {
  const e = await open('cd'.repeat(32))
  await e.publish(BUYER, { sigs: [e.sign('refund', 'A', DEST_BUYER, BUYER), e.sign('refund', 'C', DEST_BUYER, BUYER)] })
  await e.publish(SELLER, { claims: { sent: { at: ++at } }, sigs: [e.sign('release', 'A', DEST_SELLER, SELLER), e.sign('release', 'B', DEST_SELLER, SELLER)] })

  await e.publish(BUYER, {
    claims: { disputed: { at: ++at, reason: 'nothing arrived' } },
    sigs: [e.sign('refund', 'A', DEST_BUYER, BUYER), e.sign('refund', 'C', DEST_BUYER, BUYER)],
  })
  let state = await e.read()
  expect(e.rule(state, F + 5)).toMatchObject({ action: 'decide', stage: 'disputed' })
  expect(e.rule(state, F + 5).reason).toContain('the buyer')
  // A dispute outranks the deadline and the seller's word alike.
  expect(e.rule(state, F + RULES.deliverBlocks + 1).action).toBe('decide')

  await e.say('arbiter', 'buyer', 'Send a read-only API key for your registrar account.')
  await e.say('arbiter', 'seller', 'Send a read-only API key, and when you pushed it.')
  await e.say('seller', 'arbiter', 'Key: READONLY-SELLER. I pushed it yesterday.')
  await e.say('buyer', 'arbiter', 'Key: READONLY-BUYER.')
  const buyers = await e.chats('buyer')
  expect(buyers.get('arbiter')!.map((m) => m.text)).toEqual(['Send a read-only API key for your registrar account.', 'Key: READONLY-BUYER.'])
  // Neither side reads what the other told the arbiter.
  expect(JSON.stringify([...buyers.values()])).not.toContain('READONLY-SELLER')
  expect(JSON.stringify([...(await e.chats('seller')).values()])).not.toContain('READONLY-BUYER')
  const arbiters = await e.chats('arbiter')
  expect(arbiters.get('seller')!.map((m) => m.from)).toEqual(['arbiter', 'seller'])

  await e.ruleWith(state, 'release', 'The read-only key shows lumenary.com in the buyer\'s account.')
  state = await e.read()
  expect(state.ruling?.decision).toBe('release')
  const complete = e.boardOf(state.c, state.ruling).filter((x) => x.complete)
  expect(complete.map((x) => `${x.settlement.kind}:${x.settlement.leaf}`)).toEqual(['release:B'])
  expect(complete[0].settlement.dest).toBe(DEST_SELLER)
})

test('a sale the seller cancels refunds the buyer at once', async () => {
  const e = await open('ef'.repeat(32))
  await e.publish(BUYER, { sigs: [e.sign('refund', 'A', DEST_BUYER, BUYER), e.sign('refund', 'C', DEST_BUYER, BUYER)] })
  let state = await e.read()
  const refundA = proposalOf(e.boardOf(state.c), 'refund', 'A')!
  const mine = signSettlement({ tree: e.tree, settlement: refundA.settlement, value: VALUE, network: 'signet', secretKey: SELLER })
  await e.publish(SELLER, { claims: { cancelled: { at: ++at, reason: 'sold it elsewhere' } }, sigs: [mine] })
  state = await e.read()
  expect(e.rule(state, F + 5)).toMatchObject({ action: 'refund', stage: 'cancelled' })
  const complete = e.boardOf(state.c).filter((x) => x.complete)
  expect(complete.map((x) => `${x.settlement.kind}:${x.settlement.leaf}`)).toEqual(['refund:A'])
  expect(complete[0].settlement.dest).toBe(DEST_BUYER)
})
