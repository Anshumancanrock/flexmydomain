/**
 * The listing: a NIP-99 classified listing, kind 30402. The format is
 * specified in spec/PROTOCOL.md.
 *
 * Pure: builds and checks events. DNS is resolved by the caller.
 *
 * A listing carries its own domain proof, so a client that has never heard of
 * flexmydomain can fetch the event, resolve one TXT record and know whether
 * the listing is real. Kind 30402 is a published NIP, so other Nostr
 * marketplaces can read these listings as well.
 */

import {
  normaliseDomain,
  tryNormaliseDomain,
} from '../oracle/domain.js'
import {
  PROOF_VERSION,
  proofDigest,
  verifyProofRecords,
  type ProofRecord,
  type ProofVerification,
} from '../oracle/proof.js'
import { isHex32, isHex64, tagValue, tagValues, verifyDigestSignature, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { naddrEncode } from './nip19.js'

/** NIP-99 classified listing. */
export const LISTING_KIND = 30402

/** The `d` prefix. One listing per domain per seller. */
export const LISTING_D_PREFIX = 'fmd:listing:'

/** The topic tag that indexers and clients filter listings on. */
export const LISTING_TOPIC = 'flexmydomain'

/**
 * The only currency a listing is priced in.
 *
 * USD is display only, so a seller and a buyer can never disagree afterwards
 * about which exchange rate applied. NIP-99 lets `price` carry any currency
 * code; this marketplace writes and accepts only this one.
 */
export const PRICE_CURRENCY = 'SATS'

/** The NIP-99 `status` values this marketplace uses. */
export type ListingStatus = 'active' | 'sold'

export interface ListingParams {
  pubkey: string
  domain: string
  /** Asking price in whole satoshis. */
  priceSats: number
  /** One line. NIP-99 `summary`; the long description goes in `content`. */
  summary?: string
  description?: string
  status?: ListingStatus
  /** Unix seconds. Also the event's created_at unless `createdAt` is given. */
  publishedAt: number
  createdAt?: number
  /** The seller's proof for the domain (spec/PROOF.md). */
  proof: ProofRecord
  /** sha256 of the RDAP snapshot, and when it was observed. */
  rdapSnapshot?: { hash: string; observedAt: number }
  /** Domain registration date, so a reader can see the name's age. */
  registeredAt?: number
  /** x-only keys of the arbiters this seller will accept. */
  arbiters?: string[]
  /** NIP-40. A listing that stops being re-proven should stop being served. */
  expiration?: number
}

export interface Listing {
  domain: string
  priceSats: number
  summary: string
  description: string
  status: ListingStatus
  publishedAt: number
  proof: ProofRecord
  rdapSnapshot?: { hash: string; observedAt: number }
  registeredAt?: number
  arbiters: string[]
  expiration?: number
  /** The event this was read out of, so callers need not carry two values. */
  event: NostrEvent
}

/**
 * Build the unsigned event for the seller to sign.
 *
 * Every extension tag is `fmd_`-prefixed, so none can collide with a tag name
 * that NIP-99 or another application defines.
 */
export function buildListing(params: ListingParams): UnsignedEvent {
  const domain = normaliseDomain(params.domain)
  if (!isHex32(params.pubkey)) throw new Error('buildListing: pubkey must be 64 lowercase hex characters')
  if (!Number.isInteger(params.priceSats) || params.priceSats <= 0) {
    throw new Error(`buildListing: priceSats must be a positive integer, got ${JSON.stringify(params.priceSats)}`)
  }
  if (params.proof.pubkey !== params.pubkey) {
    // Readers refuse to show a listing whose proof is for another key, so
    // refuse to build one.
    throw new Error('buildListing: the proof is for a different key than the one publishing this listing')
  }
  if (params.proof.version !== PROOF_VERSION) {
    throw new Error(`buildListing: unsupported proof version ${JSON.stringify(params.proof.version)}`)
  }

  const tags: NostrTag[] = [
    ['d', LISTING_D_PREFIX + domain],
    ['title', domain],
    ['price', String(params.priceSats), PRICE_CURRENCY],
    ['status', params.status ?? 'active'],
    ['t', 'domain'],
    ['t', LISTING_TOPIC],
    ['published_at', String(params.publishedAt)],
    ['fmd_domain', domain],
    ['fmd_proof', String(params.proof.iat), params.proof.sig],
  ]

  if (params.summary) tags.splice(2, 0, ['summary', params.summary])
  if (params.rdapSnapshot) {
    tags.push(['fmd_rdap', params.rdapSnapshot.hash, String(params.rdapSnapshot.observedAt)])
  }
  if (params.registeredAt !== undefined) tags.push(['fmd_created', String(params.registeredAt)])
  for (const arbiter of params.arbiters ?? []) {
    if (!isHex32(arbiter)) throw new Error(`buildListing: arbiter ${JSON.stringify(arbiter)} is not an x-only pubkey`)
    tags.push(['fmd_arbiter', arbiter])
  }
  if (params.expiration !== undefined) tags.push(['expiration', String(params.expiration)])

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? params.publishedAt,
    kind: LISTING_KIND,
    tags,
    content: params.description ?? '',
  }
}

/**
 * Read a listing out of an event.
 *
 * Structure only: the event is well-formed and internally consistent. Whether
 * the domain is proven is for {@link checkListing}.
 */
export function parseListing(event: NostrEvent): { ok: true; listing: Listing } | { ok: false; reason: string } {
  if (event.kind !== LISTING_KIND) return { ok: false, reason: `kind ${event.kind} is not ${LISTING_KIND}` }

  const d = tagValue(event, 'd')
  if (!d || !d.startsWith(LISTING_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${LISTING_D_PREFIX}* identifier` }
  }
  const fromD = tryNormaliseDomain(d.slice(LISTING_D_PREFIX.length))
  if (!fromD.ok) return { ok: false, reason: `d tag domain: ${fromD.reason}` }
  if (d !== LISTING_D_PREFIX + fromD.domain) return { ok: false, reason: 'd tag is not in normalised form' }

  // `fmd_domain` and the `d` tag must agree. They state the same fact, and a
  // listing whose identifier and payload name different domains is either
  // broken or trying to mislead a reader.
  const explicit = tagValue(event, 'fmd_domain')
  if (explicit !== undefined && explicit !== fromD.domain) {
    return { ok: false, reason: `fmd_domain ${JSON.stringify(explicit)} disagrees with the d tag` }
  }

  const priceTag = event.tags.find((t) => t[0] === 'price')
  if (!priceTag || priceTag.length < 3) return { ok: false, reason: 'no price tag' }
  if (priceTag[2].toUpperCase() !== PRICE_CURRENCY) {
    return { ok: false, reason: `price is in ${priceTag[2]}; this marketplace prices in ${PRICE_CURRENCY}` }
  }
  if (!/^\d+$/.test(priceTag[1])) return { ok: false, reason: 'price is not a whole number of sats' }
  const priceSats = Number(priceTag[1])
  if (!Number.isSafeInteger(priceSats) || priceSats <= 0) return { ok: false, reason: 'price is out of range' }

  const proofTag = event.tags.find((t) => t[0] === 'fmd_proof')
  if (!proofTag || proofTag.length < 3) return { ok: false, reason: 'no fmd_proof tag' }
  if (!/^\d{1,10}$/.test(proofTag[1])) return { ok: false, reason: 'fmd_proof iat is not decimal unix seconds' }
  if (!isHex64(proofTag[2])) return { ok: false, reason: 'fmd_proof sig is not 128 hex characters' }

  const status = tagValue(event, 'status') ?? 'active'
  if (status !== 'active' && status !== 'sold') return { ok: false, reason: `unknown status ${JSON.stringify(status)}` }

  const rdapTag = event.tags.find((t) => t[0] === 'fmd_rdap')

  return {
    ok: true,
    listing: {
      domain: fromD.domain,
      priceSats,
      summary: tagValue(event, 'summary') ?? '',
      description: event.content,
      status,
      publishedAt: Number(tagValue(event, 'published_at') ?? event.created_at),
      // The proof's pubkey is the event's pubkey by construction. It is not a
      // separate field, so a proof is always checked under the publishing key.
      proof: { version: PROOF_VERSION, iat: Number(proofTag[1]), pubkey: event.pubkey, sig: proofTag[2] },
      rdapSnapshot:
        rdapTag && rdapTag.length >= 3 && /^[0-9a-f]{64}$/.test(rdapTag[1])
          ? { hash: rdapTag[1], observedAt: Number(rdapTag[2]) }
          : undefined,
      registeredAt: numberTag(event, 'fmd_created'),
      arbiters: tagValues(event, 'fmd_arbiter').filter(isHex32),
      expiration: numberTag(event, 'expiration'),
      event,
    },
  }
}

function numberTag(event: NostrEvent, name: string): number | undefined {
  const raw = tagValue(event, name)
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * The check an indexer and a client must both apply before showing a listing.
 *
 * Nostr has no gatekeeper, so anyone can publish a kind 30402 claiming
 * `apple.com`. A listing is shown only when all three hold:
 *
 *   1. the event's own signature verifies  (the caller does this; relays lie)
 *   2. the embedded proof signature verifies for this domain and this pubkey
 *   3. the domain's DNS agrees               (`dnsProof`, resolved elsewhere)
 *
 * Steps 1 and 2 are offline. Step 3 needs the network, so its result is
 * passed in, and a missing result is reported as unverified, never as
 * verified. An unverified listing stays on the relays; it is only not shown
 * as real.
 */
export interface ListingCheck {
  ok: boolean
  reason?: string
  listing?: Listing
  /** True when the seller's embedded proof signature is internally valid. */
  selfConsistent: boolean
  /** True only when a DNS (or NIP-05) observation was supplied and passed. */
  zoneConfirmed: boolean
  expired?: boolean
}

export function checkListing(params: {
  event: NostrEvent
  dnsProof?: ProofVerification
  now?: number
}): ListingCheck {
  const parsed = parseListing(params.event)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, selfConsistent: false, zoneConfirmed: false }
  const listing = parsed.listing

  const digest = proofDigest({ domain: listing.domain, pubkey: params.event.pubkey, iat: listing.proof.iat })
  const selfConsistent = verifyDigestSignature(listing.proof.sig, digest, params.event.pubkey)
  if (!selfConsistent) {
    return {
      ok: false,
      reason: 'the embedded proof does not verify for this domain and this key',
      listing,
      selfConsistent: false,
      zoneConfirmed: false,
    }
  }

  const expired = listing.expiration !== undefined && params.now !== undefined && params.now > listing.expiration
  const zoneConfirmed = params.dnsProof?.ok === true

  if (!zoneConfirmed) {
    return {
      ok: false,
      reason: params.dnsProof ? `DNS: ${params.dnsProof.reason ?? 'no record verified'}` : 'the zone was not checked',
      listing,
      selfConsistent: true,
      zoneConfirmed: false,
      expired,
    }
  }

  if (expired) {
    return { ok: false, reason: 'expired', listing, selfConsistent: true, zoneConfirmed: true, expired }
  }

  return { ok: true, listing, selfConsistent: true, zoneConfirmed: true, expired: false }
}

/**
 * Verify a listing's embedded proof against a freshly resolved TXT RRset in
 * one call, which is the form page code needs.
 */
export function checkListingAgainstZone(params: {
  event: NostrEvent
  txtRecords: readonly string[]
  now?: number
}): ListingCheck {
  const parsed = parseListing(params.event)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, selfConsistent: false, zoneConfirmed: false }
  return checkListing({
    event: params.event,
    now: params.now,
    dnsProof: verifyProofRecords({
      domain: parsed.listing.domain,
      pubkey: params.event.pubkey,
      records: params.txtRecords,
      now: params.now,
    }),
  })
}

/** The listing's shareable identity: an naddr, not a URL on any host. */
export function listingAddress(listing: Pick<Listing, 'domain'> & { event: Pick<NostrEvent, 'pubkey'> }, relays?: string[]): string {
  return naddrEncode({
    identifier: LISTING_D_PREFIX + listing.domain,
    pubkey: listing.event.pubkey,
    kind: LISTING_KIND,
    relays,
  })
}

/** The relay filter an indexer or a client subscribes with. */
export function listingFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kinds: [LISTING_KIND], '#t': [LISTING_TOPIC], ...extra }
}
