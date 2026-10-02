// Escrow views and rulings, version 5 (core/nostr/escrow.ts).

import { test, expect, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  ESCROW_D_PREFIX,
  ESCROW_KIND,
  ESCROW_TOPIC,
  ESCROW_VERSION,
  RULING_D_PREFIX,
  buildEscrowEvent,
  buildRuling,
  compareViews,
  deriveEscrowId,
  escrowAddress,
  escrowFilters,
  escrowsForFilter,
  parseEscrowEvent,
  parseRuling,
  signEvent,
  type EscrowClaims,
  type EscrowParams,
  type EscrowView,
  type NostrEvent,
} from '../../core/nostr/index.ts'
import { buildTree, type SignedSettlement } from '../../core/escrow/index.ts'

const AUX = new Uint8Array(32)
const secret = (f: number) => new Uint8Array(32).fill(f)
const x = (sk: Uint8Array) => schnorr.getPublicKey(sk)
const hx = (sk: Uint8Array) => bytesToHex(x(sk))

const BUYER = secret(0x11)
const SELLER = secret(0x22)
const ARBITER = secret(0x33)
const MALLORY = secret(0x44)

const SALT = 'ab'.repeat(32)
const NOW = 1789430400

const PARAMS: EscrowParams = {
  salt: SALT,
  buyer: x(BUYER),
  seller: x(SELLER),
  arbiter: x(ARBITER),
  timeoutBlocks: 144,
  deliverBlocks: 12,
  network: 'signet',
  amountSats: 2_500_000,
  domain: 'lumenary.com',
}
const ID = deriveEscrowId(PARAMS)

// Pinned: sha256 over the v5 preimage of PARAMS, and the signet address bound to it.
const PINNED_ID = 'fd184b97e40625e1c7452fe087ffd613701ba9d6355c1a6b700fe37e97c2c871'
const PINNED_ADDRESS = 'tb1pxzxaqgfaarkv763cpr5rwfgnnj4kasa3gmcnq28ywf450470qe6qhv7923'

// Fields the v4 custody flow had and v5 dropped.
const GONE = ['registrar', 'custody_account', 'deliver_to', 'return_to', 'deliver_to_enc', 'return_to_enc', 'forward_blocks']

const OUTPOINT = `${'cd'.repeat(32)}:0`
const sig = (over: Partial<SignedSettlement> = {}): SignedSettlement => ({
  kind: 'release', leaf: 'A', outpoint: OUTPOINT, dest: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', fee: 200, sig: 'ee'.repeat(64), ...over,
})

function viewBy(sk: Uint8Array, over: Partial<EscrowParams> & { claims?: EscrowClaims; sigs?: SignedSettlement[] } = {}, createdAt = NOW): NostrEvent {
  return signEvent(buildEscrowEvent({ ...PARAMS, ...over, pubkey: hx(sk), createdAt }), sk, AUX)
}

const parsed = (event: NostrEvent): EscrowView => {
  const r = parseEscrowEvent(event)
  if (!r.ok) throw new Error(r.reason)
  return r.view
}

function edited(event: NostrEvent, sk: Uint8Array, edit: (body: Record<string, unknown>) => void): NostrEvent {
  const body = JSON.parse(event.content)
  edit(body)
  const { id: _id, sig: _sig, ...unsigned } = event
  return signEvent({ ...unsigned, content: JSON.stringify(body) }, sk, AUX)
}

function retagged(event: NostrEvent, sk: Uint8Array, tags: string[][]): NostrEvent {
  const { id: _id, sig: _sig, ...unsigned } = event
  return signEvent({ ...unsigned, tags }, sk, AUX)
}

const refusal = (event: NostrEvent): string => {
  const r = parseEscrowEvent(event)
  if (r.ok) throw new Error('expected a refusal')
  return r.reason
}

describe('the event', () => {
  test('it is kind 30078 at a derived coordinate, on our topic, tagging every party', () => {
    const event = viewBy(SELLER)
    expect(event.kind).toBe(ESCROW_KIND)
    expect(event.tags).toEqual([
      ['d', ESCROW_D_PREFIX + ID],
      ['t', ESCROW_TOPIC],
      ['fmd_domain', 'lumenary.com'],
      ['p', hx(BUYER)],
      ['p', hx(SELLER)],
      ['p', hx(ARBITER)],
    ])
    expect(ESCROW_VERSION).toBe(5)
    expect(JSON.parse(event.content).v).toBe(5)
  })

  test('its content is the agreed terms and nothing about where the domain goes', () => {
    const body = JSON.parse(viewBy(BUYER).content)
    expect(Object.keys(body).sort()).toEqual([
      'address', 'amount_sats', 'arbiter_x', 'buyer_x', 'deliver_blocks', 'domain', 'id', 'network', 'salt',
      'seller_x', 'timeout_blocks', 'timeout_to', 'v',
    ])
    expect(body).toMatchObject({
      v: 5, id: ID, salt: SALT, buyer_x: hx(BUYER), seller_x: hx(SELLER), arbiter_x: hx(ARBITER), timeout_to: 'buyer',
      timeout_blocks: 144, deliver_blocks: 12, network: 'signet', address: PINNED_ADDRESS, amount_sats: 2_500_000, domain: 'lumenary.com',
    })
  })

  test("the builder writes none of the custody flow's fields, even handed them", () => {
    const old = { custodyAccount: 'fmd-arbiter', forwardBlocks: 12, deliverTo: 'ab'.repeat(32), returnTo: 'cd'.repeat(32), registrar: 'spaceship' }
    for (const sk of [BUYER, SELLER]) {
      const event = signEvent(buildEscrowEvent({ ...PARAMS, ...old, pubkey: hx(sk), createdAt: NOW } as never), sk, AUX)
      const body = JSON.parse(event.content)
      for (const field of GONE) expect(body).not.toHaveProperty(field)
      expect(event.content).not.toContain('fmd-arbiter')
      expect(parsed(event).id).toBe(ID)
    }
  })

  test('every party derives the same id without coordinating, and it is the whole sha256', () => {
    expect(ID).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed(viewBy(BUYER)).id).toBe(ID)
    expect(parsed(viewBy(SELLER)).id).toBe(ID)
    expect(parsed(viewBy(ARBITER)).id).toBe(ID)
  })

  test('the id is sha256 over the documented v5 preimage, recomputed independently, and pinned', () => {
    const preimage = Buffer.concat([
      Buffer.from('fmd:escrow:v5'),
      Buffer.from(SALT, 'hex'),
      Buffer.from(x(BUYER)),
      Buffer.from(x(SELLER)),
      Buffer.from(x(ARBITER)),
      Buffer.from('buyer:144:12:signet:2500000:lumenary.com:'),
    ])
    expect(ID).toBe(createHash('sha256').update(preimage).digest('hex'))
    expect(ID).toBe(PINNED_ID)
    expect(escrowAddress(PARAMS)).toBe(PINNED_ADDRESS)
  })

  test('every term moves the id, and each change lands somewhere else', () => {
    const variants: Partial<EscrowParams>[] = [
      { salt: 'cd'.repeat(32) },
      { amountSats: 2_500_001 },
      { domain: 'other.com' },
      { network: 'testnet' },
      { network: 'mainnet' },
      { timeoutBlocks: 145 },
      { deliverBlocks: 13 },
      // Timelock and window swapped: each has its own place in the preimage.
      { timeoutBlocks: 12, deliverBlocks: 144 },
      { buyer: x(MALLORY) },
      { seller: x(MALLORY) },
      { arbiter: x(MALLORY) },
      // The two parties swapped: each key has its own slot.
      { buyer: x(SELLER), seller: x(BUYER) },
    ]
    const ids = variants.map((v) => deriveEscrowId({ ...PARAMS, ...v }))
    for (const id of ids) expect(id).not.toBe(ID)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('terms the view does not cover leave the id alone', () => {
    expect(deriveEscrowId({ ...PARAMS, listing: 'naddr1test', deadlines: { fundBy: NOW } })).toBe(ID)
  })

  test('the domain is hashed in its normal form, so any spelling of it is the same escrow', () => {
    for (const domain of ['LUMENARY.com', 'www.lumenary.com', 'lumenary.com.', 'https://lumenary.com/path']) {
      expect(deriveEscrowId({ ...PARAMS, domain })).toBe(ID)
    }
    expect(JSON.parse(viewBy(SELLER, { domain: 'WWW.Lumenary.COM' }).content).domain).toBe('lumenary.com')
  })

  test('a malformed salt or domain is refused before anything is hashed', () => {
    for (const salt of ['AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), '']) {
      expect(() => deriveEscrowId({ ...PARAMS, salt })).toThrow(/salt must be 64 lowercase hex/)
    }
    expect(() => deriveEscrowId({ ...PARAMS, domain: 'not a domain' })).toThrow(/not a domain/)
  })

  test('the stated address is the one the keys and the id produce, with the timeout refunding the buyer', () => {
    const keys = { buyer: x(BUYER), seller: x(SELLER), arbiter: x(ARBITER), timeoutTo: 'buyer' as const, timeoutBlocks: 144 }
    const tree = buildTree({ ...keys, binding: hexToBytes(ID) })
    expect(escrowAddress(PARAMS)).toBe(tree.addresses.signet)
    expect(parsed(viewBy(SELLER)).address).toBe(tree.addresses.signet)
    // Not the address the same keys give unbound, which every escrow between them would share.
    expect(escrowAddress(PARAMS)).not.toBe(buildTree(keys).addresses.signet)
    // The transfer window is in the id, so it moves the address too, though no script uses it.
    expect(escrowAddress({ ...PARAMS, deliverBlocks: 13 })).not.toBe(escrowAddress(PARAMS))
  })

  test('it round-trips every field, and names who signed it', () => {
    const event = viewBy(BUYER, { deadlines: { fundBy: NOW + 86400 }, listing: 'naddr1test' })
    const view = parsed(event)
    expect(view).toEqual({
      version: 5,
      id: ID,
      author: hx(BUYER),
      role: 'buyer',
      salt: SALT,
      buyer: hx(BUYER),
      seller: hx(SELLER),
      arbiter: hx(ARBITER),
      timeoutTo: 'buyer',
      timeoutBlocks: 144,
      deliverBlocks: 12,
      network: 'signet',
      address: PINNED_ADDRESS,
      amountSats: 2_500_000,
      domain: 'lumenary.com',
      listing: 'naddr1test',
      deadlines: { fundBy: NOW + 86400 },
      claims: {},
      sigs: [],
      publishedAt: NOW,
      event,
    })
    expect(event.tags).toContainEqual(['a', 'naddr1test'])
    expect(parsed(viewBy(SELLER)).role).toBe('seller')
    expect(parsed(viewBy(ARBITER)).role).toBe('arbiter')
    expect(parsed(viewBy(MALLORY)).role).toBeUndefined()
    expect(parsed(viewBy(SELLER)).deadlines).toEqual({ fundBy: undefined })
  })

  test('claims and signatures round-trip, for each side', () => {
    const seller = parsed(viewBy(SELLER, { claims: { sent: { at: NOW } }, sigs: [sig(), sig({ leaf: 'B' })] }))
    expect(seller.claims).toEqual({ sent: { at: NOW } })
    expect(seller.sigs).toEqual([sig(), sig({ leaf: 'B' })])

    const cancelled = parsed(viewBy(SELLER, { claims: { sent: { at: NOW }, cancelled: { at: NOW + 1, reason: 'changed my mind' } } }))
    expect(cancelled.claims).toEqual({ sent: { at: NOW }, cancelled: { at: NOW + 1, reason: 'changed my mind' } })

    const sellerDispute = parsed(viewBy(SELLER, { claims: { sent: { at: NOW }, disputed: { at: NOW + 2, reason: 'the buyer has it and will not confirm' } } }))
    expect(sellerDispute.claims.disputed).toEqual({ at: NOW + 2, reason: 'the buyer has it and will not confirm' })

    const buyer = parsed(viewBy(BUYER, { claims: { received: { at: NOW } }, sigs: [sig({ kind: 'refund', leaf: 'A' }), sig({ kind: 'refund', leaf: 'C' })] }))
    expect(buyer.claims).toEqual({ received: { at: NOW } })
    expect(buyer.sigs.map((s) => `${s.kind}:${s.leaf}`)).toEqual(['refund:A', 'refund:C'])

    const buyerDispute = parsed(viewBy(BUYER, { claims: { disputed: { at: NOW, reason: 'nothing arrived' } } }))
    expect(buyerDispute.claims).toEqual({ disputed: { at: NOW, reason: 'nothing arrived' } })
  })

  test('a cancellation or dispute stated without a reason reads as an empty one', () => {
    expect(parsed(edited(viewBy(BUYER), BUYER, (b) => { b.disputed = { at: NOW } })).claims.disputed).toEqual({ at: NOW, reason: '' })
    expect(parsed(edited(viewBy(SELLER), SELLER, (b) => { b.cancelled = { at: NOW, reason: null } })).claims.cancelled).toEqual({ at: NOW, reason: '' })
  })

  test('fields a claim or a signature does not define are dropped, not carried', () => {
    const view = parsed(edited(viewBy(SELLER, { sigs: [sig()] }), SELLER, (b) => {
      b.sent = { at: NOW, reason: 'extra', where: 'buyer_77' }
      ;(b.sigs as Record<string, unknown>[])[0].note = '<script>'
    }))
    expect(view.claims).toEqual({ sent: { at: NOW } })
    expect(view.sigs).toEqual([sig()])
  })
})

describe('what must not work', () => {
  test('an address that its own keys do not produce is refused', () => {
    const forged = edited(viewBy(MALLORY), MALLORY, (b) => {
      b.address = escrowAddress({ ...PARAMS, seller: x(MALLORY) })
    })
    const reason = refusal(forged)
    expect(reason).toMatch(/is not the one these terms produce/)
    expect(reason).toMatch(/do not fund it/)
  })

  test('the address the keys give without the id binding is refused', () => {
    const unbound = buildTree({ buyer: x(BUYER), seller: x(SELLER), arbiter: x(ARBITER), timeoutTo: 'buyer', timeoutBlocks: 144 })
    const reason = refusal(edited(viewBy(BUYER), BUYER, (b) => { b.address = unbound.addresses.signet }))
    expect(reason).toMatch(/do not fund it/)
    // Views made before the binding state this address, so the reason points to recover.html.
    expect(reason).toMatch(/older version of the page/)
    expect(reason).toMatch(/recover\.html/)
  })

  test('another salt with the same keys is another escrow at another address', () => {
    const sibling = { ...PARAMS, salt: 'cd'.repeat(32) }
    expect(deriveEscrowId(sibling)).not.toBe(ID)
    expect(escrowAddress(sibling)).not.toBe(escrowAddress(PARAMS))
  })

  test('changing any term without changing the d tag is refused', () => {
    const edits: ((b: Record<string, unknown>) => void)[] = [
      (b) => { b.amount_sats = 1 },
      (b) => { b.domain = 'other.com' },
      (b) => { b.deliver_blocks = 100 },
      (b) => { b.timeout_blocks = 4320 },
      (b) => { b.network = 'testnet' },
      (b) => { b.salt = 'cd'.repeat(32) },
      (b) => { [b.buyer_x, b.seller_x] = [b.seller_x, b.buyer_x] },
      (b) => { b.arbiter_x = hx(MALLORY) },
    ]
    for (const edit of edits) expect(refusal(edited(viewBy(SELLER), SELLER, edit))).toMatch(/d tag does not match the id/)
  })

  test("a version 5 view carrying any of the custody flow's fields is refused, not read past", () => {
    const values: Record<string, unknown> = {
      registrar: 'spaceship', custody_account: 'fmd-arbiter', deliver_to: 'ab'.repeat(32), return_to: 'cd'.repeat(32),
      deliver_to_enc: 'AAAA', return_to_enc: 'AAAA', forward_blocks: 12,
    }
    for (const field of GONE) {
      for (const sk of [BUYER, SELLER]) {
        expect(refusal(edited(viewBy(sk), sk, (b) => { b[field] = values[field] }))).toBe(`"${field}" is not part of a version 5 escrow`)
      }
      // Present at all is enough, even empty.
      expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b[field] = null }))).toMatch(/is not part of a version 5 escrow/)
    }
  })

  test("a view from the custody flow (v4) is refused, and the reason says why", () => {
    const v4 = edited(viewBy(SELLER), SELLER, (b) => {
      b.v = 4
      b.registrar = 'spaceship'
      b.custody_account = 'fmd-arbiter'
      b.forward_blocks = 12
      b.deliver_to = 'ab'.repeat(32)
      b.return_to = 'cd'.repeat(32)
    })
    const reason = refusal(v4)
    expect(reason).toMatch(/opened with the earlier flow, where the arbiter held the domain/)
    expect(reason).toMatch(/no longer runs it/)
  })

  test('older versions, and versions this page does not know, are refused with a reason', () => {
    for (const v of [1, 2, 3]) {
      expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.v = v }))).toBe(
        `this view uses the version ${v} format, from an earlier version of the escrow; open a new escrow`,
      )
    }
    for (const v of [6, 0, '5', null]) {
      expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.v = v }))).toMatch(/^unsupported view version/)
    }
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { delete b.v }))).toBe('unsupported view version null')
  })

  test("the earlier versions' claims are refused, not ignored", () => {
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.pushed = { at: NOW } }))).toMatch(/"pushed" is not a claim/)
    expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.dispute = { at: NOW, reason: 'x' } }))).toMatch(/"dispute" is not a claim/)
  })

  test('a view must have exactly one d tag, in our namespace', () => {
    const event = viewBy(SELLER)
    expect(refusal(retagged(event, SELLER, [...event.tags, ['d', ESCROW_D_PREFIX + 'ff'.repeat(32)]]))).toMatch(/exactly one d tag/)
    expect(refusal(retagged(event, SELLER, event.tags.filter((t) => t[0] !== 'd')))).toMatch(/exactly one d tag/)
    const elsewhere = event.tags.map((t) => (t[0] === 'd' ? ['d', RULING_D_PREFIX + ID] : t))
    expect(refusal(retagged(event, SELLER, elsewhere))).toMatch(/is not a fmd:escrow:\* identifier/)
    const other = event.tags.map((t) => (t[0] === 'd' ? ['d', ESCROW_D_PREFIX + 'ff'.repeat(32)] : t))
    expect(refusal(retagged(event, SELLER, other))).toMatch(/d tag does not match the id these parameters derive/)
  })

  test('each term is checked for what it is', () => {
    const cases: [(b: Record<string, unknown>) => void, string | RegExp][] = [
      [(b) => { b.salt = 'AB'.repeat(32) }, 'no salt'],
      [(b) => { delete b.salt }, 'no salt'],
      [(b) => { b.buyer_x = 'zz' }, 'buyer or seller key is malformed'],
      [(b) => { b.seller_x = hx(SELLER).toUpperCase() }, 'buyer or seller key is malformed'],
      [(b) => { b.arbiter_x = null }, 'no arbiter key, and this escrow needs one'],
      [(b) => { b.timeout_to = 'seller' }, 'the timeout must refund the buyer'],
      [(b) => { delete b.timeout_to }, 'the timeout must refund the buyer'],
      [(b) => { b.timeout_blocks = 0 }, 'timeout_blocks is out of range'],
      [(b) => { b.timeout_blocks = 65536 }, 'timeout_blocks is out of range'],
      [(b) => { b.timeout_blocks = '144' }, 'timeout_blocks is out of range'],
      [(b) => { b.deliver_blocks = 0 }, 'the transfer window is out of range'],
      [(b) => { b.deliver_blocks = 65536 }, 'the transfer window is out of range'],
      [(b) => { b.deliver_blocks = 1.5 }, 'the transfer window is out of range'],
      [(b) => { delete b.deliver_blocks }, 'the transfer window is out of range'],
      [(b) => { b.network = 'bitcoin' }, 'unknown network "bitcoin"'],
      [(b) => { delete b.address }, 'no address'],
      [(b) => { b.amount_sats = 0 }, 'no amount'],
      [(b) => { b.amount_sats = -5 }, 'no amount'],
      [(b) => { b.amount_sats = '2500000' }, 'no amount'],
      [(b) => { b.domain = 'not a domain' }, /^domain: /],
      [(b) => { b.domain = 42 }, /^domain: /],
    ]
    for (const [edit, reason] of cases) {
      const got = refusal(edited(viewBy(SELLER), SELLER, edit))
      if (typeof reason === 'string') expect(got).toBe(reason)
      else expect(got).toMatch(reason)
    }
  })

  test('the builder refuses what the reader would', () => {
    const build = (over: Record<string, unknown>) => () => buildEscrowEvent({ ...PARAMS, pubkey: hx(SELLER), createdAt: NOW, ...over } as never)
    expect(build({ pubkey: 'nope' })).toThrow(/pubkey must be 64 lowercase hex/)
    for (const amountSats of [0, -1, 1.5]) expect(build({ amountSats })).toThrow(/amountSats must be a positive integer/)
    for (const deliverBlocks of [0, 65536, 1.5]) expect(build({ deliverBlocks })).toThrow(/deliverBlocks must be 1\.\.65535/)
    expect(build({ timeoutBlocks: 0 })).toThrow(/timeoutBlocks/)
    expect(build({ salt: 'xy' })).toThrow(/salt/)
    expect(build({ domain: 'not a domain' })).toThrow(/not a domain/)
  })

  test('a claim time no date can show is refused, so it cannot break a reader', () => {
    for (const at of [0x1_0000_0000, 8_640_000_000_001, Number.MAX_SAFE_INTEGER]) {
      expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.received = { at } }))).toMatch(/out of range/)
      expect(() => viewBy(BUYER, { claims: { received: { at } } })).toThrow(/out of range/)
    }
    expect(parseEscrowEvent(edited(viewBy(BUYER), BUYER, (b) => { b.received = { at: 0xffffffff } })).ok).toBe(true)
    expect(parseEscrowEvent(edited(viewBy(BUYER), BUYER, (b) => { b.received = { at: 0 } })).ok).toBe(true)
  })

  test('a claim without a whole, non-negative time is refused', () => {
    for (const at of [-1, 1.5, '1789430400', null, undefined]) {
      expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.sent = { at } }))).toBe('a claim has no time')
      expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.disputed = { at, reason: 'x' } }))).toBe('a claim has no time')
    }
  })

  test('a claim must be an object', () => {
    for (const value of [true, 1789430400, 'yes', null, []]) {
      expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.sent = value }))).toBe('sent is not an object')
      expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.disputed = value }))).toBe('disputed is not an object')
    }
  })

  test('a reason is text of at most 2000 characters', () => {
    const long = 'x'.repeat(2001)
    expect(() => viewBy(SELLER, { claims: { cancelled: { at: NOW, reason: long } } })).toThrow(/at most 2000 characters/)
    expect(() => viewBy(BUYER, { claims: { disputed: { at: NOW, reason: long } } })).toThrow(/at most 2000 characters/)
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.disputed = { at: NOW, reason: long } }))).toMatch(/at most 2000 characters/)
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.cancelled = { at: NOW, reason: 42 } }))).toMatch(/a reason is text/)
    expect(parsed(viewBy(BUYER, { claims: { disputed: { at: NOW, reason: 'x'.repeat(2000) } } })).claims.disputed?.reason).toHaveLength(2000)
  })

  test('the buyer can claim received and disputed, never sent or cancelled', () => {
    expect(parsed(viewBy(BUYER, { claims: { received: { at: NOW }, disputed: { at: NOW, reason: 'late' } } })).claims).toEqual({
      received: { at: NOW }, disputed: { at: NOW, reason: 'late' },
    })
    expect(() => viewBy(BUYER, { claims: { sent: { at: NOW } } })).toThrow(`the buyer can't claim "sent"`)
    expect(() => viewBy(BUYER, { claims: { cancelled: { at: NOW, reason: 'x' } } })).toThrow(`the buyer can't claim "cancelled"`)
    expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.sent = { at: NOW } }))).toBe(`the buyer can't claim "sent"`)
    expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.cancelled = { at: NOW, reason: 'x' } }))).toBe(`the buyer can't claim "cancelled"`)
  })

  test('the seller can claim sent, cancelled and disputed, never received', () => {
    const claims: EscrowClaims = { sent: { at: NOW }, cancelled: { at: NOW + 1, reason: 'a' }, disputed: { at: NOW + 2, reason: 'b' } }
    expect(parsed(viewBy(SELLER, { claims })).claims).toEqual(claims)
    expect(() => viewBy(SELLER, { claims: { received: { at: NOW } } })).toThrow(`the seller can't claim "received"`)
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.received = { at: NOW } }))).toBe(`the seller can't claim "received"`)
  })

  test('the arbiter states no claims and signs nothing in a view: its word is a ruling', () => {
    const arbiter = parsed(viewBy(ARBITER))
    expect(arbiter.role).toBe('arbiter')
    expect(arbiter.claims).toEqual({})
    const claims: EscrowClaims[] = [
      { disputed: { at: NOW, reason: 'x' } }, { sent: { at: NOW } }, { received: { at: NOW } }, { cancelled: { at: NOW, reason: 'x' } },
    ]
    for (const c of claims) expect(() => viewBy(ARBITER, { claims: c })).toThrow(/only the buyer and the seller state progress/)
    expect(() => viewBy(ARBITER, { sigs: [sig({ leaf: 'B' })] })).toThrow(/only the buyer and the seller state progress/)
    expect(refusal(edited(viewBy(ARBITER), ARBITER, (b) => { b.disputed = { at: NOW, reason: 'x' } }))).toMatch(/only the buyer and the seller/)
    expect(refusal(edited(viewBy(ARBITER), ARBITER, (b) => { b.sigs = [sig({ kind: 'refund', leaf: 'C' })] }))).toMatch(/only the buyer and the seller/)
  })

  test('each side may sign only leaves it is in, and only payouts a leaf can carry', () => {
    expect(() => viewBy(BUYER, { sigs: [sig({ kind: 'release', leaf: 'B' })] })).toThrow(/the buyer can't sign leaf B/)
    expect(() => viewBy(SELLER, { sigs: [sig({ kind: 'refund', leaf: 'C' })] })).toThrow(/the seller can't sign leaf C/)
    expect(() => viewBy(SELLER, { sigs: [sig({ kind: 'refund', leaf: 'B' })] })).toThrow(/can't use leaf B/)
    expect(() => viewBy(BUYER, { sigs: [sig({ kind: 'release', leaf: 'C' })] })).toThrow(/can't use leaf C/)
    expect(refusal(edited(viewBy(BUYER), BUYER, (b) => { b.sigs = [sig({ leaf: 'B' })] }))).toBe("the buyer can't sign leaf B")
  })

  test('a signature that is not well formed is refused, and so is anything but a list of them', () => {
    expect(() => viewBy(SELLER, { sigs: [sig({ sig: 'zz' })] })).toThrow(/signature: signature is not 64 bytes of hex/)
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.sigs = [{ ...sig(), outpoint: 'nope' }] }))).toMatch(/^signature: outpoint/)
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.sigs = [{ ...sig(), fee: 0 }] }))).toMatch(/^signature: fee/)
    for (const sigs of [sig(), 'sigs', null]) {
      expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.sigs = sigs }))).toBe('sigs is not a list')
    }
  })

  test('a view carries at most 8 signatures', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => sig({ fee: 200 + i }))
    expect(parsed(viewBy(SELLER, { sigs: many(8) })).sigs).toHaveLength(8)
    expect(() => viewBy(SELLER, { sigs: many(9) })).toThrow(/at most 8 signatures/)
    expect(refusal(edited(viewBy(SELLER), SELLER, (b) => { b.sigs = many(9) }))).toBe('a view carries at most 8 signatures')
  })

  test('a stranger may publish here, but only bare views, and they never count', () => {
    const stranger = parsed(viewBy(MALLORY))
    expect(stranger.role).toBeUndefined()
    expect(() => viewBy(MALLORY, { claims: { sent: { at: NOW } } })).toThrow(/only the buyer and the seller/)
    expect(() => viewBy(MALLORY, { sigs: [sig()] })).toThrow(/only the buyer and the seller/)
    const c = compareViews([parsed(viewBy(BUYER)), parsed(viewBy(SELLER)), stranger], ID)
    expect(c.participants).toHaveLength(2)
    expect(c.strangers).toEqual([stranger])
  })

  test('malformed bodies, or another kind, are a reason, not a crash', () => {
    for (const content of ['not json', '[]', 'null', '"text"', '42', '{}', '{"v":5}', '{"v":4}']) {
      const { id: _id, sig: _sig, ...unsigned } = viewBy(SELLER)
      expect(parseEscrowEvent(signEvent({ ...unsigned, content }, SELLER, AUX)).ok).toBe(false)
    }
    const { id: _id, sig: _sig, ...unsigned } = viewBy(SELLER)
    expect(refusal(signEvent({ ...unsigned, kind: 30402 }, SELLER, AUX))).toBe('kind 30402 is not 30078')
  })
})

describe('comparing views', () => {
  test('both sides agree, and each is found by role', () => {
    const c = compareViews([parsed(viewBy(BUYER)), parsed(viewBy(SELLER))], ID)
    expect(c.agreed).toBe(true)
    expect(c.disagreements).toEqual([])
    expect(c.buyerView?.role).toBe('buyer')
    expect(c.sellerView?.role).toBe('seller')
  })

  test('only the newest view from each side counts', () => {
    const old = parsed(viewBy(SELLER, {}, NOW))
    const newer = parsed(viewBy(SELLER, { claims: { sent: { at: NOW + 5 } } }, NOW + 10))
    const c = compareViews([newer, old], ID)
    expect(c.participants).toHaveLength(1)
    expect(c.sellerView?.claims.sent).toEqual({ at: NOW + 5 })
    expect(compareViews([old, newer], ID).sellerView?.claims.sent).toEqual({ at: NOW + 5 })
  })

  test('two views at the same second: the lower event id wins, as a relay replaces', () => {
    const a = parsed(viewBy(SELLER, { claims: { sent: { at: NOW } } }, NOW))
    const b = parsed(viewBy(SELLER, { claims: { disputed: { at: NOW, reason: 'x' } } }, NOW))
    const lower = a.event.id < b.event.id ? a : b
    expect(compareViews([a, b], ID).sellerView).toBe(lower)
    expect(compareViews([b, a], ID).sellerView).toBe(lower)
  })

  test('a look-alike escrow at another id is a stranger', () => {
    const other = parsed(viewBy(SELLER, { salt: 'cd'.repeat(32) }))
    const c = compareViews([other, parsed(viewBy(BUYER))], ID)
    expect(c.participants.map((v) => v.role)).toEqual(['buyer'])
    expect(c.strangers).toEqual([other])
  })

  test('the arbiter is no participant in the views', () => {
    const arbiter = parsed(viewBy(ARBITER))
    const c = compareViews([arbiter], ID)
    expect(c.participants).toHaveLength(0)
    expect(c.strangers).toEqual([arbiter])
  })

  test('a disagreement on a covered term, which only a bug could make, is reported loudly', () => {
    const buyer = parsed(viewBy(BUYER))
    const seller = parsed(viewBy(SELLER))
    const c = compareViews([buyer, { ...seller, amountSats: 1, deliverBlocks: 99 }], ID)
    expect(c.agreed).toBe(false)
    expect(c.disagreements.map((d) => d.field)).toEqual(['amount', 'transfer window'])
    expect(c.disagreements[0].values).toEqual([{ author: hx(BUYER), value: '2500000' }, { author: hx(SELLER), value: '1' }])
  })
})

describe('rulings', () => {
  const settlement = sig({ kind: 'release', leaf: 'B' })
  const ruling = (over: Record<string, unknown> = {}) =>
    signEvent(buildRuling({
      id: ID, decision: 'release', reason: "RDAP shows the transfer, and the buyer's read-only key shows the domain in their account",
      settlement, txid: 'aa'.repeat(32), parties: [hx(BUYER), hx(SELLER), 'junk'], pubkey: hx(ARBITER), createdAt: NOW, ...over,
    } as never), ARBITER, AUX)

  test('a ruling round-trips, at its own coordinate, tagging the parties', () => {
    const event = ruling()
    expect(event.tags).toEqual([
      ['d', RULING_D_PREFIX + ID], ['t', ESCROW_TOPIC], ['fmd_escrow', ID], ['p', hx(BUYER)], ['p', hx(SELLER)],
    ])
    const r = parseRuling(event)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ruling).toMatchObject({ id: ID, author: hx(ARBITER), decision: 'release', settlement, txid: 'aa'.repeat(32), publishedAt: NOW })
  })

  test('a refund ruling co-signs leaf C, and a ruling needs neither a signature nor a txid', () => {
    const refund = parseRuling(ruling({ decision: 'refund', reason: 'no transfer shows at the registry', settlement: sig({ kind: 'refund', leaf: 'C' }) }))
    expect(refund.ok && refund.ruling.settlement?.leaf).toBe('C')
    const bare = parseRuling(ruling({ settlement: undefined, txid: undefined }))
    expect(bare.ok).toBe(true)
    if (bare.ok) {
      expect(bare.ruling).not.toHaveProperty('settlement')
      expect(bare.ruling).not.toHaveProperty('txid')
    }
  })

  test('a ruling co-signs the leaf its decision needs, and gives a reason', () => {
    expect(() => ruling({ settlement: sig({ kind: 'release', leaf: 'A' }) })).toThrow(/leaf B/)
    expect(() => ruling({ decision: 'refund' })).toThrow(/leaf C/)
    expect(() => ruling({ decision: 'refund', settlement: sig({ kind: 'refund', leaf: 'A' }) })).toThrow(/leaf C/)
    expect(() => ruling({ reason: '  ' })).toThrow(/reason/)
    expect(() => ruling({ reason: 'x'.repeat(2001) })).toThrow(/reason/)
    expect(() => ruling({ decision: 'maybe' })).toThrow(/neither release nor refund/)
    expect(() => ruling({ txid: 'nope' })).toThrow(/txid/)
    expect(() => ruling({ id: 'nope' })).toThrow(/escrow id/)
  })

  test('a ruling whose d tag names another escrow, or in another format, is refused', () => {
    const event = ruling()
    const moved = retagged(event, ARBITER, event.tags.map((t) => (t[0] === 'd' ? ['d', RULING_D_PREFIX + 'ff'.repeat(32)] : t)))
    expect(parseRuling(moved)).toMatchObject({ ok: false, reason: 'the d tag names another escrow' })
    const v2 = (() => {
      const body = JSON.parse(event.content)
      const { id: _id, sig: _sig, ...unsigned } = event
      return signEvent({ ...unsigned, content: JSON.stringify({ ...body, v: 2 }) }, ARBITER, AUX)
    })()
    expect(parseRuling(v2)).toMatchObject({ ok: false, reason: 'unsupported ruling version 2' })
    expect(parseRuling(viewBy(SELLER)).ok).toBe(false)
  })
})

test('the filters fetch one escrow and its ruling, by authors when they are known', () => {
  const coordinates = [ESCROW_D_PREFIX + ID, RULING_D_PREFIX + ID]
  expect(escrowFilters(ID)).toEqual([{ kinds: [30078], '#d': coordinates }])
  const withAuthors = escrowFilters(ID, [hx(BUYER), hx(SELLER), hx(ARBITER), hx(BUYER), 'junk'])
  expect(withAuthors).toEqual([
    { kinds: [30078], '#d': coordinates },
    { kinds: [30078], '#d': coordinates, authors: [hx(BUYER), hx(SELLER), hx(ARBITER)] },
  ])
  expect(escrowsForFilter([hx(ARBITER)])).toEqual({ kinds: [30078], '#p': [hx(ARBITER)] })
})
