/**
 * The portfolio: NIP-78 kind 30078, `d = "fmd:portfolio"`.
 *
 * One replaceable event per user holds every domain they have proven, each
 * with its proof, so a flex page renders from one fetch with no server
 * involved.
 *
 * Every entry carries its own `iat` and signature, so a reader verifies each
 * domain against the event's pubkey offline, without DNS. DNS adds the live
 * half: whether the zone still agrees today. This file keeps the two answers
 * separate, because merging them would show a stale claim as verified.
 */

import { proofDigest, PROOF_VERSION, type ProofRecord } from '../oracle/proof.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'
import {
  isHex32,
  isHex64,
  tagValue,
  verifyDigestSignature,
  type NostrEvent,
  type UnsignedEvent,
} from './event.js'

export const PORTFOLIO_KIND = 30078
export const PORTFOLIO_D = 'fmd:portfolio'
export const PORTFOLIO_TOPIC = 'flexmydomain'

/** The content format version. Bump it when the JSON shape changes. */
export const PORTFOLIO_VERSION = 1

/** Which oracle was used when the entry was added. spec/PROOF.md section 7. */
export type ProofSource = 'dns' | 'nip05'

export interface PortfolioEntry {
  domain: string
  /** Unix seconds inside the signed proof. Absent for a NIP-05-only entry. */
  iat?: number
  /** The 64-byte BIP-340 signature, hex. Absent for a NIP-05-only entry. */
  sig?: string
  source: ProofSource
  /** When this holder first proved the domain, by their own clock. */
  firstSeen: number
  /** Optional one-liner shown on the card. */
  tagline?: string
  /** Is it listed for sale? A rendering hint; the listing event is the truth. */
  forSale?: boolean
}

export interface Portfolio {
  version: number
  pubkey: string
  entries: PortfolioEntry[]
  event?: NostrEvent
}

/**
 * Build the event a holder signs.
 *
 * Entries are sorted by domain so that re-publishing an unchanged portfolio
 * produces identical bytes. Otherwise every save would write a new event id to
 * five relays, filling the user's history with events that say nothing new.
 */
export function buildPortfolio(params: {
  pubkey: string
  entries: PortfolioEntry[]
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildPortfolio: pubkey must be 64 lowercase hex characters')

  const seen = new Set<string>()
  const entries = params.entries.map((entry) => {
    const domain = normaliseDomain(entry.domain)
    if (seen.has(domain)) throw new Error(`buildPortfolio: ${domain} appears twice`)
    seen.add(domain)
    if (entry.source === 'dns') {
      if (entry.iat === undefined || !isHex64(entry.sig ?? '')) {
        throw new Error(`buildPortfolio: the DNS entry for ${domain} has no proof attached`)
      }
      // Refuse to publish a claim that cannot verify. A portfolio full of
      // entries that fail on the reader's machine is worse than an empty one.
      const digest = proofDigest({ domain, pubkey: params.pubkey, iat: entry.iat })
      if (!verifyDigestSignature(entry.sig as string, digest, params.pubkey)) {
        throw new Error(`buildPortfolio: the proof for ${domain} does not verify under this key`)
      }
    }
    return { ...entry, domain }
  })
  entries.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: PORTFOLIO_KIND,
    tags: [
      ['d', PORTFOLIO_D],
      ['t', PORTFOLIO_TOPIC],
    ],
    content: JSON.stringify({
      v: PORTFOLIO_VERSION,
      domains: entries.map((e) => ({
        domain: e.domain,
        source: e.source,
        first_seen: e.firstSeen,
        ...(e.iat !== undefined ? { iat: e.iat } : {}),
        ...(e.sig !== undefined ? { sig: e.sig } : {}),
        ...(e.tagline ? { tagline: e.tagline } : {}),
        ...(e.forSale ? { for_sale: true } : {}),
      })),
    }),
  }
}

/**
 * Read a portfolio out of an event.
 *
 * Tolerant of unknown fields and of a future `v`, because a reader running old
 * code should still render the domains it understands rather than an error
 * page. Intolerant of a malformed entry, which is dropped with a reason.
 */
export function parsePortfolio(
  event: NostrEvent,
): { ok: true; portfolio: Portfolio; dropped: { entry: unknown; reason: string }[] } | { ok: false; reason: string } {
  if (event.kind !== PORTFOLIO_KIND) return { ok: false, reason: `kind ${event.kind} is not ${PORTFOLIO_KIND}` }
  if (tagValue(event, 'd') !== PORTFOLIO_D) {
    return { ok: false, reason: `d tag ${JSON.stringify(tagValue(event, 'd') ?? null)} is not ${PORTFOLIO_D}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(event.content)
  } catch (err) {
    return { ok: false, reason: `content is not JSON: ${(err as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'content is not an object' }

  const body = parsed as { v?: unknown; domains?: unknown }
  const list = Array.isArray(body.domains) ? body.domains : []
  const entries: PortfolioEntry[] = []
  const dropped: { entry: unknown; reason: string }[] = []

  for (const raw of list) {
    const entry = readEntry(raw)
    if ('reason' in entry) dropped.push({ entry: raw, reason: entry.reason })
    else entries.push(entry.entry)
  }

  return {
    ok: true,
    portfolio: {
      version: typeof body.v === 'number' ? body.v : 0,
      pubkey: event.pubkey,
      entries,
      event,
    },
    dropped,
  }
}

function readEntry(raw: unknown): { entry: PortfolioEntry } | { reason: string } {
  if (typeof raw !== 'object' || raw === null) return { reason: 'not an object' }
  const e = raw as Record<string, unknown>

  const domain = tryNormaliseDomain(e.domain)
  if (!domain.ok) return { reason: `domain: ${domain.reason}` }

  const source: ProofSource = e.source === 'nip05' ? 'nip05' : 'dns'
  const iat = typeof e.iat === 'number' && Number.isSafeInteger(e.iat) ? e.iat : undefined
  const sig = isHex64(e.sig) ? (e.sig as string) : undefined
  if (source === 'dns' && (iat === undefined || sig === undefined)) {
    return { reason: 'a DNS entry with no proof attached' }
  }

  const firstSeen = typeof e.first_seen === 'number' && Number.isSafeInteger(e.first_seen) ? e.first_seen : iat ?? 0

  return {
    entry: {
      domain: domain.domain,
      source,
      iat,
      sig,
      firstSeen,
      tagline: typeof e.tagline === 'string' ? e.tagline : undefined,
      forSale: e.for_sale === true,
    },
  }
}

/** One entry's verdict. `proven` is offline-only; the zone is checked live. */
export interface EntryVerification {
  domain: string
  /** The signature in the entry verifies for this domain under this pubkey. */
  proven: boolean
  reason?: string
  record?: ProofRecord
}

/**
 * Verify every entry against the portfolio's own pubkey, offline.
 *
 * This is all a reader can conclude with no network: "the holder of this key
 * signed a claim to these domains, at these times". It does not say the zones
 * still agree, and a renderer must not present it as if it did. Re-resolve,
 * and show a claim whose record has vanished as stale rather than hiding it.
 */
export function verifyPortfolio(portfolio: Portfolio): EntryVerification[] {
  return portfolio.entries.map((entry) => {
    if (entry.source === 'nip05') {
      return {
        domain: entry.domain,
        proven: false,
        reason: 'a NIP-05 proof carries no signature and can only be checked live',
      }
    }
    if (entry.iat === undefined || entry.sig === undefined) {
      return { domain: entry.domain, proven: false, reason: 'no proof attached' }
    }
    const digest = proofDigest({ domain: entry.domain, pubkey: portfolio.pubkey, iat: entry.iat })
    const proven = verifyDigestSignature(entry.sig, digest, portfolio.pubkey)
    return {
      domain: entry.domain,
      proven,
      reason: proven ? undefined : 'signature does not verify under this portfolio key',
      record: proven
        ? { version: PROOF_VERSION, iat: entry.iat, pubkey: portfolio.pubkey, sig: entry.sig }
        : undefined,
    }
  })
}

/**
 * Add or replace one domain, preserving `firstSeen`.
 *
 * Re-proving a domain must not reset the date it was first held. That date is
 * the only number on a flex page that cannot be manufactured on the spot.
 */
export function upsertEntry(entries: readonly PortfolioEntry[], entry: PortfolioEntry): PortfolioEntry[] {
  const domain = normaliseDomain(entry.domain)
  const existing = entries.find((e) => e.domain === domain)
  const merged: PortfolioEntry = {
    ...entry,
    domain,
    firstSeen: existing ? Math.min(existing.firstSeen, entry.firstSeen) : entry.firstSeen,
  }
  return [...entries.filter((e) => e.domain !== domain), merged].sort((a, b) =>
    a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0,
  )
}

/** Remove a domain. Dropping a name from a portfolio is not a deletion request. */
export function removeEntry(entries: readonly PortfolioEntry[], domain: string): PortfolioEntry[] {
  const d = normaliseDomain(domain)
  return entries.filter((e) => e.domain !== d)
}

/** The filter that fetches one holder's portfolio. */
export function portfolioFilter(pubkey: string): Record<string, unknown> {
  return { kinds: [PORTFOLIO_KIND], authors: [pubkey], '#d': [PORTFOLIO_D], limit: 1 }
}
