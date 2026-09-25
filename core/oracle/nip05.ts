/**
 * NIP-05 as an alternative domain proof (spec/PROOF.md section 7). Parsing only,
 * `fetchNip05` in net/dns.ts fetches. It proves web server control, which a CDN or
 * host can grant without DNS access. Label it, never pass it off as a TXT proof.
 */

import { isHex32 } from '../nostr/event.js'
import { normaliseDomain, tryNormaliseDomain } from './domain.js'

/** NIP-05 root name. `_@example.com` shows as bare `example.com`. */
export const ROOT_NAME = '_'

/** Other JSON fields are ignored. */
export interface Nip05Document {
  names?: Record<string, string>
  relays?: Record<string, string[]>
}

/**
 * Fetch without credentials. NIP-05 requires `Access-Control-Allow-Origin: *`,
 * and a domain that doesn't send it isn't offering this proof.
 */
export function nip05DocumentUrl(domain: string, name: string = ROOT_NAME): string {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
}

/** Takes `name@example.com` or a bare `example.com`. */
export function parseNip05Identifier(
  raw: unknown,
): { ok: true; name: string; domain: string; identifier: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' }
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return { ok: false, reason: 'empty' }

  const at = trimmed.lastIndexOf('@')
  const name = at === -1 ? ROOT_NAME : trimmed.slice(0, at)
  const domainPart = at === -1 ? trimmed : trimmed.slice(at + 1)

  // NIP-05 local-part charset. Safe in a URL query unescaped.
  if (!/^[a-z0-9\-_.]+$/.test(name)) {
    return { ok: false, reason: `"${name}" is not a valid NIP-05 local part` }
  }
  const domain = tryNormaliseDomain(domainPart)
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }

  return { ok: true, name, domain: domain.domain, identifier: `${name}@${domain.domain}` }
}

/**
 * Every name mapping to `pubkey`, so the UI can show which one backed the proof.
 * Only the hex pubkey matches case-insensitively. NIP-05 names are case-sensitive.
 */
export function namesForPubkey(document: unknown, pubkey: string): string[] {
  if (!isHex32(pubkey)) return []
  if (typeof document !== 'object' || document === null) return []
  const names = (document as Nip05Document).names
  if (typeof names !== 'object' || names === null) return []

  const matches: string[] = []
  for (const [name, value] of Object.entries(names)) {
    if (typeof value === 'string' && value.toLowerCase() === pubkey) matches.push(name)
  }
  return matches
}

/** Same shape as the TXT verdict. */
export interface Nip05Verification {
  ok: boolean
  reason?: string
  /** `_` first when present. */
  names?: string[]
  /** For display. The root name renders as the bare domain. */
  identifier?: string
}

/**
 * No timestamp is possible, the document only speaks for the moment it was fetched.
 * Re-poll it, and label listings backed only by NIP-05.
 */
export function verifyNip05(params: { domain: string; pubkey: string; document: unknown }): Nip05Verification {
  const domain = tryNormaliseDomain(params.domain)
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }
  if (!isHex32(params.pubkey)) return { ok: false, reason: 'pubkey is not 64 lowercase hex characters' }

  const names = namesForPubkey(params.document, params.pubkey)
  if (names.length === 0) {
    return { ok: false, reason: 'no name in this document maps to that pubkey' }
  }

  const ordered = names.includes(ROOT_NAME) ? [ROOT_NAME, ...names.filter((n) => n !== ROOT_NAME)] : names
  const best = ordered[0]
  return {
    ok: true,
    names: ordered,
    identifier: best === ROOT_NAME ? domain.domain : `${best}@${domain.domain}`,
  }
}

/**
 * NIP-05 relay hints for a key. Useful even if the proof fails, as an outbox seed
 * before any NIP-65 list turns up. Hints only, never authority.
 */
export function relayHints(document: unknown, pubkey: string): string[] {
  if (!isHex32(pubkey)) return []
  if (typeof document !== 'object' || document === null) return []
  const relays = (document as Nip05Document).relays
  if (typeof relays !== 'object' || relays === null) return []
  const list = (relays as Record<string, unknown>)[pubkey]
  if (!Array.isArray(list)) return []
  return list.filter((r): r is string => typeof r === 'string' && /^wss?:\/\//i.test(r))
}
