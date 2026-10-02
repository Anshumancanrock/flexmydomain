// Escrow handshake: the signed invite and reply strings (core/nostr/handshake.ts).

import { test, expect, describe } from 'bun:test'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  HANDSHAKE_KIND,
  INVITE_PREFIX,
  REPLY_PREFIX,
  buildEscrowEvent,
  buildInvite,
  buildReply,
  compareViews,
  decodeInvite,
  decodeReply,
  deriveEscrowId,
  encodeInvite,
  encodeReply,
  escrowAddress,
  parseEscrowEvent,
  resolveHandshake,
  signEvent,
  termsProblem,
  type Invite,
  type Reply,
  type SignedInvite,
} from '../../core/nostr/index.ts'
import { SITE_RULES } from '../../core/escrow/index.ts'

const AUX = new Uint8Array(32)
const BUYER_ESCROW_SK = new Uint8Array(32).fill(0x11)
const SELLER_ESCROW_SK = new Uint8Array(32).fill(0x22)
const ARBITER_SK = new Uint8Array(32).fill(0x33)
const hexKey = (sk: Uint8Array) => bytesToHex(schnorr.getPublicKey(sk))
const key = (fill: number) => hexKey(new Uint8Array(32).fill(fill))
const BUYER_KEY = hexKey(BUYER_ESCROW_SK)
const SELLER_KEY = hexKey(SELLER_ESCROW_SK)
const ARBITER_KEY = hexKey(ARBITER_SK)
const SALT = 'ab'.repeat(32)
const NOW = 1_789_430_400
const RULES = SITE_RULES.signet

// Nostr identities, which sign the messages. The escrow keys above only go in the tree.
const BUYER_NOSTR_SK = new Uint8Array(32).fill(0x51)
const SELLER_NOSTR_SK = new Uint8Array(32).fill(0x52)
const MALLORY_NOSTR_SK = new Uint8Array(32).fill(0x53)
const nostr = (sk: Uint8Array) => bytesToHex(schnorr.getPublicKey(sk))

const fromBuyer: Invite = {
  salt: SALT,
  domain: 'lumenary.com',
  amountSats: 2_500_000,
  network: 'signet',
  timeoutBlocks: RULES.timeoutBlocks,
  deliverBlocks: RULES.deliverBlocks,
  arbiter: ARBITER_KEY,
  initiatorRole: 'buyer',
  initiatorKey: BUYER_KEY,
  to: nostr(SELLER_NOSTR_SK),
}

const fromSeller: Invite = {
  ...fromBuyer,
  initiatorRole: 'seller',
  initiatorKey: SELLER_KEY,
  to: nostr(BUYER_NOSTR_SK),
}
const SELLER_JOINS: Reply = { joinerKey: SELLER_KEY }
const BUYER_JOINS: Reply = { joinerKey: BUYER_KEY }

function inviteText(invite: Invite, sk: Uint8Array, createdAt = NOW): string {
  return encodeInvite(signEvent(buildInvite(invite, { pubkey: nostr(sk), createdAt }), sk, AUX))
}

function opened(text: string): SignedInvite {
  const r = decodeInvite(text)
  if (!r.ok) throw new Error(r.reason)
  return r
}

function replyText(reply: Reply, sk: Uint8Array, signed: SignedInvite): string {
  return encodeReply(signEvent(buildReply(reply, { pubkey: nostr(sk), createdAt: NOW + 60, invite: signed }), sk, AUX))
}

// The signed event inside an invite or reply string.
const eventOf = (text: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(
  atob(text.slice(7).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))))

function inputs(invite: Invite, reply: ReturnType<typeof decodeReply>) {
  if (!reply.ok) throw new Error(reply.reason)
  const r = resolveHandshake(invite, reply.reply)
  const params = {
    salt: r.salt,
    buyer: hexToBytes(r.buyerKey),
    seller: hexToBytes(r.sellerKey),
    arbiter: hexToBytes(r.arbiter),
    timeoutBlocks: r.timeoutBlocks,
    deliverBlocks: r.deliverBlocks,
    network: r.network,
    amountSats: r.amountSats,
    domain: r.domain,
  }
  return { id: deriveEscrowId(params), address: escrowAddress(params), resolved: r, params }
}

describe('the round trip', () => {
  test('an invite survives encoding exactly, with its signer', () => {
    const text = inviteText(fromBuyer, BUYER_NOSTR_SK)
    expect(text.startsWith(INVITE_PREFIX)).toBe(true)
    const back = decodeInvite(text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.invite).toEqual(fromBuyer)
    expect(back.from).toBe(nostr(BUYER_NOSTR_SK))
    expect(back.id).toMatch(/^[0-9a-f]{64}$/)
  })

  test('whitespace and line breaks from a chat paste are tolerated', () => {
    const text = inviteText(fromBuyer, BUYER_NOSTR_SK)
    const mangled = `  ${text.slice(0, 20)}\n${text.slice(20, 50)} ${text.slice(50)}  `
    expect(decodeInvite(mangled).ok).toBe(true)
  })

  test('a reply survives encoding exactly', () => {
    const signed = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    const text = replyText(SELLER_JOINS, SELLER_NOSTR_SK, signed)
    expect(text.startsWith(REPLY_PREFIX)).toBe(true)
    const back = decodeReply(text, signed)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.reply).toEqual(SELLER_JOINS)
    expect(back.from).toBe(nostr(SELLER_NOSTR_SK))
  })

  test('both are handshake events, which no relay keeps', () => {
    const invite = buildInvite(fromBuyer, { pubkey: nostr(BUYER_NOSTR_SK), createdAt: NOW })
    expect(invite.kind).toBe(HANDSHAKE_KIND)
    expect(HANDSHAKE_KIND).toBeGreaterThanOrEqual(20000)
    expect(HANDSHAKE_KIND).toBeLessThan(30000)
  })

  test('each message carries the terms and one escrow key, and nothing about any account', () => {
    const toSeller = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    expect(Object.keys(JSON.parse(eventOf(inviteText(fromBuyer, BUYER_NOSTR_SK)).content)).sort()).toEqual([
      'amountSats', 'arbiter', 'deliverBlocks', 'domain', 'initiatorKey', 'initiatorRole', 'network', 'salt', 'timeoutBlocks', 'to', 'v',
    ])
    expect(Object.keys(JSON.parse(eventOf(replyText(SELLER_JOINS, SELLER_NOSTR_SK, toSeller)).content)).sort()).toEqual(['invite', 'joinerKey', 'v'])
  })

  test('fields an earlier invite carried are not carried on', () => {
    const old = { ...fromBuyer, custodyAccount: 'fmd-arbiter', forwardBlocks: 12, deliverTo: 'ab'.repeat(32) } as Invite
    const content = JSON.parse(eventOf(inviteText(old, BUYER_NOSTR_SK)).content)
    for (const gone of ['custodyAccount', 'forwardBlocks', 'deliverTo', 'returnTo']) expect(content[gone]).toBeUndefined()
    expect(opened(inviteText(old, BUYER_NOSTR_SK)).invite).toEqual(fromBuyer)
  })
})

describe('both sides derive the same escrow', () => {
  test('buyer invites, seller joins: identical address and id', () => {
    const signed = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    const text = replyText(SELLER_JOINS, SELLER_NOSTR_SK, signed)

    const onInitiatorsPage = inputs(fromBuyer, decodeReply(text, signed))
    const onJoinersPage = inputs(signed.invite, decodeReply(text, signed))

    expect(onInitiatorsPage.address).toBe(onJoinersPage.address)
    expect(onInitiatorsPage.id).toBe(onJoinersPage.id)
    expect(onInitiatorsPage.resolved).toMatchObject({ buyerKey: BUYER_KEY, sellerKey: SELLER_KEY, arbiter: ARBITER_KEY })
  })

  test('seller invites, buyer joins: each key lands on its own side', () => {
    const signed = opened(inviteText(fromSeller, SELLER_NOSTR_SK))
    const reply = decodeReply(replyText(BUYER_JOINS, BUYER_NOSTR_SK, signed), signed)
    const r = inputs(signed.invite, reply)
    expect(r.resolved).toMatchObject({ buyerKey: BUYER_KEY, sellerKey: SELLER_KEY })
  })

  test('either way round gives the same escrow for the same keys, salt and terms', () => {
    const a = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    const b = opened(inviteText(fromSeller, SELLER_NOSTR_SK))
    const one = inputs(a.invite, decodeReply(replyText(SELLER_JOINS, SELLER_NOSTR_SK, a), a))
    const two = inputs(b.invite, decodeReply(replyText(BUYER_JOINS, BUYER_NOSTR_SK, b), b))
    expect(one.id).toBe(two.id)
  })

})

describe('what must not work', () => {
  test('a reply from someone other than the invited key is refused', () => {
    const signed = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    const forged = encodeReply(signEvent(
      { ...buildReply({ joinerKey: key(0x66) }, { pubkey: nostr(SELLER_NOSTR_SK), createdAt: NOW, invite: signed }),
        pubkey: nostr(MALLORY_NOSTR_SK) },
      MALLORY_NOSTR_SK,
      AUX,
    ))
    const r = decodeReply(forged, signed)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('someone other than')
    expect(() => buildReply({ joinerKey: key(0x66) }, { pubkey: nostr(MALLORY_NOSTR_SK), createdAt: NOW, invite: signed }))
      .toThrow(/different key/)
  })

  test('a reply to an earlier invite with other terms is refused', () => {
    const first = opened(inviteText(fromBuyer, BUYER_NOSTR_SK, NOW))
    const second = opened(inviteText({ ...fromBuyer, amountSats: 3_000_000 }, BUYER_NOSTR_SK, NOW + 5))
    expect(second.invite.salt).toBe(first.invite.salt) // Same draft, same salt.
    const r = decodeReply(replyText(SELLER_JOINS, SELLER_NOSTR_SK, first), second)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('different invite')
  })

  test('an invite whose terms were edited after signing is refused', () => {
    const event = eventOf(inviteText(fromBuyer, BUYER_NOSTR_SK))
    for (const edit of [
      (b: Record<string, unknown>) => { b.amountSats = 1 },
      (b: Record<string, unknown>) => { b.arbiter = key(0x66) },
    ]) {
      const body = JSON.parse(event.content)
      edit(body)
      const edited = INVITE_PREFIX + btoa(JSON.stringify({ ...event, content: JSON.stringify(body) }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const r = decodeInvite(edited)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('signature')
    }
  })

  test('a reply carrying your own key back, or the arbiter key, is refused', () => {
    const signed = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    expect(() => replyText({ joinerKey: BUYER_KEY }, SELLER_NOSTR_SK, signed)).toThrow(/your own key/)
    expect(() => replyText({ joinerKey: ARBITER_KEY }, SELLER_NOSTR_SK, signed)).toThrow(/arbiter key/)
  })

  test('every invite names an arbiter, distinct from the initiator', () => {
    const { arbiter: _a, ...none } = fromBuyer
    expect(() => buildInvite(none as Invite, { pubkey: nostr(BUYER_NOSTR_SK), createdAt: NOW })).toThrow(/arbiter/)
    expect(() => buildInvite({ ...fromBuyer, arbiter: BUYER_KEY }, { pubkey: nostr(BUYER_NOSTR_SK), createdAt: NOW })).toThrow(/arbiter/)
  })

  test('windows that leave the arbiter no time before the timelock are refused when the invite is made', () => {
    expect(() => buildInvite({ ...fromBuyer, deliverBlocks: RULES.timeoutBlocks - 71 }, { pubkey: nostr(BUYER_NOSTR_SK), createdAt: NOW }))
      .toThrow(/outrun/)
    expect(() => buildInvite({ ...fromBuyer, deliverBlocks: RULES.timeoutBlocks - 72 }, { pubkey: nostr(BUYER_NOSTR_SK), createdAt: NOW }))
      .not.toThrow()
  })

  test('an invite to yourself is refused', () => {
    expect(() => buildInvite({ ...fromBuyer, to: nostr(BUYER_NOSTR_SK) }, { pubkey: nostr(BUYER_NOSTR_SK), createdAt: NOW }))
      .toThrow(/own sender/)
  })

  test('malformed input returns a reason instead of throwing', () => {
    for (const bad of ['', 'nope', `${INVITE_PREFIX}!!!`, `${INVITE_PREFIX}e30`, 42, null]) {
      expect(decodeInvite(bad).ok).toBe(false)
    }
  })

  test('an invite from an older version is refused with a reason', () => {
    for (const old of ['fmdinv4abc', 'fmdinv3abc', 'fmdinv2abc', 'fmdinv1abc', 'fmdrep4abc', 'fmdrep3abc', 'fmdrep2abc']) {
      const r = decodeInvite(old)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/older version/)
    }
  })

  test('a reply pasted where an invite belongs is refused', () => {
    const signed = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
    expect(decodeInvite(replyText(SELLER_JOINS, SELLER_NOSTR_SK, signed)).ok).toBe(false)
  })

  test('nothing in either message is a private key', () => {
    const invite = JSON.stringify(decodeInvite(inviteText(fromBuyer, BUYER_NOSTR_SK)))
    expect(invite).not.toMatch(/secret|private|nsec/i)
    for (const sk of [BUYER_ESCROW_SK, SELLER_ESCROW_SK, BUYER_NOSTR_SK]) expect(invite).not.toContain(bytesToHex(sk))
  })
})

describe('the terms this site accepts', () => {
  const terms = { arbiter: ARBITER_KEY, ...RULES }

  test("the site's own timelock and transfer window, with an arbiter", () => {
    expect(termsProblem(terms, RULES)).toBeUndefined()
    expect(termsProblem({ ...terms, arbiter: undefined }, RULES)).toContain('arbiter')
    expect(termsProblem({ ...terms, timeoutBlocks: 1 }, RULES)).toContain(String(RULES.timeoutBlocks))
    expect(termsProblem({ ...terms, deliverBlocks: 1 }, RULES)).toContain('transfer window')
  })

  test('the same terms as an escrow view states them pass too', () => {
    expect(termsProblem({ arbiter: ARBITER_KEY, timeoutBlocks: RULES.timeoutBlocks, deliverBlocks: RULES.deliverBlocks }, RULES)).toBeUndefined()
  })
})

describe('the published views, as the page makes them', () => {
  // The page signs views with the per-trade escrow key, and compareViews admits only tree keys.
  const signed = opened(inviteText(fromBuyer, BUYER_NOSTR_SK))
  const { id, params } = inputs(fromBuyer, decodeReply(replyText(SELLER_JOINS, SELLER_NOSTR_SK, signed), signed))

  const viewSignedBy = (sk: Uint8Array, createdAt: number) => {
    const event = signEvent(buildEscrowEvent({ ...params, pubkey: hexKey(sk), createdAt }), sk)
    const parsed = parseEscrowEvent(event)
    if (!parsed.ok) throw new Error(parsed.reason)
    return parsed.view
  }

  test('views signed by the escrow keys are both participants, and agree', () => {
    const comparison = compareViews([viewSignedBy(BUYER_ESCROW_SK, 1_000), viewSignedBy(SELLER_ESCROW_SK, 1_001)], id)
    expect(comparison.participants).toHaveLength(2)
    expect(comparison.strangers).toHaveLength(0)
    expect(comparison.agreed).toBe(true)
  })

  test('views signed by the Nostr identities count only as strangers', () => {
    const comparison = compareViews([viewSignedBy(BUYER_NOSTR_SK, 1_000), viewSignedBy(SELLER_NOSTR_SK, 1_001)], id)
    expect(comparison.participants).toHaveLength(0)
    expect(comparison.strangers).toHaveLength(2)
    expect(comparison.buyerView).toBeUndefined()
  })
})
