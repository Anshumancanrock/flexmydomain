// Portfolio, NIP-78 kind 30078 with d = "fmd:portfolio".

import { isValidIat, proofDigest, PROOF_VERSION, type ProofRecord } from '../oracle/proof.js'
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

export const PORTFOLIO_VERSION = 1

const FIRST_REGISTRATION = 479_692_800

export type ProofSource = 'dns' | 'nip05'

export interface PortfolioEntry {
  domain: string
  /** Unix seconds from the signed proof. Absent for NIP-05 entries. */
  iat?: number
  /** 64-byte BIP-340 signature, hex. Absent for NIP-05 entries. */
  sig?: string
  source: ProofSource
  firstSeen: number
  tagline?: string
  /** Rendering hint only. The listing event is the truth. */
  forSale?: boolean
}

export interface Portfolio {
  version: number
  pubkey: string
  entries: PortfolioEntry[]
  event?: NostrEvent
}

/** Sorted by domain, so re-publishing an unchanged portfolio gives the same bytes and event id. */
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
      // Refuse what can't verify. A failing entry on the reader's machine is worse than none.
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
  if (!Array.isArray(body.domains)) dropped.push({ entry: body.domains ?? null, reason: 'no domains list' })

  for (const raw of list) {
    const entry = readEntry(raw, event.created_at)
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

function readEntry(raw: unknown, createdAt: number): { entry: PortfolioEntry } | { reason: string } {
  if (typeof raw !== 'object' || raw === null) return { reason: 'not an object' }
  const e = raw as Record<string, unknown>

  const domain = tryNormaliseDomain(e.domain)
  if (!domain.ok) return { reason: `domain: ${domain.reason}` }

  // No source means DNS, the original kind. Another one is a proof this code can't check.
  if (e.source !== undefined && e.source !== 'dns' && e.source !== 'nip05') {
    return { reason: `unknown proof source ${String(JSON.stringify(e.source)).slice(0, 40)}` }
  }
  const source: ProofSource = e.source === 'nip05' ? 'nip05' : 'dns'
  if (e.iat !== undefined && !isValidIat(e.iat)) return { reason: 'iat is not a timestamp a proof record can carry' }
  const iat = isValidIat(e.iat) ? e.iat : undefined
  const sig = isHex64(e.sig) ? (e.sig as string) : undefined
  if (source === 'dns' && (iat === undefined || sig === undefined)) {
    return { reason: 'a DNS entry with no proof attached' }
  }

  const plausible = (t: unknown): t is number =>
    Number.isSafeInteger(t) && (t as number) >= FIRST_REGISTRATION && (t as number) <= createdAt
  const firstSeen = [e.first_seen, iat].find(plausible) ?? createdAt

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

/** `proven` is offline only. The zone is checked live. */
export interface EntryVerification {
  domain: string
  proven: boolean
  reason?: string
  record?: ProofRecord
}

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

export function removeEntry(entries: readonly PortfolioEntry[], domain: string): PortfolioEntry[] {
  const d = normaliseDomain(domain)
  return entries.filter((e) => e.domain !== d)
}

export function portfolioFilter(pubkey: string): Record<string, unknown> {
  return { kinds: [PORTFOLIO_KIND], authors: [pubkey], '#d': [PORTFOLIO_D], limit: 1 }
}
