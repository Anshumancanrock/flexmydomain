/**
 * The whole product, end to end, against a local relay and a stubbed DNS.
 *
 * It walks the path a user takes (prove a domain, publish it, list it, zap it,
 * see it ranked) using the functions the pages call, in the order they call
 * them. Nothing here touches a public relay or a real resolver.
 */

import { test, expect, describe, afterEach } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  MSATS_PER_SAT,
  applyDeletions,
  buildDeletion,
  buildListing,
  buildPortfolio,
  buildZapRequest,
  checkListing,
  listingAddress,
  listingFilter,
  parseListing,
  parsePortfolio,
  portfolioFilter,
  rankByZaps,
  signEvent,
  upsertEntry,
  verifyPortfolio,
  verifyZapReceipt,
  zapReceiptFilter,
  addressOf,
  type NostrEvent,
} from '../../core/nostr/index.ts'
import { encodeProofRecord, proofEvent, proofRecordName } from '../../core/oracle/index.ts'
import { newestPerAddress, publishToRelays, queryRelays } from '../../net/relay.ts'
import { checkDomainProof } from '../../net/verify.ts'
import { deletionFilter } from '../../core/nostr/deletion.ts'
import { startRelay, type TestRelay } from '../harness/relay.ts'

const AUX = new Uint8Array(32)
const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

const SELLER = key(0x11)
const BUYER = key(0x22)
const PROVIDER = key(0x33) // the marketplace's zapper service
const MARKET = key(0x44)   // the marketplace's own recipient key

const DOMAIN = 'lumenary.com'
const IAT = 1789430400
const NOW = IAT + 600

// ---------------------------------------------------------------------------
// the fake zone
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch
let zone: Record<string, string[]> = {}

function stubDns(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    const name = url.searchParams.get('name') ?? ''
    const records = zone[name] ?? []
    return new Response(
      JSON.stringify({ Status: records.length ? 0 : 3, AD: true, Answer: records.map((d) => ({ type: 16, data: `"${d}"` })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

const open: TestRelay[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  zone = {}
  for (const r of open.splice(0)) r.close()
})

function relay(): TestRelay {
  const r = startRelay()
  open.push(r)
  return r
}

/** Steps 1 and 2 of the flex page: sign the proof, put it in the zone. */
function proveDomain(owner: typeof SELLER, domain = DOMAIN, iat = IAT) {
  const event = signEvent(proofEvent({ domain, pubkey: owner.pk, iat }), owner.sk, AUX)
  const record = { version: 'fmd1' as const, iat, pubkey: owner.pk, sig: event.sig }
  zone[proofRecordName(domain)] = [encodeProofRecord(record)]
  return { event, record }
}

// ---------------------------------------------------------------------------

describe('the whole path', () => {
  test('prove -> publish -> list -> browse -> zap -> rank', async () => {
    stubDns()
    const r = relay()
    const relays = [r.url]

    // ---- 1. The seller proves the domain and publishes the proof + portfolio.
    const { event: proof, record } = proveDomain(SELLER)

    const entries = upsertEntry([], {
      domain: DOMAIN,
      source: 'dns',
      iat: record.iat,
      sig: record.sig,
      firstSeen: IAT,
    })
    const portfolio = signEvent(
      buildPortfolio({ pubkey: SELLER.pk, entries, createdAt: NOW }),
      SELLER.sk,
      AUX,
    )

    expect((await publishToRelays(relays, proof)).every((x) => x.ok)).toBe(true)
    expect((await publishToRelays(relays, portfolio)).every((x) => x.ok)).toBe(true)

    // ---- 2. Somebody opens the seller's flex page. One fetch, one event.
    const portfolioEvents = await queryRelays(relays, [portfolioFilter(SELLER.pk)])
    const fetched = newestPerAddress(portfolioEvents)[0]
    expect(fetched).toBeTruthy()

    const parsedPortfolio = parsePortfolio(fetched)
    expect(parsedPortfolio.ok).toBe(true)
    if (!parsedPortfolio.ok) return

    // Verified offline, against the portfolio's own key, with no network.
    expect(verifyPortfolio(parsedPortfolio.portfolio).every((v) => v.proven)).toBe(true)

    // And the live half: the zone still agrees today.
    const liveProof = await checkDomainProof({ domain: DOMAIN, pubkey: SELLER.pk, now: NOW, dnsOnly: true })
    expect(liveProof.status.proven).toBe(true)

    // ---- 3. The seller lists it.
    const listing = signEvent(
      buildListing({
        pubkey: SELLER.pk,
        domain: DOMAIN,
        priceSats: 2_500_000,
        summary: 'A brighter internet.',
        publishedAt: NOW,
        proof: record,
      }),
      SELLER.sk,
      AUX,
    )
    expect((await publishToRelays(relays, listing)).every((x) => x.ok)).toBe(true)

    // ---- 4. A buyer opens the market page: the steps of load() in market.js.
    const found = await queryRelays(relays, [listingFilter({ limit: 500 })])
    const current = newestPerAddress(found)
    const authors = [...new Set(current.map((e) => e.pubkey))]
    const deletions = await queryRelays(relays, [deletionFilter(authors)])
    const live = applyDeletions(current, deletions)
    expect(live).toHaveLength(1)

    const parsed = parseListing(live[0])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const dns = await checkDomainProof({
      domain: parsed.listing.domain,
      pubkey: live[0].pubkey,
      now: NOW,
      dnsOnly: true,
    })
    const check = checkListing({ event: live[0], dnsProof: dns.dns, now: NOW })

    // The listing rule: the signature, the embedded proof and the zone all agree.
    expect(check.ok).toBe(true)
    expect(check.selfConsistent).toBe(true)
    expect(check.zoneConfirmed).toBe(true)
    expect(check.listing?.priceSats).toBe(2_500_000)

    // ---- 5. The buyer features it with a zap.
    const address = listingAddress(parsed.listing, relays)
    const amountSats = 5_000
    const zapRequest = signEvent(
      buildZapRequest({
        pubkey: BUYER.pk,
        recipient: MARKET.pk,
        amountMsats: amountSats * MSATS_PER_SAT,
        relays,
        address,
        createdAt: NOW,
      }),
      BUYER.sk,
      AUX,
    )

    // The provider writes the receipt, never the marketplace: it is the one
    // event here that somebody else signs on the recipient's behalf.
    const receipt = signEvent(
      {
        pubkey: PROVIDER.pk,
        created_at: NOW + 5,
        kind: 9735,
        tags: [
          ['p', MARKET.pk],
          ['a', address],
          ['bolt11', 'lnbc50u1pfake'],
          ['description', JSON.stringify(zapRequest)],
        ],
        content: '',
      },
      PROVIDER.sk,
      AUX,
    )
    await publishToRelays(relays, receipt)

    // ---- 6. The receipts are verified, counted and ranked.
    const receipts = await queryRelays(relays, [zapReceiptFilter({ addresses: [address], since: NOW - 7 * 86400 })])
    const verified = receipts
      .map((e) => verifyZapReceipt({ receipt: e, recipient: MARKET.pk, expectedProvider: PROVIDER.pk }))
      .filter((v) => v.ok)
      .map((v) => (v.ok ? v.zap : null))
      .filter(Boolean)

    expect(verified).toHaveLength(1)
    const ranking = rankByZaps(verified as never, { now: NOW + 10, windowSeconds: 7 * 86400 })
    expect(ranking[0].address).toBe(address)
    expect(ranking[0].sats).toBe(amountSats)
  })

  test('a listing for a domain the seller cannot prove is not verified', async () => {
    stubDns() // the zone is empty: no proof anywhere
    const r = relay()

    const stolen = signEvent(
      buildListing({
        pubkey: SELLER.pk,
        domain: 'apple.com',
        priceSats: 1,
        publishedAt: NOW,
        // A real signature by the seller, over a false claim.
        proof: {
          version: 'fmd1',
          iat: IAT,
          pubkey: SELLER.pk,
          sig: signEvent(proofEvent({ domain: 'apple.com', pubkey: SELLER.pk, iat: IAT }), SELLER.sk, AUX).sig,
        },
      }),
      SELLER.sk,
      AUX,
    )
    await publishToRelays([r.url], stolen)

    const [event] = await queryRelays([r.url], [listingFilter()])
    const dns = await checkDomainProof({ domain: 'apple.com', pubkey: SELLER.pk, now: NOW, dnsOnly: true })
    const check = checkListing({ event, dnsProof: dns.dns, now: NOW })

    // It is on the relay and internally consistent. The zone is what refuses
    // it: the event is not deleted, only left unverified.
    expect(r.events).toHaveLength(1)
    expect(check.selfConsistent).toBe(true)
    expect(check.ok).toBe(false)
    expect(check.zoneConfirmed).toBe(false)
  })

  test('delisting removes it from the market on the next load', async () => {
    stubDns()
    const r = relay()
    const { record } = proveDomain(SELLER)

    const listing = signEvent(
      buildListing({ pubkey: SELLER.pk, domain: DOMAIN, priceSats: 1000, publishedAt: NOW, proof: record }),
      SELLER.sk,
      AUX,
    )
    await publishToRelays([r.url], listing)

    const deletion = signEvent(
      buildDeletion({ pubkey: SELLER.pk, events: [listing], reason: 'delisted', createdAt: NOW + 60 }),
      SELLER.sk,
      AUX,
    )
    await publishToRelays([r.url], deletion)

    const found = newestPerAddress(await queryRelays([r.url], [listingFilter()]))
    const deletions = await queryRelays([r.url], [deletionFilter([SELLER.pk])])
    expect(applyDeletions(found, deletions)).toEqual([])
  })

  test('the proof also verifies as an event, with no DNS at all', async () => {
    const r = relay()
    const { event } = proveDomain(SELLER)
    await publishToRelays([r.url], event)

    const [fetched] = await queryRelays([r.url], [{ kinds: [30078], authors: [SELLER.pk] }])
    // Same 64 bytes as the TXT record. One signing action, two artefacts.
    expect(fetched.sig).toBe(event.sig)
    expect(addressOf(fetched)).toBe(`30078:${SELLER.pk}:fmd:proof:${DOMAIN}`)
  })

  test('republishing a portfolio keeps the entries it cannot verify', async () => {
    stubDns()
    const r = relay()

    // A portfolio holding two domains: one proven by DNS with a signature, one
    // by NIP-05, which carries no signature and cannot be verified offline.
    const { record } = proveDomain(SELLER)
    const before = [
      { domain: DOMAIN, source: 'dns' as const, iat: record.iat, sig: record.sig, firstSeen: IAT },
      { domain: 'nip05only.example', source: 'nip05' as const, firstSeen: IAT },
    ]
    await publishToRelays(
      [r.url],
      signEvent(buildPortfolio({ pubkey: SELLER.pk, entries: before, createdAt: NOW }), SELLER.sk, AUX),
    )

    const [held] = newestPerAddress(await queryRelays([r.url], [portfolioFilter(SELLER.pk)]))
    const parsed = parsePortfolio(held)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // The sell form offers only DNS-proven domains, so it filters. Republishing
    // from that filtered list would lose data: kind 30078 is replaceable, so
    // the filtered copy would become the portfolio and the NIP-05 entry would
    // be gone with no warning and no way back.
    const verdicts = verifyPortfolio(parsed.portfolio)
    const listable = parsed.portfolio.entries.filter((e, i) => verdicts[i].proven)
    expect(listable).toHaveLength(1)
    expect(parsed.portfolio.entries).toHaveLength(2)

    // Republish from the full list, as the page does.
    const after = upsertEntry(parsed.portfolio.entries, {
      domain: 'second.com',
      source: 'dns',
      iat: IAT,
      sig: proveDomain(SELLER, 'second.com').record.sig,
      firstSeen: NOW,
    })
    await publishToRelays(
      [r.url],
      signEvent(buildPortfolio({ pubkey: SELLER.pk, entries: after, createdAt: NOW + 10 }), SELLER.sk, AUX),
    )

    const [republished] = newestPerAddress(await queryRelays([r.url], [portfolioFilter(SELLER.pk)]))
    const reparsed = parsePortfolio(republished)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return

    const domains = reparsed.portfolio.entries.map((e) => e.domain).sort()
    expect(domains).toEqual(['lumenary.com', 'nip05only.example', 'second.com'])
  })

  test('a stale proof leaves the listing visible but unverified', async () => {
    stubDns()
    const r = relay()
    const { record } = proveDomain(SELLER)
    const listing = signEvent(
      buildListing({ pubkey: SELLER.pk, domain: DOMAIN, priceSats: 1000, publishedAt: NOW, proof: record }),
      SELLER.sk,
      AUX,
    )
    await publishToRelays([r.url], listing)

    // The seller loses the domain; the record disappears from the zone.
    zone = {}

    const [event] = await queryRelays([r.url], [listingFilter()])
    const dns = await checkDomainProof({ domain: DOMAIN, pubkey: SELLER.pk, now: NOW, dnsOnly: true })
    const check = checkListing({ event, dnsProof: dns.dns, now: NOW })

    expect(dns.answered).toBe(true)      // the resolvers answered: "no record"
    expect(check.ok).toBe(false)
    expect(check.listing?.domain).toBe(DOMAIN) // still renderable, marked stale
  })
})
