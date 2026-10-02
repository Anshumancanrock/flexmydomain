// Who somebody is. Kind 0 profiles with NIP-39 identities, the NIP-89 handler, NIP-51 lists.

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { LISTING_KIND } from './listing.js'

export const PROFILE_KIND = 0
export const HANDLER_KIND = 31990
export const FOLLOW_SET_KIND = 30000

/** NIP-51 follow set of the arbiters a key will trade under. */
export const ARBITER_SET_D = 'fmd:arbiters'

/** NIP-51 set of domains a key is watching. */
export const WATCHLIST_D = 'fmd:watchlist'

export interface Profile {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  /** Evidence of a domain only once verified. */
  nip05?: string
  lud16?: string
  website?: string
  identities: ExternalIdentity[]
}

/** NIP-39 self-attested link to an account elsewhere. */
export interface ExternalIdentity {
  platform: string
  identity: string
  proof?: string
}

/** Checks nothing, it is all self-attested. `nip05` and NIP-39 identities are claims until their proofs are fetched. */
export function parseProfile(event: NostrEvent): Profile | undefined {
  if (event.kind !== PROFILE_KIND) return undefined

  let body: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(event.content)
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    // Still identifies a key, and the tags may carry NIP-39 identities.
  }

  const str = (key: string): string | undefined => (typeof body[key] === 'string' ? (body[key] as string) : undefined)

  return {
    pubkey: event.pubkey,
    name: str('name'),
    displayName: str('display_name') ?? str('displayName'),
    about: str('about'),
    picture: str('picture'),
    nip05: str('nip05'),
    lud16: str('lud16'),
    website: str('website'),
    identities: event.tags
      .filter((t) => t[0] === 'i' && typeof t[1] === 'string' && t[1].includes(':'))
      .map((t) => {
        const at = t[1].indexOf(':')
        return { platform: t[1].slice(0, at), identity: t[1].slice(at + 1), proof: t[2] }
      }),
  }
}

/** A URL for a person to open. Most platforms send no CORS headers, so the browser can't check. */
export function identityProofUrl(identity: ExternalIdentity): string | undefined {
  if (!identity.proof) return undefined
  switch (identity.platform) {
    case 'github': return `https://gist.github.com/${identity.identity}/${identity.proof}`
    case 'twitter': case 'x': return `https://twitter.com/${identity.identity}/status/${identity.proof}`
    case 'mastodon': return `https://${identity.proof}`
    case 'telegram': return `https://t.me/${identity.proof}`
    default: return undefined
  }
}

/** NIP-89 kind 31990. Tells other clients how to hand us a kind 30402. */
export function buildHandlerAdvertisement(params: {
  pubkey: string
  /** Has a `<bech32>` placeholder the opening client fills with the NIP-19 entity. */
  webUrl: string
  name: string
  about: string
  kinds?: readonly number[]
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildHandlerAdvertisement: pubkey must be 64 lowercase hex characters')

  const tags: NostrTag[] = [['d', 'fmd-client']]
  for (const kind of params.kinds ?? [LISTING_KIND]) tags.push(['k', String(kind)])
  tags.push(['web', params.webUrl, 'naddr'])

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: HANDLER_KIND,
    tags,
    content: JSON.stringify({ name: params.name, about: params.about }),
  }
}

/** An empty list accepts no arbiter, so that side can open no escrow, since every escrow needs one. */
export function buildArbiterSet(params: {
  pubkey: string
  arbiters: readonly string[]
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildArbiterSet: pubkey must be 64 lowercase hex characters')

  const tags: NostrTag[] = [['d', ARBITER_SET_D], ['title', 'Arbiters I accept']]
  for (const arbiter of params.arbiters) {
    if (!isHex32(arbiter)) throw new Error(`buildArbiterSet: ${JSON.stringify(arbiter)} is not an x-only pubkey`)
    tags.push(['p', arbiter])
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: FOLLOW_SET_KIND, tags, content: '' }
}

export function parseArbiterSet(event: NostrEvent): string[] | undefined {
  if (event.kind !== FOLLOW_SET_KIND) return undefined
  if (tagValue(event, 'd') !== ARBITER_SET_D) return undefined
  return event.tags.filter((t) => t[0] === 'p' && isHex32(t[1])).map((t) => t[1])
}

/** Arbiters both sides accept. Empty means no escrow between them: say so, never fall back to anyone else. */
export function arbiterIntersection(
  buyer: readonly string[] | undefined,
  seller: readonly string[] | undefined,
  defaults: readonly string[] = [],
  parties: readonly string[] = [],
): { arbiters: string[] } {
  const sellerSet = new Set(seller ?? defaults)
  return { arbiters: [...new Set(buyer ?? defaults)].filter((a) => sellerSet.has(a) && !parties.includes(a)) }
}

export function buildWatchlist(params: {
  pubkey: string
  domains: readonly string[]
  createdAt: number
}): UnsignedEvent {
  const tags: NostrTag[] = [['d', WATCHLIST_D], ['title', 'Domains I am watching']]
  for (const domain of params.domains) tags.push(['t', domain])
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: FOLLOW_SET_KIND, tags, content: '' }
}

export function parseWatchlist(event: NostrEvent): string[] | undefined {
  if (event.kind !== FOLLOW_SET_KIND) return undefined
  if (tagValue(event, 'd') !== WATCHLIST_D) return undefined
  return event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1])
}

export function profileFilter(pubkeys: readonly string[]): Record<string, unknown>[] {
  return [
    { kinds: [PROFILE_KIND], authors: [...pubkeys] },
    { kinds: [FOLLOW_SET_KIND], authors: [...pubkeys], '#d': [ARBITER_SET_D, WATCHLIST_D] },
  ]
}
