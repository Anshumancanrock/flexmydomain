/**
 * The escrow event (core/nostr/escrow.ts).
 *
 * Two rules matter most here, and a failure of either is an attack:
 *
 *   1. the address in a view must be the one its own parameters derive;
 *      otherwise a plausible-looking escrow can point at an output only its
 *      publisher can spend, and the victim funds it;
 *   2. a disagreement between the parties' views is shown, never reconciled:
 *      an escrow where the buyer and seller state different amounts is a
 *      dispute to see before funding.
 */

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  ESCROW_D_PREFIX,
  ESCROW_KIND,
  buildEscrowEvent,
  compareViews,
  deriveEscrowId,
  deriveEscrowState,
  escrowAddress,
  escrowFilter,
  escrowsForFilter,
  parseEscrowEvent,
  signEvent,
  type EscrowView,
  type NostrEvent,
} from '../../core/nostr/index.ts'
import { buildTree } from '../../core/escrow/index.ts'

const AUX = new Uint8Array(32)
const secret = (f: number) => new Uint8Array(32).fill(f)
const x = (sk: Uint8Array) => schnorr.getPublicKey(sk)

const BUYER = secret(0x11)
const SELLER = secret(0x22)
const ARBITER = secret(0x33)
const MALLORY = secret(0x44)
const MALLORY2 = secret(0x45) // a second key she also controls

const SALT = 'ab'.repeat(32)
const NOW = 1789430400

const PARAMS = {
  salt: SALT,
  buyer: x(BUYER),
  seller: x(SELLER),
  arbiter: x(ARBITER),
  timeoutTo: 'buyer' as const,
  timeoutBlocks: 4320,
  network: 'signet' as const,
  amountSats: 2_500_000,
  domain: 'lumenary.com',
}

function viewBy(sk: Uint8Array, over: Record<string, unknown> = {}): NostrEvent {
  return signEvent(
    buildEscrowEvent({ ...PARAMS, ...over, pubkey: bytesToHex(x(sk)), createdAt: NOW }),
    sk,
    AUX,
  )
}

const parsed = (event: NostrEvent): EscrowView => {
  const r = parseEscrowEvent(event)
  if (!r.ok) throw new Error(r.reason)
  return r.view
}

// ---------------------------------------------------------------------------

describe('the event', () => {
  test('it is kind 30078 at a derived coordinate, tagging every party', () => {
    const e = buildEscrowEvent({ ...PARAMS, pubkey: bytesToHex(x(BUYER)), createdAt: NOW })
    expect(e.kind).toBe(ESCROW_KIND)
    expect(e.tags).toContainEqual(['d', ESCROW_D_PREFIX + deriveEscrowId(PARAMS)])
    expect(e.tags).toContainEqual(['p', bytesToHex(x(BUYER))])
    expect(e.tags).toContainEqual(['p', bytesToHex(x(SELLER))])
    expect(e.tags).toContainEqual(['p', bytesToHex(x(ARBITER))])
  })

  test('all parties derive the same id without coordinating', () => {
    // The id is a hash of the parameters, so nobody has to choose it and send
    // it to the others in a message that could be tampered with.
    expect(deriveEscrowId(PARAMS)).toBe(deriveEscrowId({ ...PARAMS }))
    expect(parsed(viewBy(BUYER)).id).toBe(parsed(viewBy(SELLER)).id)
  })

  test('the salt makes two otherwise identical escrows distinct', () => {
    expect(deriveEscrowId({ ...PARAMS, salt: 'cd'.repeat(32) })).not.toBe(deriveEscrowId(PARAMS))
  })

  test('the stated address is the one the keys actually produce', () => {
    const view = parsed(viewBy(BUYER))
    const tree = buildTree({
      buyer: x(BUYER),
      seller: x(SELLER),
      arbiter: x(ARBITER),
      timeoutTo: 'buyer',
      timeoutBlocks: 4320,
    })
    expect(view.address).toBe(tree.addresses.signet)
    expect(view.address).toBe(escrowAddress(PARAMS))
  })

  test('it round-trips every field', () => {
    const event = viewBy(BUYER, {
      funding: { txid: 'f'.repeat(64), vout: 1, amountSats: 2_500_000 },
      commitment: { registrarIanaId: '292', nameservers: ['ns1.buyer.example'] },
      deadlines: { fundBy: NOW + 86400 },
      rdapSnapshots: ['a'.repeat(64)],
      listing: 'naddr1xyz',
    })
    const v = parsed(event)
    expect(v.funding).toEqual({ txid: 'f'.repeat(64), vout: 1, amountSats: 2_500_000 })
    expect(v.commitment?.registrarIanaId).toBe('292')
    expect(v.deadlines.fundBy).toBe(NOW + 86400)
    expect(v.rdapSnapshots).toEqual(['a'.repeat(64)])
    expect(v.listing).toBe('naddr1xyz')
  })

  test('a no-arbiter escrow is a first-class shape', () => {
    const noArbiter = { ...PARAMS, arbiter: undefined, timeoutTo: 'seller' as const }
    const event = signEvent(
      buildEscrowEvent({ ...noArbiter, pubkey: bytesToHex(x(BUYER)), createdAt: NOW }),
      BUYER,
      AUX,
    )
    const v = parsed(event)
    expect(v.arbiter).toBeUndefined()
    expect(v.timeoutTo).toBe('seller')
    expect(v.address).toBe(escrowAddress(noArbiter))
  })
})

describe('what must not work', () => {
  test('an address that its own keys do not produce is refused', () => {
    // The attack: publish a plausible escrow naming an output only you can
    // spend, and wait for somebody to fund it.
    const honest = viewBy(BUYER)
    const body = JSON.parse(honest.content)
    // Two keys Mallory controls, so the output is hers alone to spend.
    const mine = buildTree({
      buyer: x(MALLORY),
      seller: x(MALLORY2),
      timeoutTo: 'buyer',
      timeoutBlocks: 4320,
    }).addresses.signet
    body.address = mine

    const forged = signEvent({ ...honest, content: JSON.stringify(body) }, BUYER, AUX)
    const r = parseEscrowEvent(forged)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('not the one these keys produce')
      expect(r.reason).toContain('do not fund it')
    }
  })

  test('changing any parameter without changing the address is refused', () => {
    const honest = viewBy(BUYER)
    const body = JSON.parse(honest.content)
    body.timeout_blocks = 1008 // a different tree, same stated address
    const forged = signEvent({ ...honest, content: JSON.stringify(body) }, BUYER, AUX)
    expect(parseEscrowEvent(forged).ok).toBe(false)
  })

  test('a d tag that does not match the derived id is refused', () => {
    const honest = viewBy(BUYER)
    const forged = signEvent(
      { ...honest, tags: honest.tags.map((t) => (t[0] === 'd' ? ['d', `${ESCROW_D_PREFIX}deadbeef`] : t)) },
      BUYER,
      AUX,
    )
    const r = parseEscrowEvent(forged)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('d tag does not match')
  })

  test('malformed bodies are a reason, not a crash', () => {
    const honest = viewBy(BUYER)
    for (const content of ['', 'not json', '{}', '{"v":1}']) {
      expect(parseEscrowEvent(signEvent({ ...honest, content }, BUYER, AUX)).ok).toBe(false)
    }
  })
})

describe('disagreement is shown, not reconciled', () => {
  test('matching views agree', () => {
    const result = compareViews([parsed(viewBy(BUYER)), parsed(viewBy(SELLER))])
    expect(result.agreed).toBe(true)
    expect(result.disagreements).toEqual([])
    expect(result.participants).toHaveLength(2)
  })

  test('a funding outpoint only one party has recorded is a disagreement', () => {
    const result = compareViews([
      parsed(viewBy(BUYER, { funding: { txid: 'a'.repeat(64), vout: 0, amountSats: 2_500_000 } })),
      parsed(viewBy(SELLER)),
    ])
    expect(result.agreed).toBe(false)
    expect(result.disagreements.map((d) => d.field)).toContain('funding outpoint')
  })

  test('a settlement one party claims and the other does not is shown', () => {
    const result = compareViews([
      parsed(viewBy(BUYER, { settlementTxid: 'b'.repeat(64) })),
      parsed(viewBy(SELLER)),
    ])
    expect(result.agreed).toBe(false)
    const field = result.disagreements.find((d) => d.field === 'settlement txid')
    expect(field?.values).toHaveLength(2)
  })

  test('a stranger publishing to the coordinate is not a disagreement', () => {
    // Anyone may publish to an addressable coordinate. A non-participant's
    // view is noise, and treating it as a conflict would let anybody cast
    // doubt on any escrow for free.
    const stranger = parseEscrowEvent(
      signEvent(buildEscrowEvent({ ...PARAMS, pubkey: bytesToHex(x(MALLORY)), createdAt: NOW }), MALLORY, AUX),
    )
    expect(stranger.ok).toBe(true)
    if (!stranger.ok) return

    const result = compareViews([parsed(viewBy(BUYER)), parsed(viewBy(SELLER)), stranger.view])
    expect(result.agreed).toBe(true)
    expect(result.strangers).toHaveLength(1)
    expect(result.participants).toHaveLength(2)
  })

  test('only the newest view from each party counts', () => {
    const old = parsed(viewBy(BUYER))
    const updated = parsed(
      signEvent(
        buildEscrowEvent({
          ...PARAMS,
          pubkey: bytesToHex(x(BUYER)),
          createdAt: NOW + 100,
          funding: { txid: 'a'.repeat(64), vout: 0, amountSats: 2_500_000 },
        }),
        BUYER,
        AUX,
      ),
    )
    const seller = parsed(
      signEvent(
        buildEscrowEvent({
          ...PARAMS,
          pubkey: bytesToHex(x(SELLER)),
          createdAt: NOW + 100,
          funding: { txid: 'a'.repeat(64), vout: 0, amountSats: 2_500_000 },
        }),
        SELLER,
        AUX,
      ),
    )
    // The buyer's stale view disagreed; their current one does not.
    expect(compareViews([old, updated, seller]).agreed).toBe(true)
  })
})

describe('state is derived from facts, not from claims', () => {
  const view = parsed(viewBy(BUYER, { deadlines: { fundBy: NOW + 86400 } }))

  test('open until something is paid', () => {
    expect(deriveEscrowState({ view, now: NOW }).state).toBe('open')
  })

  test('funded when the chain says so', () => {
    expect(deriveEscrowState({ view, funded: true, now: NOW }).state).toBe('funded')
  })

  test('transferring once the registry shows a transfer underway', () => {
    expect(deriveEscrowState({ view, funded: true, transferPending: true, now: NOW }).state).toBe('transferring')
  })

  test('settled only when the output is spent, never because an event says so', () => {
    const claimed = parsed(viewBy(BUYER, { settlementTxid: 'c'.repeat(64) }))
    // The event claims a settlement. The chain has not confirmed one.
    expect(deriveEscrowState({ view: claimed, funded: true, now: NOW }).state).toBe('funded')
    expect(deriveEscrowState({ view: claimed, funded: true, spent: true, now: NOW }).state).toBe('settled')
  })

  test('expired when the funding deadline passes with nothing paid', () => {
    expect(deriveEscrowState({ view, now: NOW + 90000 }).state).toBe('expired')
  })
})

test('the filters fetch one escrow, and every escrow a key is party to', () => {
  const id = deriveEscrowId(PARAMS)
  expect(escrowFilter(id)).toEqual({ kinds: [30078], '#d': [ESCROW_D_PREFIX + id] })
  expect(escrowsForFilter([bytesToHex(x(BUYER))])).toEqual({ kinds: [30078], '#p': [bytesToHex(x(BUYER))] })
})
