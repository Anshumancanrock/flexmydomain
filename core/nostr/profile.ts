/**
 * Profiles and the small events about who somebody is: NIP-01 kind 0, NIP-39
 * external identities, the NIP-89 handler advertisement and NIP-51 lists.
 */

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { LISTING_KIND } from './listing.js'

export const PROFILE_KIND = 0
export const HANDLER_KIND = 31990
export const FOLLOW_SET_KIND = 30000

/** The NIP-51 follow set naming the arbiters a key will trade under. */
export const ARBITER_SET_D = 'fmd:arbiters'

/** The NIP-51 set naming domains a key is watching. */
export const WATCHLIST_D = 'fmd:watchlist'

// ---------------------------------------------------------------------------
// kind 0 and NIP-39
// ---------------------------------------------------------------------------

export interface Profile {
  pubkey: string
  name?: string
  displayName?: string
  about?: string
  picture?: string
  /** NIP-05 identifier. Evidence of a domain only once verified. */
  nip05?: string
  /** A lightning address, for zaps. */
  lud16?: string
  website?: string
  identities: ExternalIdentity[]
}

/** NIP-39: a self-attested link to an account elsewhere. */
export interface ExternalIdentity {
  platform: string
  identity: string
  /** The proof: a gist id, a tweet id or a URL, depending on the platform. */
  proof?: string
}

/**
 * Read a kind 0.
 *
 * Everything here is self-attested, and this function checks none of it. A
 * `nip05` field is a claim until the document at that domain is fetched and
 * found to name this key; a NIP-39 identity is a claim until the proof on the
 * named platform is fetched. Neither may be rendered as verified before that.
 */
export function parseProfile(event: NostrEvent): Profile | undefined {
  if (event.kind !== PROFILE_KIND) return undefined

  let body: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(event.content)
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    // A kind 0 with unparseable content still identifies a key, and the tags
    // may still carry NIP-39 identities. Return what is readable.
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

/**
 * Where to look to check a NIP-39 claim.
 *
 * Returned as a URL for a person to open rather than fetched here: most of
 * these platforms send no CORS headers, so a browser cannot verify them. Show
 * the reader where to look and label the claim unverified.
 */
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

// ---------------------------------------------------------------------------
// NIP-89
// ---------------------------------------------------------------------------

/**
 * Advertise that this client can open domain listings (NIP-89 kind 31990).
 *
 * Other clients learn how to hand a kind 30402 to this one, and a user can
 * just as easily pick a different client for the same events.
 */
export function buildHandlerAdvertisement(params: {
  pubkey: string
  /**
   * Where this client is hosted, with a `<bech32>` placeholder that the
   * opening client replaces with the NIP-19 entity.
   */
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

// ---------------------------------------------------------------------------
// NIP-51 lists
// ---------------------------------------------------------------------------

/**
 * The arbiters this key will trade under.
 *
 * An empty list differs from no list: it says "I will trade with no arbiter
 * at all". A client must not substitute a default in either case. The parties
 * choose the arbiter, and a default arbiter nominated by the site would choose
 * for them.
 */
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

/** Read an arbiter set. Returns undefined when this key has published none. */
export function parseArbiterSet(event: NostrEvent): string[] | undefined {
  if (event.kind !== FOLLOW_SET_KIND) return undefined
  if (tagValue(event, 'd') !== ARBITER_SET_D) return undefined
  return event.tags.filter((t) => t[0] === 'p' && isHex32(t[1])).map((t) => t[1])
}

/**
 * The arbiters both parties accept.
 *
 * An empty intersection means no trade, and a UI must say so rather than fall
 * back to a default. Where a party has published no list at all, they have
 * expressed no constraint, so the other party's list stands.
 */
export function arbiterIntersection(
  buyer: readonly string[] | undefined,
  seller: readonly string[] | undefined,
): { arbiters: string[]; noArbiterPossible: boolean } {
  if (buyer === undefined && seller === undefined) return { arbiters: [], noArbiterPossible: true }
  if (buyer === undefined) return { arbiters: [...(seller ?? [])], noArbiterPossible: (seller ?? []).length === 0 }
  if (seller === undefined) return { arbiters: [...buyer], noArbiterPossible: buyer.length === 0 }

  const sellerSet = new Set(seller)
  const arbiters = buyer.filter((a) => sellerSet.has(a))
  // Both published, and both published empty: they agree on no arbiter.
  return { arbiters, noArbiterPossible: buyer.length === 0 && seller.length === 0 }
}

/** A watchlist of domains. Plain `t` tags, so any client can read it. */
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

/** The filter that fetches a key's profile and its lists in one query. */
export function profileFilter(pubkeys: readonly string[]): Record<string, unknown>[] {
  return [
    { kinds: [PROFILE_KIND], authors: [...pubkeys] },
    { kinds: [FOLLOW_SET_KIND], authors: [...pubkeys], '#d': [ARBITER_SET_D, WATCHLIST_D] },
  ]
}
