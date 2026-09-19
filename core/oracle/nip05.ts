/**
 * NIP-05 as an alternative proof of domain control (spec/PROOF.md section 7).
 *
 * Pure: this module parses a `/.well-known/nostr.json` document fetched
 * elsewhere (`fetchNip05` in net/dns.ts).
 *
 * A Nostr-native seller usually has a NIP-05 identity already, and asking them
 * for a TXT record as well would be busywork.
 *
 * It is not the same claim as the TXT record, which proves control of the
 * zone. A NIP-05 document proves control of the web server at that name, a
 * capability sometimes held by a different person, and one a CDN or a hosting
 * account can grant with no DNS access at all. Both are evidence: label which
 * one was used, and never present one as the other.
 */

import { isHex32 } from '../nostr/event.js'
import { normaliseDomain, tryNormaliseDomain } from './domain.js'

/** NIP-05's "root" name. `_@example.com` displays as bare `example.com`. */
export const ROOT_NAME = '_'

/** The document NIP-05 defines. Anything else in the JSON is ignored. */
export interface Nip05Document {
  names?: Record<string, string>
  relays?: Record<string, string[]>
}

/**
 * The URL to fetch. `name` defaults to `_`, the identifier that stands for
 * the domain itself.
 *
 * The request must not carry credentials, and it is read cross-origin: NIP-05
 * requires the document to be served with `Access-Control-Allow-Origin: *`,
 * and a domain that does not is not offering this proof.
 */
export function nip05DocumentUrl(domain: string, name: string = ROOT_NAME): string {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
}

/** Split `name@example.com`, or a bare `example.com`, into its two halves. */
export function parseNip05Identifier(
  raw: unknown,
): { ok: true; name: string; domain: string; identifier: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' }
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return { ok: false, reason: 'empty' }

  const at = trimmed.lastIndexOf('@')
  const name = at === -1 ? ROOT_NAME : trimmed.slice(0, at)
  const domainPart = at === -1 ? trimmed : trimmed.slice(at + 1)

  // NIP-05 restricts local parts to this set, so an identifier can go into a
  // URL query without escaping.
  if (!/^[a-z0-9\-_.]+$/.test(name)) {
    return { ok: false, reason: `"${name}" is not a valid NIP-05 local part` }
  }
  const domain = tryNormaliseDomain(domainPart)
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }

  return { ok: true, name, domain: domain.domain, identifier: `${name}@${domain.domain}` }
}

/**
 * Which names in this document map to `pubkey`.
 *
 * Returns every match rather than a boolean: any name that maps to the key
 * counts, and the UI shows which identifier backed the proof. Only the pubkey
 * side is compared case-insensitively, because NIP-05 names are case-sensitive
 * and hex pubkeys are not.
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

/** The verdict, in the same shape the TXT verifier returns. */
export interface Nip05Verification {
  ok: boolean
  reason?: string
  /** Every name that mapped to this key; `_` first when it is among them. */
  names?: string[]
  /** The identifier to show a human: `_@example.com` renders as the domain. */
  identifier?: string
}

/**
 * Verify a fetched document proves `pubkey` controls `domain`.
 *
 * There is no timestamp, and there cannot be one: a NIP-05 document says only
 * what is true when it is fetched. That is a reason to re-poll it, and the
 * reason a listing backed only by NIP-05 should say so.
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
 * Relay hints NIP-05 lets a document publish for a key.
 *
 * Useful even when the proof fails: these are relays the domain's operator
 * says the key writes to, a seed for the outbox model before any NIP-65 relay
 * list has been found. They are hints, never authority.
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
