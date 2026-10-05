// net/relay.ts over a real WebSocket, against test/harness/relay.ts.

import { test, expect, describe, afterEach } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  buildAuthEvent,
  buildListing,
  buildPortfolio,
  listingFilter,
  matchFilter,
  portfolioFilter,
  signEvent,
  type NostrEvent,
} from '../../core/nostr/index.ts'
import { proofEvent } from '../../core/oracle/index.ts'
import {
  countOnRelay,
  countOnRelays,
  keepConnectionsWarm,
  newestPerAddress,
  publishToRelay,
  publishToRelays,
  queryRelay,
  queryRelays,
  type RelayAuth,
} from '../../net/relay.ts'
import { RelayDirectory, publishOutbox, queryOutbox, readOwn } from '../../net/outbox.ts'
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

  test('settle answers once enough relays are done, and the slow one arrives late', async () => {
    const a = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    const b = relay({ events: [listingFor(BOB, 'zeta.io')] })
    const slow = relay({ events: [listingFor(BOB, 'slow.io')], withholdEose: true })
    const late: { relay: string; count: number; complete: boolean }[] = []
    const started = performance.now()
    const events = await queryRelays([a.url, b.url, slow.url], [listingFilter()], {
      timeoutMs: 1500,
      settle: { quorum: 2, graceMs: 100 },
      onLate: (relay, evs, complete) => { late.push({ relay, count: evs.length, complete }) },
    })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(events.map((e) => e.pubkey).sort()).toEqual([ALICE.pk, BOB.pk].sort())
    await Bun.sleep(1700)
    expect(late).toEqual([{ relay: slow.url, count: 1, complete: false }])
  })

  test('settle never answers early on errors or timeouts alone', async () => {
    const hanging = relay({ events: [listingFor(ALICE, 'lumenary.com')], withholdEose: true })
    const started = performance.now()
    const events = await queryRelays([hanging.url, 'ws://localhost:1'], [listingFilter()], {
      timeoutMs: 700,
      settle: { quorum: 1, graceMs: 50 },
    })
    expect(performance.now() - started).toBeGreaterThan(600)
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

  // A page replacing an event (a portfolio) must know its read finished. A timeout isn't "nothing there".
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
    expect(directory.certain(ALICE.pk)).toBe(true)
  })

  const listOf = (who: typeof ALICE, urls: string[], createdAt = IAT) => signEvent(
    buildRelayList({ pubkey: who.pk, relays: urls.map((url) => ({ url, read: false, write: true })), createdAt }),
    who.sk,
    AUX,
  )

  test('"no list" from too few relays is a guess, and a write asks again', async () => {
    // The relay with Alice's list doesn't answer in time. Caching "no list" for good
    // would send her writes only to the fallback for the rest of the session.
    const mine = relay()
    const holder = relay({ dropOnOpen: true, events: [listOf(ALICE, [mine.url])] })
    const quick = relay()
    // Both must answer before "no list" counts.
    const directory = new RelayDirectory([quick.url, holder.url], 2)
    await directory.resolve([ALICE.pk], { timeoutMs: 300 })
    expect(directory.known(ALICE.pk)).toEqual([])
    expect(directory.certain(ALICE.pk)).toBe(false)

    quick.add(listOf(ALICE, [mine.url]))
    await publishOutbox(directory, listingFor(ALICE, 'lumenary.com'))
    expect(directory.certain(ALICE.pk)).toBe(true)
    expect(mine.published).toHaveLength(1)
  })

  test('the quorum is a majority of the fallback relays, never more than three', () => {
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `wss://r${i}.example`)
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => new RelayDirectory(urls(n)).quorum)).toEqual([1, 1, 2, 2, 3, 3, 3])
  })

  test('a new relay list goes to the relays it adds, and later writes follow it', async () => {
    const old = relay()
    const added = relay()
    const fallback = relay()
    const directory = new RelayDirectory([fallback.url])
    directory.absorb([listOf(ALICE, [old.url])])

    await publishOutbox(directory, listOf(ALICE, [added.url], IAT + 10))
    expect(old.published).toHaveLength(1)
    expect(added.published).toHaveLength(1)

    await publishOutbox(directory, listingFor(ALICE, 'lumenary.com'))
    expect(added.published.map((e) => e.kind)).toContain(30402)
  })

  test('a new relay list that no relay accepts leaves later writes where they were', async () => {
    const old = relay({ refuseWith: 'blocked: down for maintenance' })
    const added = relay({ refuseWith: 'restricted: not a member' })
    const directory = new RelayDirectory([relay().url])
    directory.absorb([listOf(ALICE, [old.url])])

    const results = await publishOutbox(directory, listOf(ALICE, [added.url], IAT + 10))
    expect(results.some((r) => r.ok)).toBe(false)
    // Readers still look where the old list says, so writes must keep going there.
    expect(directory.writeRelays(ALICE.pk)).toEqual([old.url])
  })

  test("a caller's limit doesn't cut short the relay-list lookup", async () => {
    const theirs = relay({ events: [listingFor(ALICE, 'lumenary.com'), listingFor(BOB, 'zeta.io')] })
    const fallback = relay({ events: [listOf(ALICE, [theirs.url]), listOf(BOB, [theirs.url])] })
    const directory = new RelayDirectory([fallback.url])
    await queryOutbox(directory, [ALICE.pk, BOB.pk], { kinds: [30402] }, { limit: 1 })
    expect(directory.writeRelays(ALICE.pk)).toContain(theirs.url)
    expect(directory.writeRelays(BOB.pk)).toContain(theirs.url)
  })
})

describe('reading your own events before replacing them', () => {
  const listOf = (who: typeof ALICE, urls: string[]) => signEvent(
    buildRelayList({ pubkey: who.pk, relays: urls.map((url) => ({ url, read: false, write: true })), createdAt: IAT }),
    who.sk,
    AUX,
  )
  const portfolioAt = (createdAt: number) =>
    signEvent(buildPortfolio({ pubkey: ALICE.pk, entries: [], createdAt }), ALICE.sk, AUX)

  test('every relay the key writes to is asked, not only the first few a reader uses', async () => {
    // The newest portfolio sits only on the sixth. A read capped at four never sees it.
    const writes = Array.from({ length: 6 }, (_, i) => relay(i === 5 ? { events: [portfolioAt(IAT + 50)] } : {}))
    const fallback = relay({ events: [listOf(ALICE, writes.map((r) => r.url)), portfolioAt(IAT)] })
    const directory = new RelayDirectory([fallback.url])

    const read = await readOwn(directory, ALICE.pk, [portfolioFilter(ALICE.pk)], { extraRelays: [fallback.url] })
    expect(newestPerAddress(read.events)[0].created_at).toBe(IAT + 50)
    expect(read.complete).toBe(true)
    expect(read.answered).toBe(7)
    expect(read.unanswered).toEqual([])
  })

  test('a relay that does not finish makes the read incomplete, and is named', async () => {
    const quiet = relay({ withholdEose: true, events: [portfolioAt(IAT + 50)] })
    const fine = relay()
    const fallback = relay({ events: [listOf(ALICE, [quiet.url, fine.url])] })
    const directory = new RelayDirectory([fallback.url])

    const read = await readOwn(directory, ALICE.pk, [portfolioFilter(ALICE.pk)], { timeoutMs: 300 })
    expect(read.complete).toBe(false)
    expect(read.unanswered).toEqual([quiet.url])
    expect(read.answered).toBe(1)
  })

  test('a relay list that was only a guess makes the read incomplete', async () => {
    const holder = relay({ dropOnOpen: true, events: [listOf(ALICE, [relay().url])] })
    const quick = relay()
    const directory = new RelayDirectory([quick.url, holder.url], 2)

    const read = await readOwn(directory, ALICE.pk, [portfolioFilter(ALICE.pk)], { timeoutMs: 300 })
    expect(directory.certain(ALICE.pk)).toBe(false)
    expect(read.complete).toBe(false)
  })

  test("only the key's own events come back, whatever a relay sends", async () => {
    const bobs = signEvent(buildPortfolio({ pubkey: BOB.pk, entries: [], createdAt: IAT + 99 }), BOB.sk, AUX)
    const liar = relay({ ignoreFilters: true, events: [bobs, portfolioAt(IAT)] })
    const directory = new RelayDirectory([liar.url])

    const read = await readOwn(directory, ALICE.pk, [portfolioFilter(ALICE.pk)])
    expect(read.events.map((e) => e.pubkey)).toEqual([ALICE.pk])
  })
})

describe('warm connections', () => {
  afterEach(() => keepConnectionsWarm(0))

  test('off by default: every read opens its own connection and closes it', async () => {
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    await queryRelay(r.url, [listingFilter()])
    await queryRelay(r.url, [listingFilter()])
    expect(r.connections).toBe(2)
    await Bun.sleep(50)
    expect(r.openNow).toBe(0)
  })

  test('on: the next read of a relay starts on the socket the last clean read left open', async () => {
    keepConnectionsWarm(2000)
    const listing = listingFor(ALICE, 'lumenary.com')
    const r = relay({ events: [listing, listingFor(BOB, 'zeta.io')] })
    expect((await queryRelay(r.url, [{ ...listingFilter(), authors: [ALICE.pk] }])).map((e) => e.id)).toEqual([listing.id])
    expect((await queryRelay(r.url, [{ ...listingFilter(), authors: [ALICE.pk] }])).map((e) => e.id)).toEqual([listing.id])
    expect((await queryRelays([r.url], [{ ...listingFilter(), authors: [BOB.pk] }])).map((e) => e.pubkey)).toEqual([BOB.pk])
    expect(r.connections).toBe(1)
  })

  test('a held socket the relay has closed is not used', async () => {
    keepConnectionsWarm(2000)
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    await queryRelay(r.url, [listingFilter()])
    r.kick()
    await Bun.sleep(50)
    expect(await queryRelay(r.url, [listingFilter()])).toHaveLength(1)
    expect(r.connections).toBe(2)
  })

  test('a held socket that dies under the next read: that read starts again on a new one, and completes', async () => {
    keepConnectionsWarm(2000)
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')], dropSecondReq: true })
    await queryRelay(r.url, [listingFilter()])
    const done: boolean[] = []
    const events = await queryRelays([r.url], [listingFilter()], { onRelayDone: (_relay, _count, _error, complete) => done.push(!!complete) })
    expect(events).toHaveLength(1)
    expect(done).toEqual([true])
    expect(r.connections).toBe(2)
  })

  test('a read that timed out closes its socket rather than handing it on', async () => {
    keepConnectionsWarm(2000)
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')], withholdEose: true })
    await queryRelay(r.url, [listingFilter()], { timeoutMs: 150 })
    await queryRelay(r.url, [listingFilter()], { timeoutMs: 150 })
    expect(r.connections).toBe(2)
    await Bun.sleep(50)
    expect(r.openNow).toBe(0)
  })

  test('a read that may authenticate neither takes a held socket nor leaves its own', async () => {
    keepConnectionsWarm(2000)
    const r = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    const auth: RelayAuth = async (url, challenge) =>
      signEvent(buildAuthEvent({ relay: url, challenge, pubkey: ALICE.pk, createdAt: IAT }), ALICE.sk, AUX)
    await queryRelay(r.url, [listingFilter()]) // leaves its socket held
    expect(await queryRelay(r.url, [listingFilter()], { auth })).toHaveLength(1) // a socket of its own, closed after
    expect(r.connections).toBe(2)
    await queryRelay(r.url, [listingFilter()]) // takes the held one
    expect(r.connections).toBe(2)
    await Bun.sleep(50)
    expect(r.openNow).toBe(1)
  })

  test('a held socket closes by itself once its time is up, and turning it off closes the rest', async () => {
    keepConnectionsWarm(100)
    const a = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    await queryRelay(a.url, [listingFilter()])
    expect(a.openNow).toBe(1)
    await Bun.sleep(250)
    expect(a.openNow).toBe(0)

    keepConnectionsWarm(5000)
    const b = relay({ events: [listingFor(ALICE, 'lumenary.com')] })
    await queryRelay(b.url, [listingFilter()])
    expect(b.openNow).toBe(1)
    keepConnectionsWarm(0)
    await Bun.sleep(50)
    expect(b.openNow).toBe(0)
  })
})

describe('a relay that ignores the filter', () => {
  test("events that don't match what was asked are dropped, however valid", async () => {
    // A lying relay serves Bob's portfolio for Alice's query. Republishing from it would replace hers.
    const bobs = signEvent(buildPortfolio({ pubkey: BOB.pk, entries: [], createdAt: IAT }), BOB.sk, AUX)
    const r = relay({ events: [bobs, listingFor(BOB, 'zeta.io')], ignoreFilters: true })
    expect(await queryRelays([r.url], [portfolioFilter(ALICE.pk)], { timeoutMs: 2000 })).toEqual([])
    expect(await queryRelays([r.url], [portfolioFilter(BOB.pk)], { timeoutMs: 2000 })).toEqual([bobs])
  })

  test('the matcher follows NIP-01', () => {
    const e = listingFor(ALICE, 'lumenary.com')
    expect(matchFilter({ kinds: [30402], authors: [ALICE.pk] }, e)).toBe(true)
    expect(matchFilter({ authors: [BOB.pk] }, e)).toBe(false)
    expect(matchFilter({ ids: [e.id] }, e)).toBe(true)
    expect(matchFilter({ since: e.created_at + 1 }, e)).toBe(false)
    expect(matchFilter({ until: e.created_at - 1 }, e)).toBe(false)
    expect(matchFilter({ '#d': ['fmd:listing:lumenary.com'] }, e)).toBe(true)
    expect(matchFilter({ '#d': ['fmd:listing:other.com'] }, e)).toBe(false)
    // Keys the matcher can't check, like NIP-50 search, don't narrow it.
    expect(matchFilter({ kinds: [30402], search: 'anything' }, e)).toBe(true)
  })
})
