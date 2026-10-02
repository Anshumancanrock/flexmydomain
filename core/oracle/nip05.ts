// NIP-05 as an alternative domain proof (spec/PROOF.md section 7). Parsing only, `fetchNip05` in net/dns.ts fetches.

import { isHex32 } from '../nostr/event.js'
import { normaliseDomain, tryNormaliseDomain } from './domain.js'

/** NIP-05 root name. `_@example.com` shows as bare `example.com`. */
export const ROOT_NAME = '_'

export interface Nip05Document {
  names?: Record<string, string>
  relays?: Record<string, string[]>
}

export function nip05DocumentUrl(domain: string, name: string = ROOT_NAME): string {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
}

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

export interface Nip05Verification {
  ok: boolean
  reason?: string
  names?: string[]
  identifier?: string
}

/** Only the root name `_` speaks for the domain. */
export function verifyNip05(params: { domain: string; pubkey: string; document: unknown }): Nip05Verification {
  const domain = tryNormaliseDomain(params.domain)
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }
  if (!isHex32(params.pubkey)) return { ok: false, reason: 'pubkey is not 64 lowercase hex characters' }

  const names = namesForPubkey(params.document, params.pubkey)
  if (!names.includes(ROOT_NAME)) {
    return {
      ok: false,
      reason: names.length === 0
        ? 'no name in this document maps to that pubkey'
        : `the document maps ${names.map((n) => `${n}@${domain.domain}`).join(', ')} to that pubkey, but only _@${domain.domain} speaks for the domain`,
    }
  }

  return {
    ok: true,
    names: [ROOT_NAME, ...names.filter((n) => n !== ROOT_NAME)],
    identifier: domain.domain,
  }
}

/** NIP-05 relay hints for a key. Useful even if the proof fails, as an outbox seed before any NIP-65 list turns up. */
export function relayHints(document: unknown, pubkey: string): string[] {
  if (!isHex32(pubkey)) return []
  if (typeof document !== 'object' || document === null) return []
  const relays = (document as Nip05Document).relays
  if (typeof relays !== 'object' || relays === null) return []
  const list = (relays as Record<string, unknown>)[pubkey]
  if (!Array.isArray(list)) return []
  return list.filter((r): r is string => typeof r === 'string' && /^wss?:\/\//i.test(r))
}
