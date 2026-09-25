/**
 * NIP-99 classified listing, kind 30402. Format in spec/PROTOCOL.md. Pure, the caller resolves DNS.
 * Each listing carries its own domain proof, so any client can check it with one TXT lookup.
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

export const LISTING_KIND = 30402

/** One listing per domain per seller. */
export const LISTING_D_PREFIX = 'fmd:listing:'

/** `t` tag indexers and clients filter on. */
export const LISTING_TOPIC = 'flexmydomain'

/** The only currency written or accepted. USD is display only, so nobody disputes the rate later. */
export const PRICE_CURRENCY = 'SATS'

/** The NIP-99 `status` values we use. */
export type ListingStatus = 'active' | 'sold'

export interface ListingParams {
  pubkey: string
  domain: string
  priceSats: number
  /** One line. The long description goes in `content`. */
  summary?: string
  description?: string
  status?: ListingStatus
  /** Unix seconds. Also the event's created_at unless `createdAt` is given. */
  publishedAt: number
  createdAt?: number
  /** See spec/PROOF.md. */
  proof: ProofRecord
  /** `hash` is sha256 of the RDAP snapshot. */
  rdapSnapshot?: { hash: string; observedAt: number }
  /** Domain registration date. */
  registeredAt?: number
  /** x-only keys the seller accepts as arbiter. */
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
  event: NostrEvent
}

/** Extension tags are `fmd_`-prefixed to stay clear of NIP-99 and other apps. */
export function buildListing(params: ListingParams): UnsignedEvent {
  const domain = normaliseDomain(params.domain)
  if (!isHex32(params.pubkey)) throw new Error('buildListing: pubkey must be 64 lowercase hex characters')
  if (!Number.isInteger(params.priceSats) || params.priceSats <= 0) {
    throw new Error(`buildListing: priceSats must be a positive integer, got ${JSON.stringify(params.priceSats)}`)
  }
  if (params.proof.pubkey !== params.pubkey) {
    // Readers would refuse to show it.
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

/** Structure only. {@link checkListing} decides whether the domain is proven. */
export function parseListing(event: NostrEvent): { ok: true; listing: Listing } | { ok: false; reason: string } {
  if (event.kind !== LISTING_KIND) return { ok: false, reason: `kind ${event.kind} is not ${LISTING_KIND}` }

  const d = tagValue(event, 'd')
  if (!d || !d.startsWith(LISTING_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${LISTING_D_PREFIX}* identifier` }
  }
  const fromD = tryNormaliseDomain(d.slice(LISTING_D_PREFIX.length))
  if (!fromD.ok) return { ok: false, reason: `d tag domain: ${fromD.reason}` }
  if (d !== LISTING_D_PREFIX + fromD.domain) return { ok: false, reason: 'd tag is not in normalised form' }

  // Must match the `d` tag. A mismatch is broken or trying to mislead.
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
      // Always the event's pubkey, so a proof is only checked under the publisher's key.
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
 * What indexers and clients both check before showing a listing. Anyone can publish
 * a 30402 claiming `apple.com`, so all three must hold:
 *
 *   1. the event sig verifies            (the caller does this, relays lie)
 *   2. the embedded proof verifies for this domain and pubkey
 *   3. the domain's DNS agrees           (`dnsProof`, resolved elsewhere)
 *
 * A missing DNS result means unverified, never verified. Unverified listings stay on
 * relays but are never shown as real.
 */
export interface ListingCheck {
  ok: boolean
  reason?: string
  listing?: Listing
  /** Embedded proof sig is valid. */
  selfConsistent: boolean
  /** Only when a supplied DNS (or NIP-05) check passed. */
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

/** checkListing against a freshly resolved TXT RRset, in one call for page code. */
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

/** Shareable naddr, not a URL on any host. */
export function listingAddress(listing: Pick<Listing, 'domain'> & { event: Pick<NostrEvent, 'pubkey'> }, relays?: string[]): string {
  return naddrEncode({
    identifier: LISTING_D_PREFIX + listing.domain,
    pubkey: listing.event.pubkey,
    kind: LISTING_KIND,
    relays,
  })
}

export function listingFilter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kinds: [LISTING_KIND], '#t': [LISTING_TOPIC], ...extra }
}
