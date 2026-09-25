/**
 * Domain normalisation, spec/PROOF.md section 4. The spec wins if they disagree.
 * The output goes into the signed message and both signer and verifier call this.
 * Any drift between them fails verification with no clue why.
 */

import { toASCII, toUnicode } from './punycode.js'

/** In text form (spec section 4, step 6). */
export const MAX_DOMAIN_LENGTH = 253

/** RFC 1035 section 2.3.4. */
export const MAX_LABEL_LENGTH = 63

/**
 * Normalised LDH label, no edge hyphens. Not `\w`, because `_` is legal in a TXT
 * owner name (`_flexmydomain`) but not in a hostname label.
 */
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Spec section 4, step 6. */
const TLD_RE = /^[a-z]{2,24}$/

/** RFC 3986 scheme production. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

const PORT_RE = /:\d{1,5}$/

/** Non-throwing form for the UI, which validates on every keystroke. */
export type NormaliseResult =
  | { ok: true; domain: string; unicode: string }
  | { ok: false; reason: string }

/**
 * Canonical domain from whatever people paste. Steps below follow spec section 4.
 *
 *   'https://www.MyShop.io/pricing?x=1'  ->  'myshop.io'
 *   'MÜNCHEN.de'                          ->  'xn--mnchen-3ya.de'
 *   'example.com.'                        ->  'example.com'
 */
export function tryNormaliseDomain(raw: unknown): NormaliseResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'expected a string' }
  }

  // Step 1: trim, and reject inner whitespace. `my shop.io` is a typo, not `myshop.io`.
  let v = raw.trim()
  if (v === '') return { ok: false, reason: 'empty' }
  if (/\s/.test(v)) return { ok: false, reason: 'contains whitespace' }

  // Step 2: strip scheme, userinfo, port, path, query and fragment.
  v = v.replace(SCHEME_RE, '')
  v = v.replace(/^\/\//, '') // protocol-relative
  v = v.split(/[/?#]/, 1)[0]
  const at = v.lastIndexOf('@') // userinfo may itself contain '@'
  if (at !== -1) v = v.slice(at + 1)
  if (v.startsWith('[')) return { ok: false, reason: 'an IPv6 literal is not a domain' }
  v = v.replace(PORT_RE, '')
  if (v === '') return { ok: false, reason: 'no host part' }

  // Step 1: lowercase before punycode, or `MÜNCHEN` and `münchen` get different A-labels.
  v = v.toLowerCase()

  // Step 3: strip one trailing root dot, before counting labels.
  if (v.endsWith('.')) v = v.slice(0, -1)

  // Step 4: strip leading `www.` labels, never down to a bare TLD (`www.com` is registrable).
  // Loop to stay idempotent. One pass leaves `www.example.com` from `www.www.example.com`.
  while (v.startsWith('www.') && v.split('.').length > 2) v = v.slice(4)

  if (v === '') return { ok: false, reason: 'empty after normalisation' }
  if (v.includes('..')) return { ok: false, reason: 'empty label' }

  // Step 5: IDNA A-labels.
  try {
    v = toASCII(v)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }

  // Step 6: is this a registrable domain at all?
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
    // Also rejects A-label TLDs like `xn--p1ai` (.рф), per step 6. Widen it in spec/PROOF.md first.
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

/** Already canonical, not just normalisable. */
export function isNormalisedDomain(value: unknown): value is string {
  const r = tryNormaliseDomain(value)
  return r.ok && r.domain === value
}

/** Last label, not the public suffix (`co.uk` names give `uk`). */
export function tldOf(domain: string): string {
  const d = normaliseDomain(domain)
  return d.slice(d.lastIndexOf('.') + 1)
}

/** [rest, last label], for display. */
export function splitDomain(domain: string): [string, string] {
  const d = normaliseDomain(domain)
  const i = d.lastIndexOf('.')
  return [d.slice(0, i), d.slice(i + 1)]
}

/** Proof record owner is `_flexmydomain.<domain>`. Registrar panels tend to mangle the underscore. */
export const PROOF_LABEL = '_flexmydomain'

export function proofRecordName(domain: string): string {
  return `${PROOF_LABEL}.${normaliseDomain(domain)}`
}

/** NIP-05 document for the alternative proof. */
export function nip05Url(domain: string, name = '_'): string {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
}
