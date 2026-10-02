import { toASCII, toUnicode } from './punycode.js'

export const MAX_DOMAIN_LENGTH = 253

/** RFC 1035 section 2.3.4. */
export const MAX_LABEL_LENGTH = 63

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

const TLD_RE = /^[a-z]{2,24}$/

/** RFC 3986 scheme production. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

const PORT_RE = /:\d{1,5}$/

export type NormaliseResult =
  | { ok: true; domain: string; unicode: string }
  | { ok: false; reason: string }

export function tryNormaliseDomain(raw: unknown): NormaliseResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'expected a string' }
  }

  let v = raw.trim()
  if (v === '') return { ok: false, reason: 'empty' }
  if (/\s/.test(v)) return { ok: false, reason: 'contains whitespace' }

  v = v.replace(SCHEME_RE, '')
  v = v.replace(/^\/\//, '')
  v = v.split(/[/?#]/, 1)[0]
  const at = v.lastIndexOf('@')
  if (at !== -1) v = v.slice(at + 1)
  if (v.startsWith('[')) return { ok: false, reason: 'an IPv6 literal is not a domain' }
  v = v.replace(PORT_RE, '')
  if (v === '') return { ok: false, reason: 'no host part' }

  v = v.toLowerCase()

  if (v.endsWith('.')) v = v.slice(0, -1)

  // Step 4: strip leading `www.` labels, never down to a bare TLD (`www.com` is registrable).
  const parts = v.split('.')
  let drop = 0
  while (parts[drop] === 'www' && parts.length - drop > 2) drop++
  if (drop > 0) v = parts.slice(drop).join('.')

  if (v === '') return { ok: false, reason: 'empty after normalisation' }
  if (v.includes('..')) return { ok: false, reason: 'empty label' }

  // Encoding costs length times distinct code points, and an A-label is never shorter than its U-label.
  if ([...v].length > MAX_DOMAIN_LENGTH) {
    return { ok: false, reason: `${[...v].length} characters exceeds the ${MAX_DOMAIN_LENGTH} limit` }
  }
  for (const label of v.split('.')) {
    const points = [...label]
    if (points.length > MAX_LABEL_LENGTH) {
      return { ok: false, reason: `label "${points.slice(0, 20).join('')}…" exceeds ${MAX_LABEL_LENGTH} characters` }
    }
  }

  try {
    v = toASCII(v)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }

  const labels = v.split('.')
  if (labels.length < 2) {
    return { ok: false, reason: `"${v}" is a single label, not a domain` }
  }
  if (v.length > MAX_DOMAIN_LENGTH) {
    return { ok: false, reason: `${v.length} characters exceeds the ${MAX_DOMAIN_LENGTH} limit` }
  }
  for (const label of labels) {
    if (label.length > MAX_LABEL_LENGTH) {
      return { ok: false, reason: `label "${label}" exceeds ${MAX_LABEL_LENGTH} characters` }
    }
    if (!LABEL_RE.test(label)) {
      return { ok: false, reason: `label "${label}" is not a valid hostname label` }
    }
  }
  const tld = labels[labels.length - 1]
  if (!TLD_RE.test(tld)) {
    return { ok: false, reason: `"${tld}" is not a supported top-level domain` }
  }

  return { ok: true, domain: v, unicode: toUnicode(v) }
}

/** Throwing form, for code paths where bad input is a bug, not user typing. */
export function normaliseDomain(raw: unknown): string {
  const r = tryNormaliseDomain(raw)
  if (!r.ok) {
    const shown = typeof raw === 'string' ? JSON.stringify(raw) : Object.prototype.toString.call(raw)
    throw new Error(`normaliseDomain: ${shown} is not a domain: ${r.reason}`)
  }
  return r.domain
}

export function isNormalisedDomain(value: unknown): value is string {
  const r = tryNormaliseDomain(value)
  return r.ok && r.domain === value
}

export function tldOf(domain: string): string {
  const d = normaliseDomain(domain)
  return d.slice(d.lastIndexOf('.') + 1)
}

export function splitDomain(domain: string): [string, string] {
  const d = normaliseDomain(domain)
  const i = d.lastIndexOf('.')
  return [d.slice(0, i), d.slice(i + 1)]
}

export const PROOF_LABEL = '_flexmydomain'

export function proofRecordName(domain: string): string {
  return `${PROOF_LABEL}.${normaliseDomain(domain)}`
}

/** NIP-05 document for the alternative proof. */
export function nip05Url(domain: string, name = '_'): string {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
}
