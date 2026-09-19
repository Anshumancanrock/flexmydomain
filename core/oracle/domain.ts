/**
 * Domain normalisation, as defined in spec/PROOF.md section 4.
 *
 * The normalised string is inside the signed message, which is why this file
 * is stricter than a regex. If the signer and the verifier disagree about what
 * `MyShop.IO.` normalises to, they compute the signature over
 * `flexmydomain:v1:<domain>:<iat>` for two different messages, and
 * verification fails with no diagnosis on either side. Both halves call the
 * functions here.
 *
 * spec/PROOF.md is normative: where this file disagrees with it, this file
 * has the bug.
 */

import { toASCII, toUnicode } from './punycode.js'

/** spec/PROOF.md section 4, step 6: at most 253 characters in text form. */
export const MAX_DOMAIN_LENGTH = 253

/** RFC 1035 section 2.3.4. */
export const MAX_LABEL_LENGTH = 63

/**
 * A single already-normalised label: LDH, no leading or trailing hyphen.
 * Anchored, and not `\w` on purpose: underscore is legal in a TXT record's
 * owner name (`_flexmydomain`) but not in a hostname label.
 */
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** spec/PROOF.md section 4, step 6: a TLD of 2..24 alphabetic characters. */
const TLD_RE = /^[a-z]{2,24}$/

/** `scheme://`, per RFC 3986's scheme production. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/** A trailing `:port` on the authority. */
const PORT_RE = /:\d{1,5}$/

/**
 * Normalise, or explain why not.
 *
 * The non-throwing form exists for the UI: the add-a-domain field validates on
 * every keystroke, and a returned reason is simpler to handle there than an
 * exception per character.
 */
export type NormaliseResult =
  | { ok: true; domain: string; unicode: string }
  | { ok: false; reason: string }

/**
 * Normalise a user-supplied string to the canonical domain of spec section 4.
 *
 * Accepts what people paste (a full URL, a trailing dot, mixed case, a `www.`
 * prefix, a Unicode name) and returns the one form everything downstream
 * signs, indexes and compares. The step numbers in the comments below are
 * those of spec/PROOF.md section 4.
 *
 *   'https://www.MyShop.io/pricing?x=1'  ->  'myshop.io'
 *   'MÜNCHEN.de'                          ->  'xn--mnchen-3ya.de'
 *   'example.com.'                        ->  'example.com'
 */
export function tryNormaliseDomain(raw: unknown): NormaliseResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'expected a string' }
  }

  // Step 1: trim. Internal whitespace is rejected, not removed: `my shop.io`
  // is a typo, and deleting the space would return a domain the user never
  // typed.
  let v = raw.trim()
  if (v === '') return { ok: false, reason: 'empty' }
  if (/\s/.test(v)) return { ok: false, reason: 'contains whitespace' }

  // Step 2: strip scheme, userinfo, port, path, query and fragment.
  v = v.replace(SCHEME_RE, '')
  v = v.replace(/^\/\//, '') // protocol-relative: `//cdn.example.net/path`
  v = v.split(/[/?#]/, 1)[0]
  const at = v.lastIndexOf('@') // userinfo may itself contain '@'
  if (at !== -1) v = v.slice(at + 1)
  if (v.startsWith('[')) return { ok: false, reason: 'an IPv6 literal is not a domain' }
  v = v.replace(PORT_RE, '')
  if (v === '') return { ok: false, reason: 'no host part' }

  // Step 1: lowercase. This runs before punycode and is Unicode-aware, so
  // `MÜNCHEN` and `münchen` converge here; otherwise they would encode to two
  // different A-labels and so two different signed messages.
  v = v.toLowerCase()

  // Step 3: strip one trailing root dot, before counting labels.
  if (v.endsWith('.')) v = v.slice(0, -1)

  // Step 4: strip leading `www.` labels, but never down to a bare TLD:
  // `www.com` is a registrable domain in its own right.
  //
  // The loop keeps normalisation idempotent. Stripping once would turn
  // `www.www.example.com` into `www.example.com`, which normalises again to
  // `example.com`, and a side that normalised twice would sign a different
  // message from a side that normalised once.
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
    // This also rejects an A-label TLD such as `xn--p1ai` (.рф), as step 6
    // requires. The limitation is recorded in spec/PROOF.md; widen it there
    // first, not here.
    return { ok: false, reason: `"${tld}" is not a supported top-level domain` }
  }

  return { ok: true, domain: v, unicode: toUnicode(v) }
}

/**
 * The same, throwing. Use it where a failure is a programming error rather
 * than user input: signing, verifying, indexing.
 */
export function normaliseDomain(raw: unknown): string {
  const r = tryNormaliseDomain(raw)
  if (!r.ok) {
    const shown = typeof raw === 'string' ? JSON.stringify(raw) : Object.prototype.toString.call(raw)
    throw new Error(`normaliseDomain: ${shown} is not a domain: ${r.reason}`)
  }
  return r.domain
}

/** True when `value` is already in canonical form, not merely normalisable. */
export function isNormalisedDomain(value: unknown): value is string {
  const r = tryNormaliseDomain(value)
  return r.ok && r.domain === value
}

/** The last label. `co.uk` names report `uk`; this is a label, not a suffix. */
export function tldOf(domain: string): string {
  const d = normaliseDomain(domain)
  return d.slice(d.lastIndexOf('.') + 1)
}

/** Split into [everything before the last label, the last label]. For display. */
export function splitDomain(domain: string): [string, string] {
  const d = normaliseDomain(domain)
  const i = d.lastIndexOf('.')
  return [d.slice(0, i), d.slice(i + 1)]
}

/**
 * The owner name of the proof record: `_flexmydomain.<domain>`.
 *
 * Defined once so that the generator that tells a user what to paste, the
 * resolver that looks it up and every test agree on the label, including its
 * leading underscore: the part a registrar panel is most likely to mangle and
 * a re-implementation most likely to drop.
 */
export const PROOF_LABEL = '_flexmydomain'

export function proofRecordName(domain: string): string {
  return `${PROOF_LABEL}.${normaliseDomain(domain)}`
}

/** The NIP-05 document a domain must serve to offer the alternative proof. */
export function nip05Url(domain: string, name = '_'): string {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
}
