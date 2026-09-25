// core/nostr vectors. Serialisation and NIP-19 cases follow the NIP texts (npub is NIP-19's own
// vector). The rest: an id must cover its content, and a listing must prove its domain under its own key.

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  DEFAULT_RELAYS,
  LISTING_D_PREFIX,
  LISTING_KIND,
  PORTFOLIO_D,
  addressOf,
  buildListing,
  buildPortfolio,
  checkEvent,
  checkListing,
  checkListingAgainstZone,
  decodeNip19,
  eventId,
  listingAddress,
  listingFilter,
  naddrEncode,
  neventEncode,
  noteEncode,
  npubEncode,
  nprofileEncode,
  nostrUri,
  parseListing,
  parsePortfolio,
  portfolioFilter,
  removeEntry,
  serializeEvent,
  signEvent,
  toPubkeyHex,
  tryDecodeNip19,
  upsertEntry,
  verifyEvent,
  verifyPortfolio,
  type NostrEvent,
  type PortfolioEntry,
} from '../../core/nostr/index.ts'

import { encodeProofRecord, proofEvent, type ProofRecord } from '../../core/oracle/index.ts'

const AUX = new Uint8Array(32)

function key(fill: number) {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

const SELLER = key(0x11)
const STRANGER = key(0x22)
const IAT = 1789430400
const NOW = IAT + 3600
const DOMAIN = 'lumenary.com'

function proofFor(domain = DOMAIN, signer = SELLER, iat = IAT): ProofRecord {
  const event = signEvent(proofEvent({ domain, pubkey: signer.pk, iat }), signer.sk, AUX)
  return { version: 'fmd1', iat, pubkey: signer.pk, sig: event.sig }
}

describe('NIP-01 events', () => {
  const base = { pubkey: SELLER.pk, created_at: IAT, kind: 1, tags: [['t', 'domain']], content: 'hello' }

  test('the serialisation is the six-element array with no whitespace', () => {
    expect(serializeEvent(base)).toBe(`[0,"${SELLER.pk}",${IAT},1,[["t","domain"]],"hello"]`)
  })

  test('NIP-01 escapes, and only those', () => {
    const s = serializeEvent({ ...base, content: 'a"b\\c\nd\te\u0001fég' })
    expect(s).toContain('a\\"b\\\\c\\nd\\te\\u0001fég')
    // Non-ASCII stays as UTF-8. Control characters don't.
    expect(s).not.toContain('\\u00e9')
  })

  test('a signed event verifies, and its id covers its content', () => {
    const event = signEvent(base, SELLER.sk, AUX)
    expect(event.id).toBe(eventId(base))
    expect(verifyEvent(event)).toBe(true)
  })

  test('rewriting content after signing is caught by the id, not only the sig', () => {
    const event = signEvent(base, SELLER.sk, AUX)
    const r = checkEvent({ ...event, content: 'goodbye' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('id mismatch')
  })

  test('keeping the id and swapping the signature is caught too', () => {
    const event = signEvent(base, SELLER.sk, AUX)
    const other = signEvent({ ...base, pubkey: STRANGER.pk }, STRANGER.sk, AUX)
    const r = checkEvent({ ...event, sig: other.sig })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('does not verify')
  })

  test('signing under the wrong pubkey is refused up front', () => {
    expect(() => signEvent({ ...base, pubkey: STRANGER.pk }, SELLER.sk, AUX)).toThrow(/this key is/)
  })

  test('the same aux randomness gives the same signature', () => {
    expect(signEvent(base, SELLER.sk, AUX).sig).toBe(signEvent(base, SELLER.sk, AUX).sig)
  })

  test('malformed events return a reason instead of throwing', () => {
    for (const bad of [null, 42, {}, { id: 'x' }, { ...base }]) {
      expect(checkEvent(bad).ok).toBe(false)
    }
  })

  test('an uppercase pubkey is refused rather than silently re-cased', () => {
    expect(() => serializeEvent({ ...base, pubkey: SELLER.pk.toUpperCase() })).toThrow()
  })

  test('addressOf builds the NIP-01 coordinate', () => {
    expect(addressOf({ kind: 30402, pubkey: SELLER.pk, tags: [['d', 'fmd:listing:x.com']] })).toBe(
      `30402:${SELLER.pk}:fmd:listing:x.com`,
    )
  })
})

describe('NIP-19', () => {
  // NIP-19's published vector.
  const VECTOR_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
  const VECTOR_NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'

  test('npub matches the vector in the NIP', () => {
    expect(npubEncode(VECTOR_HEX)).toBe(VECTOR_NPUB)
    expect(decodeNip19(VECTOR_NPUB)).toEqual({ type: 'npub', data: VECTOR_HEX })
  })

  test('note and npub of the same bytes differ only by prefix', () => {
    expect(noteEncode(VECTOR_HEX).startsWith('note1')).toBe(true)
    expect(decodeNip19(noteEncode(VECTOR_HEX))).toEqual({ type: 'note', data: VECTOR_HEX })
  })

  test('nprofile round-trips with relay hints', () => {
    const encoded = nprofileEncode({ pubkey: VECTOR_HEX, relays: ['wss://relay.damus.io', 'wss://nos.lol'] })
    expect(decodeNip19(encoded)).toEqual({
      type: 'nprofile',
      data: { pubkey: VECTOR_HEX, relays: ['wss://relay.damus.io', 'wss://nos.lol'] },
    })
  })

  test('nevent carries author and kind', () => {
    const encoded = neventEncode({ id: VECTOR_HEX, author: SELLER.pk, kind: 30402, relays: ['wss://nos.lol'] })
    expect(decodeNip19(encoded)).toEqual({
      type: 'nevent',
      data: { id: VECTOR_HEX, author: SELLER.pk, kind: 30402, relays: ['wss://nos.lol'] },
    })
  })

  test('naddr round-trips the whole coordinate', () => {
    const pointer = { identifier: 'fmd:listing:lumenary.com', pubkey: SELLER.pk, kind: LISTING_KIND, relays: undefined }
    const decoded = decodeNip19(naddrEncode(pointer))
    expect(decoded.type).toBe('naddr')
    if (decoded.type === 'naddr') {
      expect(decoded.data.identifier).toBe(pointer.identifier)
      expect(decoded.data.kind).toBe(LISTING_KIND)
      expect(decoded.data.pubkey).toBe(SELLER.pk)
    }
  })

  test('the kind is big-endian, so a mangled one does not decode plausibly', () => {
    const decoded = decodeNip19(naddrEncode({ identifier: 'x', pubkey: SELLER.pk, kind: 30402 }))
    if (decoded.type === 'naddr') expect(decoded.data.kind).toBe(30402)
  })

  test('a nostr: URI prefix is accepted on input', () => {
    expect(decodeNip19(nostrUri(VECTOR_NPUB))).toEqual({ type: 'npub', data: VECTOR_HEX })
    expect(nostrUri(nostrUri(VECTOR_NPUB))).toBe(`nostr:${VECTOR_NPUB}`)
  })

  test('rubbish decodes to undefined rather than throwing at a caller', () => {
    for (const bad of ['', 'npub1', 'nope1qqq', 42, null, `${VECTOR_NPUB}x`]) {
      expect(tryDecodeNip19(bad)).toBeUndefined()
    }
  })

  test('toPubkeyHex accepts every form a user might paste', () => {
    expect(toPubkeyHex(VECTOR_HEX)).toBe(VECTOR_HEX)
    expect(toPubkeyHex(VECTOR_NPUB)).toBe(VECTOR_HEX)
    expect(toPubkeyHex(nprofileEncode({ pubkey: VECTOR_HEX }))).toBe(VECTOR_HEX)
    expect(toPubkeyHex(noteEncode(VECTOR_HEX))).toBeUndefined() // An id is not a key.
  })
})

describe('the listing, kind 30402', () => {
  const proof = proofFor()
  const params = {
    pubkey: SELLER.pk,
    domain: 'WWW.Lumenary.com',
    priceSats: 2_500_000,
    summary: 'A brighter internet.',
    description: '# lumenary.com\n\nTen years old, clean history.',
    publishedAt: IAT,
    proof,
    rdapSnapshot: { hash: 'a'.repeat(64), observedAt: IAT },
    registeredAt: 1427968800,
    arbiters: [STRANGER.pk],
  }

  const signed = () => signEvent(buildListing(params), SELLER.sk, AUX)
  const txt = [encodeProofRecord(proof)]

  test('it is a NIP-99 event other marketplaces can already read', () => {
    const e = buildListing(params)
    expect(e.kind).toBe(LISTING_KIND)
    expect(e.tags).toContainEqual(['d', `${LISTING_D_PREFIX}${DOMAIN}`])
    expect(e.tags).toContainEqual(['title', DOMAIN])
    expect(e.tags).toContainEqual(['price', '2500000', 'SATS'])
    expect(e.tags).toContainEqual(['status', 'active'])
    expect(e.tags).toContainEqual(['t', 'flexmydomain'])
  })

  test('every extension tag is fmd_ namespaced', () => {
    const known = new Set(['d', 'title', 'summary', 'price', 'status', 't', 'published_at', 'expiration'])
    for (const [name] of buildListing(params).tags) {
      if (!known.has(name)) expect(name.startsWith('fmd_')).toBe(true)
    }
  })

  test('it parses back to what went in', () => {
    const r = parseListing(signed())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.listing.domain).toBe(DOMAIN)
      expect(r.listing.priceSats).toBe(2_500_000)
      expect(r.listing.proof).toEqual(proof)
      expect(r.listing.arbiters).toEqual([STRANGER.pk])
      expect(r.listing.rdapSnapshot).toEqual({ hash: 'a'.repeat(64), observedAt: IAT })
    }
  })

  test('a listing carries its own proof, so no server is needed to check it', () => {
    const r = checkListingAgainstZone({ event: signed(), txtRecords: txt, now: NOW })
    expect(r.ok).toBe(true)
    expect(r.selfConsistent).toBe(true)
    expect(r.zoneConfirmed).toBe(true)
  })

  test('a listing for a domain the seller cannot prove is refused', () => {
    const stolen = signEvent(
      buildListing({ ...params, domain: 'apple.com', proof: proofFor('apple.com', SELLER) }),
      SELLER.sk,
      AUX,
    )
    // Self-consistent, since the seller did sign a claim. The zone decides.
    expect(checkListingAgainstZone({ event: stolen, txtRecords: [], now: NOW }).ok).toBe(false)
    expect(checkListingAgainstZone({ event: stolen, txtRecords: [], now: NOW }).selfConsistent).toBe(true)
  })

  test("a proof lifted from another key does not become this seller's", () => {
    // STRANGER's real proof in SELLER's listing. buildListing refuses it, and a hand-forged
    // one fails the check.
    expect(() => buildListing({ ...params, proof: proofFor(DOMAIN, STRANGER) })).toThrow(/different key/)

    const forged = signEvent(
      {
        ...buildListing(params),
        tags: buildListing(params).tags.map((t) =>
          t[0] === 'fmd_proof' ? ['fmd_proof', String(IAT), proofFor(DOMAIN, STRANGER).sig] : t,
        ),
      },
      SELLER.sk,
      AUX,
    )
    const r = checkListing({ event: forged, now: NOW })
    expect(r.ok).toBe(false)
    expect(r.selfConsistent).toBe(false)
  })

  test('a d tag naming one domain and fmd_domain another is refused', () => {
    const e = buildListing(params)
    const tampered = signEvent(
      { ...e, tags: e.tags.map((t) => (t[0] === 'fmd_domain' ? ['fmd_domain', 'otherbrand.com'] : t)) },
      SELLER.sk,
      AUX,
    )
    expect(parseListing(tampered).ok).toBe(false)
  })

  test('a price in anything but sats is refused', () => {
    const e = buildListing(params)
    const usd = signEvent({ ...e, tags: e.tags.map((t) => (t[0] === 'price' ? ['price', '25000', 'USD'] : t)) }, SELLER.sk, AUX)
    const r = parseListing(usd)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('SATS')
  })

  test('NIP-40: an expired listing is reported as expired, not as valid', () => {
    const e = signEvent(buildListing({ ...params, expiration: NOW - 1 }), SELLER.sk, AUX)
    const r = checkListingAgainstZone({ event: e, txtRecords: txt, now: NOW })
    expect(r.ok).toBe(false)
    expect(r.expired).toBe(true)
  })

  test('an unchecked zone is never reported as a verified listing', () => {
    const r = checkListing({ event: signed(), now: NOW })
    expect(r.ok).toBe(false)
    expect(r.zoneConfirmed).toBe(false)
    expect(r.reason).toContain('not checked')
  })

  test('the share identity is an naddr, not a URL on any host', () => {
    const r = parseListing(signed())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const naddr = listingAddress(r.listing, ['wss://nos.lol'])
    expect(naddr.startsWith('naddr1')).toBe(true)
    const decoded = decodeNip19(naddr)
    if (decoded.type === 'naddr') {
      expect(decoded.data.identifier).toBe(`${LISTING_D_PREFIX}${DOMAIN}`)
      expect(decoded.data.pubkey).toBe(SELLER.pk)
    }
  })

  test('the listing filter asks for kind 30402 with the flexmydomain topic', () => {
    expect(listingFilter({ limit: 200 })).toEqual({ kinds: [30402], '#t': ['flexmydomain'], limit: 200 })
  })

  test('a zero or fractional price is refused at build time', () => {
    expect(() => buildListing({ ...params, priceSats: 0 })).toThrow()
    expect(() => buildListing({ ...params, priceSats: 1.5 })).toThrow()
  })
})

describe('the portfolio, kind 30078', () => {
  const entries: PortfolioEntry[] = [
    { domain: 'zeta.io', source: 'dns', iat: IAT, sig: proofFor('zeta.io').sig, firstSeen: IAT - 1000 },
    { domain: DOMAIN, source: 'dns', iat: IAT, sig: proofFor().sig, firstSeen: IAT - 5000, tagline: 'A brighter internet.' },
  ]
  const build = (e = entries) => buildPortfolio({ pubkey: SELLER.pk, entries: e, createdAt: NOW })
  const signedPortfolio = (): NostrEvent => signEvent(build(), SELLER.sk, AUX)

  test('one replaceable event holds the whole portfolio', () => {
    const e = build()
    expect(e.kind).toBe(30078)
    expect(e.tags).toContainEqual(['d', PORTFOLIO_D])
  })

  test('re-publishing an unchanged portfolio produces identical bytes', () => {
    expect(eventId(build())).toBe(eventId(build([...entries].reverse())))
  })

  test('a reader verifies every domain offline, against the portfolio key alone', () => {
    const r = parsePortfolio(signedPortfolio())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const verdicts = verifyPortfolio(r.portfolio)
    expect(verdicts).toHaveLength(2)
    expect(verdicts.every((v) => v.proven)).toBe(true)
  })

  test('a portfolio cannot be published with a proof that does not verify', () => {
    expect(() =>
      buildPortfolio({
        pubkey: SELLER.pk,
        createdAt: NOW,
        entries: [{ domain: DOMAIN, source: 'dns', iat: IAT, sig: proofFor(DOMAIN, STRANGER).sig, firstSeen: IAT }],
      }),
    ).toThrow(/does not verify/)
  })

  test("a stolen entry does not verify in somebody else's portfolio", () => {
    // SELLER's proof, republished inside STRANGER's portfolio.
    const forged: NostrEvent = signEvent(
      {
        pubkey: STRANGER.pk,
        created_at: NOW,
        kind: 30078,
        tags: [['d', PORTFOLIO_D]],
        content: JSON.stringify({
          v: 1,
          domains: [{ domain: DOMAIN, source: 'dns', iat: IAT, sig: proofFor().sig, first_seen: IAT }],
        }),
      },
      STRANGER.sk,
      AUX,
    )
    const r = parsePortfolio(forged)
    expect(r.ok).toBe(true)
    if (r.ok) expect(verifyPortfolio(r.portfolio)[0].proven).toBe(false)
  })

  test('a malformed entry is dropped with a reason, not fatal to the page', () => {
    const e: NostrEvent = signEvent(
      {
        pubkey: SELLER.pk,
        created_at: NOW,
        kind: 30078,
        tags: [['d', PORTFOLIO_D]],
        content: JSON.stringify({
          v: 1,
          domains: [
            { domain: 'not a domain', source: 'dns', iat: IAT, sig: 'f'.repeat(128), first_seen: IAT },
            { domain: DOMAIN, source: 'dns', iat: IAT, sig: proofFor().sig, first_seen: IAT },
            'nonsense',
          ],
        }),
      },
      SELLER.sk,
      AUX,
    )
    const r = parsePortfolio(e)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.portfolio.entries).toHaveLength(1)
      expect(r.dropped).toHaveLength(2)
    }
  })

  test('content that is not JSON returns a reason instead of throwing', () => {
    const e = signEvent(
      { pubkey: SELLER.pk, created_at: NOW, kind: 30078, tags: [['d', PORTFOLIO_D]], content: 'not json' },
      SELLER.sk,
      AUX,
    )
    expect(parsePortfolio(e).ok).toBe(false)
  })

  test('re-proving a domain never resets how long it has been held', () => {
    const later = upsertEntry(entries, { domain: DOMAIN, source: 'dns', iat: NOW, sig: 'a'.repeat(128), firstSeen: NOW })
    expect(later.find((e) => e.domain === DOMAIN)?.firstSeen).toBe(IAT - 5000)
  })

  test('upsert normalises, so one domain cannot appear twice under two spellings', () => {
    const merged = upsertEntry(entries, { domain: 'WWW.Lumenary.COM', source: 'dns', iat: NOW, sig: 'a'.repeat(128), firstSeen: NOW })
    expect(merged.filter((e) => e.domain === DOMAIN)).toHaveLength(1)
    expect(() =>
      buildPortfolio({ pubkey: SELLER.pk, createdAt: NOW, entries: [...entries, { ...entries[0] }] }),
    ).toThrow(/twice/)
  })

  test('removeEntry takes any spelling of the name', () => {
    expect(removeEntry(entries, 'https://WWW.Lumenary.com/')).toHaveLength(1)
  })

  test('a NIP-05 entry is never reported as cryptographically proven', () => {
    const r = parsePortfolio(
      signEvent(build([{ domain: 'nip05.example', source: 'nip05', firstSeen: IAT }]), SELLER.sk, AUX),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const [verdict] = verifyPortfolio(r.portfolio)
      expect(verdict.proven).toBe(false)
      expect(verdict.reason).toContain('live')
    }
  })

  test('the fetch filter is one query for one event', () => {
    expect(portfolioFilter(SELLER.pk)).toEqual({ kinds: [30078], authors: [SELLER.pk], '#d': [PORTFOLIO_D], limit: 1 })
  })
})

describe('the default relay set', () => {
  test('has at least five wss:// relays, none on a flexmydomain host', () => {
    expect(DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(5)
    for (const relay of DEFAULT_RELAYS) expect(relay.startsWith('wss://')).toBe(true)
    expect(DEFAULT_RELAYS.some((r) => r.includes('flexmydomain'))).toBe(false)
  })
})
