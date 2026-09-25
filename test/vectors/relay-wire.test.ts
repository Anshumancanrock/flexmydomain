// net/relay.ts over a real WebSocket against test/harness/relay.ts. Each case is a failure mode
// that would otherwise only show up in a browser, on somebody else's relay.

import { test, expect, describe, afterEach } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  buildListing,
  buildPortfolio,
  listingFilter,
  signEvent,
  type NostrEvent,
} from '../../core/nostr/index.ts'
import { proofEvent } from '../../core/oracle/index.ts'
import {
  countOnRelay,
  countOnRelays,
  newestPerAddress,
  publishToRelay,
  publishToRelays,
  queryRelay,
  queryRelays,
} from '../../net/relay.ts'
import { RelayDirectory, publishOutbox, queryOutbox } from '../../net/outbox.ts'
import { buildRelayList } from '../../core/nostr/relays.ts'
import { startRelay, type TestRelay } from '../harness/relay.ts'

const AUX = new Uint8Array(32)
const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
const ALICE = key(0x11)
const BOB = key(0x22)
const IAT = 1789430400

function listingFor(owner: typeof ALICE, domain: string, priceSats = 1000): NostrEvent {
  const proofSig = signEvent(proofEvent({ domain, pubkey: owner.pk, iat: IAT }), owner.sk, AUX).sig
  return signEvent(
    buildListing({
      pubkey: owner.pk,
      domain,
      priceSats,
      publishedAt: IAT,
      proof: { version: 'fmd1', iat: IAT, pubkey: owner.pk, sig: proofSig },
    }),
    owner.sk,
    AUX,
  )
}

const open: TestRelay[] = []
const relay = (opts: Parameters<typeof startRelay>[0] = {}) => {
  const r = startRelay(opts)
  open.push(r)
  return r
}
afterEach(() => {
  for (const r of open.splice(0)) r.close()
})

describe('querying', () => {
  test('a listing round-trips over the wire', async () => {
    const listing = listingFor(ALICE, 'lumenary.com')
    const r = relay({ events: [listing] })

    const events = await queryRelay(r.url, [listingFilter()])
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe(listing.id)
  })

  test('filters are applied, not ignored', async () => {
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com'), listingFor(BOB, 'zeta.io')] })

    const mine = await queryRelay(r.url, [{ ...listingFilter(), authors: [ALICE.pk] }])
    expect(mine).toHaveLength(1)
    expect(mine[0].pubkey).toBe(ALICE.pk)
  })

  test('an event that does not verify is dropped', async () => {
    // Relays can return anything. Checking every event is the only defence.
    const good = listingFor(ALICE, 'lumenary.com')
    const tampered: NostrEvent = { ...good, content: 'rewritten after signing' }
    const r = relay({ events: [tampered] })

    expect(await queryRelay(r.url, [listingFilter()])).toEqual([])
  })

  test('a relay that never sends EOSE resolves at the timeout with what arrived', async () => {
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')], withholdEose: true })
    const started = performance.now()
    const events = await queryRelay(r.url, [listingFilter()], { timeoutMs: 700 })
    expect(events).toHaveLength(1)
    expect(performance.now() - started).toBeGreaterThan(600)
  })

  test('a dead relay gives an empty result instead of throwing', async () => {
    const events = await queryRelays(['ws://localhost:1'], [listingFilter()], { timeoutMs: 500 })
    expect(events).toEqual([])
  })

  test('one dead relay among live ones does not lose the live results', async () => {
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    const events = await queryRelays([r.url, 'ws://localhost:1'], [listingFilter()], { timeoutMs: 800 })
    expect(events).toHaveLength(1)
  })

  test('the same event from two relays is returned once', async () => {
    const listing = listingFor(ALICE, 'lumenary.com')
    const a = relay({ events: [listing] })
    const b = relay({ events: [listing] })
    expect(await queryRelays([a.url, b.url], [listingFilter()])).toHaveLength(1)
  })

  test('onRelayDone reports per relay, including the failure', async () => {
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    const seen: Record<string, { count: number; error?: string }> = {}
    await queryRelays([r.url, 'ws://localhost:1'], [listingFilter()], {
      timeoutMs: 800,
      onRelayDone: (url, count, error) => { seen[url] = { count, error } },
    })
    expect(seen[r.url].count).toBe(1)
    expect(seen['ws://localhost:1'].error ?? seen['ws://localhost:1'].count === 0).toBeTruthy()
  })

  /* A page replacing an event (a portfolio) from what it read must know the read finished.
     A timeout doesn't mean "there is nothing". */
  test('onRelayDone says complete only when the relay said EOSE', async () => {
    const finished = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    const hanging = relay({ events: [listingFor(ALICE, 'lumenary.com')], withholdEose: true })
    const seen: Record<string, boolean | undefined> = {}
    await queryRelays([finished.url, hanging.url, 'ws://localhost:1'], [listingFilter()], {
      timeoutMs: 700,
      onRelayDone: (url, _count, _error, complete) => { seen[url] = complete },
    })
    expect(seen[finished.url]).toBe(true)
    expect(seen[hanging.url]).toBe(false)
    expect(seen['ws://localhost:1']).toBe(false)
  })

  test('limit stops the read early', async () => {
    const events = Array.from({ length: 5 }, (_, i) => listingFor(ALICE, `d${i}.com`))
    const r = relay({ events })
    expect((await queryRelay(r.url, [listingFilter()], { limit: 2 })).length).toBe(2)
  })
})

describe('publishing', () => {
  test('an accepted publish reports ok, and the relay holds it', async () => {
    const r = relay()
    const listing = listingFor(ALICE, 'lumenary.com')

    const [result] = await publishToRelays([r.url], listing)
    expect(result.ok).toBe(true)
    expect(r.published).toHaveLength(1)
    expect(await queryRelay(r.url, [listingFilter()])).toHaveLength(1)
  })

  test("a refusal is reported with the relay's own reason", async () => {
    const r = relay({ refuseWith: 'blocked: pow required' })
    const [result] = await publishToRelays([r.url], listingFor(ALICE, 'lumenary.com'))
    expect(result.ok).toBe(false)
    expect(result.message).toBe('blocked: pow required')
  })

  test('partial acceptance is reported per relay', async () => {
    const good = relay()
    const bad = relay({ refuseWith: 'nope' })
    const results = await publishToRelays([good.url, bad.url], listingFor(ALICE, 'lumenary.com'))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toHaveLength(1)
  })

  test('an unverifiable event is refused locally, before any relay sees it', async () => {
    const r = relay()
    const broken: NostrEvent = { ...listingFor(ALICE, 'lumenary.com'), sig: 'f'.repeat(128) }
    await expect(publishToRelays([r.url], broken)).rejects.toThrow(/does not verify/)
    expect(r.published).toHaveLength(0)
  })

  test('a dead relay times out rather than hanging', async () => {
    const result = await publishToRelay('ws://localhost:1', listingFor(ALICE, 'lumenary.com'), { timeoutMs: 500 })
    expect(result.ok).toBe(false)
  })
})

describe('replaceable events', () => {
  test('republishing a portfolio replaces it, and the newest wins', async () => {
    const r = relay()
    const first = signEvent(
      buildPortfolio({ pubkey: ALICE.pk, entries: [], createdAt: IAT }), ALICE.sk, AUX)
    const second = signEvent(
      buildPortfolio({ pubkey: ALICE.pk, entries: [], createdAt: IAT + 100 }), ALICE.sk, AUX)

    await publishToRelays([r.url], first)
    await publishToRelays([r.url], second)

    const events = await queryRelay(r.url, [{ kinds: [30078], authors: [ALICE.pk] }])
    expect(newestPerAddress(events)).toHaveLength(1)
    expect(newestPerAddress(events)[0].created_at).toBe(IAT + 100)
  })

  test('an older version arriving late does not win', async () => {
    const newer = signEvent(buildPortfolio({ pubkey: ALICE.pk, entries: [], createdAt: IAT + 100 }), ALICE.sk, AUX)
    const older = signEvent(buildPortfolio({ pubkey: ALICE.pk, entries: [], createdAt: IAT }), ALICE.sk, AUX)
    expect(newestPerAddress([older, newer])[0].created_at).toBe(IAT + 100)
    expect(newestPerAddress([newer, older])[0].created_at).toBe(IAT + 100)
  })
})

describe('NIP-45 COUNT', () => {
  test('a relay that supports it answers with a number', async () => {
    const r = relay({ supportsCount: true, events: [listingFor(ALICE, 'a.com'), listingFor(BOB, 'b.com')] })
    expect(await countOnRelay(r.url, [listingFilter()])).toBe(2)
  })

  test('a relay without COUNT support answers undefined, not zero', async () => {
    // Showing "could not count" as 0 would report the market as empty.
    const r = relay({ supportsCount: false, events: [listingFor(ALICE, 'a.com')] })
    expect(await countOnRelay(r.url, [listingFilter()])).toBeUndefined()
  })

  test('across relays, the largest answer wins and non-answers are ignored', async () => {
    const a = relay({ supportsCount: true, events: [listingFor(ALICE, 'a.com')] })
    const b = relay({ supportsCount: true, events: [listingFor(ALICE, 'a.com'), listingFor(BOB, 'b.com')] })
    const c = relay({ supportsCount: false })
    // Not a sum. Relays hold overlapping sets.
    expect(await countOnRelays([a.url, b.url, c.url], [listingFilter()])).toBe(2)
  })

  test('every relay silent means undefined', async () => {
    const r = relay({ supportsCount: false })
    expect(await countOnRelays([r.url], [listingFilter()])).toBeUndefined()
  })
})

describe('the outbox model, over the wire', () => {
  test("publishing goes to the author's own write relays, not the fallback", async () => {
    const mine = relay()
    const fallback = relay()

    const list = signEvent(
      buildRelayList({
        pubkey: ALICE.pk,
        relays: [{ url: mine.url, read: false, write: true }],
        createdAt: IAT,
      }),
      ALICE.sk,
      AUX,
    )

    const directory = new RelayDirectory([fallback.url])
    directory.absorb([list])

    await publishOutbox(directory, listingFor(ALICE, 'lumenary.com'))

    expect(mine.published).toHaveLength(1)
    expect(fallback.published).toHaveLength(0)
  })

  test('a key with no relay list uses the fallback relays', async () => {
    const fallback = relay()
    const directory = new RelayDirectory([fallback.url])
    await publishOutbox(directory, listingFor(BOB, 'zeta.io'))
    expect(fallback.published).toHaveLength(1)
  })

  test('reading an author goes to the relays they write to', async () => {
    const theirs = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    const ours = relay({ events: [listingFor(BOB, 'zeta.io')] })

    const list = signEvent(
      buildRelayList({ pubkey: ALICE.pk, relays: [{ url: theirs.url, read: false, write: true }], createdAt: IAT }),
      ALICE.sk,
      AUX,
    )
    const directory = new RelayDirectory([ours.url])
    directory.absorb([list])

    const events = await queryOutbox(directory, [ALICE.pk], { kinds: [30402] })
    expect(events).toHaveLength(1)
    expect(events[0].pubkey).toBe(ALICE.pk)
  })

  test('resolve() asks once per key even when called concurrently', async () => {
    const r = relay()
    const directory = new RelayDirectory([r.url])
    const [a, b, c] = await Promise.all([
      directory.resolve([ALICE.pk]),
      directory.resolve([ALICE.pk]),
      directory.resolve([ALICE.pk, BOB.pk]),
    ])
    expect(a.get(ALICE.pk)).toEqual([])
    expect(b.get(ALICE.pk)).toEqual([])
    expect(c.get(BOB.pk)).toEqual([])
    // Misses are cached, or every render re-asks the network about every key.
    expect(directory.known(ALICE.pk)).toEqual([])
  })
})
