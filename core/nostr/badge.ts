/**
 * NIP-58 badges: definitions (kind 30009), awards (kind 8) and the profile
 * badge list (kind 30008).
 *
 * Badges let a settled-trade record render in other clients, such as Damus
 * and Amethyst, that will never implement this marketplace's checks. A badge
 * is only its issuer's opinion. The evidence is the trade receipts
 * (receipt.ts), which a reader can verify without trusting the issuer.
 *
 * A badge shows only once the recipient adds it to their own kind 30008 list,
 * so nobody can decorate somebody else's profile.
 */

import { addressOf, isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'

export const BADGE_DEFINITION_KIND = 30009
export const BADGE_AWARD_KIND = 8
export const PROFILE_BADGES_KIND = 30008

/** NIP-58 fixes this identifier; a profile badge list uses no other. */
export const PROFILE_BADGES_D = 'profile_badges'

export interface BadgeDefinition {
  slug: string
  name: string
  description?: string
  image?: string
  thumb?: string
}

/** Define a badge. Addressable, so editing the art does not reissue the award. */
export function buildBadgeDefinition(params: {
  pubkey: string
  badge: BadgeDefinition
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildBadgeDefinition: pubkey must be 64 lowercase hex characters')
  if (!params.badge.slug) throw new Error('buildBadgeDefinition: a badge needs a slug')

  const tags: NostrTag[] = [['d', params.badge.slug], ['name', params.badge.name]]
  if (params.badge.description) tags.push(['description', params.badge.description])
  if (params.badge.image) tags.push(['image', params.badge.image])
  if (params.badge.thumb) tags.push(['thumb', params.badge.thumb])

  return { pubkey: params.pubkey, created_at: params.createdAt, kind: BADGE_DEFINITION_KIND, tags, content: '' }
}

/**
 * Award a badge to one or more keys.
 *
 * Kind 8 is a regular event, so an award cannot be withdrawn by replacing it
 * (the same property that makes a trade receipt evidence). Revoking one takes
 * a NIP-09 deletion request, which relays may ignore.
 */
export function buildBadgeAward(params: {
  pubkey: string
  /** The definition coordinate: `30009:<issuer>:<slug>`. */
  definition: string
  recipients: readonly string[]
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildBadgeAward: pubkey must be 64 lowercase hex characters')
  if (params.recipients.length === 0) throw new Error('buildBadgeAward: no recipients')
  if (!params.definition.startsWith(`${BADGE_DEFINITION_KIND}:`)) {
    throw new Error(`buildBadgeAward: ${JSON.stringify(params.definition)} is not a badge definition coordinate`)
  }

  const tags: NostrTag[] = [['a', params.definition]]
  for (const recipient of params.recipients) {
    if (!isHex32(recipient)) throw new Error(`buildBadgeAward: ${JSON.stringify(recipient)} is not a pubkey`)
    tags.push(['p', recipient])
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: BADGE_AWARD_KIND, tags, content: '' }
}

/**
 * The recipient's own list of badges they choose to display.
 *
 * NIP-58 requires the `a` and `e` tags to come in pairs and in order: each
 * definition coordinate immediately followed by the award event that granted
 * it. A client reading them positionally gets the wrong badge art if they are
 * interleaved any other way, so the pairing is built here rather than left to
 * a caller to remember.
 */
export function buildProfileBadges(params: {
  pubkey: string
  badges: readonly { definition: string; awardId: string }[]
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildProfileBadges: pubkey must be 64 lowercase hex characters')

  const tags: NostrTag[] = [['d', PROFILE_BADGES_D]]
  for (const badge of params.badges) {
    if (!isHex32(badge.awardId)) throw new Error('buildProfileBadges: an award id must be 64 lowercase hex characters')
    tags.push(['a', badge.definition], ['e', badge.awardId])
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: PROFILE_BADGES_KIND, tags, content: '' }
}

/** Read a badge definition. */
export function parseBadgeDefinition(event: NostrEvent): (BadgeDefinition & { issuer: string; address: string }) | undefined {
  if (event.kind !== BADGE_DEFINITION_KIND) return undefined
  const slug = tagValue(event, 'd')
  const name = tagValue(event, 'name')
  if (!slug || !name) return undefined
  return {
    slug,
    name,
    description: tagValue(event, 'description'),
    image: tagValue(event, 'image'),
    thumb: tagValue(event, 'thumb'),
    issuer: event.pubkey,
    address: addressOf(event),
  }
}

/** Read an award: which badge, to whom, from whom. */
export function parseBadgeAward(event: NostrEvent): { definition: string; issuer: string; recipients: string[] } | undefined {
  if (event.kind !== BADGE_AWARD_KIND) return undefined
  const definition = tagValue(event, 'a')
  if (!definition) return undefined
  return {
    definition,
    issuer: event.pubkey,
    recipients: event.tags.filter((t) => t[0] === 'p' && isHex32(t[1])).map((t) => t[1]),
  }
}

/**
 * Read a profile badge list, as ordered pairs.
 *
 * A trailing `a` with no `e`, or the reverse, is dropped rather than guessed
 * at: a half-pair names a badge with no evidence it was ever awarded.
 */
export function parseProfileBadges(event: NostrEvent): { definition: string; awardId: string }[] {
  if (event.kind !== PROFILE_BADGES_KIND) return []
  if (tagValue(event, 'd') !== PROFILE_BADGES_D) return []

  const pairs: { definition: string; awardId: string }[] = []
  const tags = event.tags.filter((t) => t[0] === 'a' || t[0] === 'e')
  for (let i = 0; i < tags.length - 1; i++) {
    if (tags[i][0] === 'a' && tags[i + 1][0] === 'e' && tags[i][1] && isHex32(tags[i + 1][1])) {
      pairs.push({ definition: tags[i][1], awardId: tags[i + 1][1] })
      i++
    }
  }
  return pairs
}

/**
 * Which displayed badges are backed by an award to this key.
 *
 * A kind 30008 is self-published, so it says only "I would like these shown".
 * Without this check a key can display any badge, including ones it was never
 * awarded.
 */
export function verifiedBadges(params: {
  pubkey: string
  profile: NostrEvent
  awards: readonly NostrEvent[]
}): { definition: string; awardId: string; issuer: string }[] {
  const claimed = parseProfileBadges(params.profile)
  const byId = new Map(params.awards.map((a) => [a.id, a]))

  const out: { definition: string; awardId: string; issuer: string }[] = []
  for (const claim of claimed) {
    const award = byId.get(claim.awardId)
    if (!award) continue
    const parsed = parseBadgeAward(award)
    if (!parsed) continue
    if (parsed.definition !== claim.definition) continue
    if (!parsed.recipients.includes(params.pubkey)) continue
    // The issuer must be the definition's author, or anyone could award
    // somebody else's badge.
    if (!claim.definition.startsWith(`${BADGE_DEFINITION_KIND}:${parsed.issuer}:`)) continue
    out.push({ ...claim, issuer: parsed.issuer })
  }
  return out
}

/** The badges this marketplace issues. Slugs are stable; the art is not. */
export const FMD_BADGES = {
  verifiedSale: {
    slug: 'fmd-verified-sale',
    name: 'Verified domain sale',
    description:
      'Settled a domain sale through a non-custodial escrow, with both trade receipts agreeing and a registry transfer observed in RDAP.',
  },
  provenHolder: {
    slug: 'fmd-proven-holder',
    name: 'Proven domain holder',
    description: 'Published a DNS proof of control for at least one domain, verified against two independent resolvers.',
  },
} as const
