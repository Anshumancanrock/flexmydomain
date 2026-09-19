/**
 * RFC 3492 punycode, the encoding half of IDNA A-labels.
 *
 * Implemented here rather than left to `new URL()`, which does IDNA in a
 * browser and in Bun but is a host facility: the same input can normalise
 * differently across engines and versions. The normalised domain is inside a
 * signed message (spec/PROOF.md section 2), so a one-byte disagreement between
 * signer and verifier is a silent verification failure. Node's `punycode`
 * module is deprecated and is a node:* import, which core/ does not allow.
 */

/** RFC 3492 section 5. Fixed by the RFC; none of these is tunable. */
const BASE = 36
const TMIN = 1
const TMAX = 26
const SKEW = 38
const DAMP = 700
const INITIAL_BIAS = 72
const INITIAL_N = 128
const DELIMITER = '-'

/** The ASCII prefix IDNA puts in front of every punycode label. Lowercase. */
export const ACE_PREFIX = 'xn--'

/** Largest code point, so an overflowing decode is rejected rather than wrapped. */
const MAX_CODE_POINT = 0x10ffff

/**
 * digit -> character, for the basic-code-point alphabet: 0..25 map to a..z and
 * 26..35 to 0..9. Lowercase only on output; case is insignificant on input and
 * carries the (unused) flag bit of RFC 3492 section 5.
 */
function digitToBasic(digit: number): string {
  return String.fromCharCode(digit < 26 ? digit + 97 : digit - 26 + 48)
}

/** character -> digit. Returns BASE for anything outside the alphabet. */
function basicToDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26 // 0-9
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 //      a-z
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 //      A-Z
  return BASE
}

/** RFC 3492 section 6.1, verbatim. */
function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1
  d += Math.floor(d / numPoints)
  let k = 0
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN))
    k += BASE
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW))
}

/**
 * Encode one label to punycode, without the `xn--` prefix.
 *
 * Exported for tests; callers should use {@link toASCII}, which decides whether
 * a label needs encoding at all and attaches the prefix.
 */
export function encodeLabel(label: string): string {
  const input = Array.from(label, (c) => c.codePointAt(0) as number)
  const output: string[] = []

  for (const cp of input) if (cp < 0x80) output.push(String.fromCharCode(cp))
  const basicLength = output.length
  let handled = basicLength

  if (basicLength > 0) output.push(DELIMITER)

  let n = INITIAL_N
  let delta = 0
  let bias = INITIAL_BIAS

  while (handled < input.length) {
    // The smallest code point >= n that still needs encoding.
    let m = MAX_CODE_POINT + 1
    for (const cp of input) if (cp >= n && cp < m) m = cp

    // Overflow here needs a label longer than DNS allows. The check stays
    // because RFC 3492 requires it.
    if (m - n > Math.floor((0x7fffffff - delta) / (handled + 1))) {
      throw new Error('punycode: overflow while encoding')
    }
    delta += (m - n) * (handled + 1)
    n = m

    for (const cp of input) {
      if (cp < n && ++delta > 0x7fffffff) throw new Error('punycode: overflow while encoding')
      if (cp !== n) continue

      let q = delta
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias
        if (q < t) break
        output.push(digitToBasic(t + ((q - t) % (BASE - t))))
        q = Math.floor((q - t) / (BASE - t))
      }
      output.push(digitToBasic(q))
      bias = adapt(delta, handled + 1, handled === basicLength)
      delta = 0
      handled++
    }
    delta++
    n++
  }

  return output.join('')
}

/**
 * Decode one punycode label, without the `xn--` prefix.
 *
 * Used to check an `xn--` label a user typed: a label that does not decode, or
 * does not re-encode to itself, is not a valid A-label and is rejected rather
 * than signed. Also lets the UI show `münchen.de` beside `xn--mnchen-3ya.de`.
 */
export function decodeLabel(label: string): string {
  const output: number[] = []
  const delimiterIndex = label.lastIndexOf(DELIMITER)

  // Everything before the last delimiter is literal ASCII. A leading delimiter
  // means there is no basic-code-point section, which is legal.
  let index = 0
  if (delimiterIndex > 0) {
    for (let i = 0; i < delimiterIndex; i++) {
      const code = label.charCodeAt(i)
      if (code >= 0x80) throw new Error('punycode: non-ASCII byte in the basic section')
      output.push(code)
    }
    index = delimiterIndex + 1
  }

  let n = INITIAL_N
  let i = 0
  let bias = INITIAL_BIAS

  while (index < label.length) {
    const oldi = i
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= label.length) throw new Error('punycode: truncated encoding')
      const digit = basicToDigit(label.charCodeAt(index++))
      if (digit >= BASE) throw new Error('punycode: invalid digit')
      if (digit > Math.floor((0x7fffffff - i) / w)) throw new Error('punycode: overflow')
      i += digit * w
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias
      if (digit < t) break
      if (w > Math.floor(0x7fffffff / (BASE - t))) throw new Error('punycode: overflow')
      w *= BASE - t
    }

    const out = output.length + 1
    bias = adapt(i - oldi, out, oldi === 0)

    if (Math.floor(i / out) > 0x7fffffff - n) throw new Error('punycode: overflow')
    n += Math.floor(i / out)
    i %= out

    if (n > MAX_CODE_POINT || (n >= 0xd800 && n <= 0xdfff)) {
      // Surrogate halves are not code points. Some encoders emit them; a
      // domain containing one is not a domain.
      throw new Error('punycode: decoded an invalid code point')
    }
    output.splice(i++, 0, n)
  }

  return String.fromCodePoint(...output)
}

/**
 * Convert one label to its A-label form.
 *
 * ASCII labels pass through untouched, including ones that already start with
 * `xn--`, which are checked for round-trip validity instead of re-encoded.
 */
export function labelToASCII(label: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(label)) {
    if (label.toLowerCase().startsWith(ACE_PREFIX)) assertValidALabel(label.toLowerCase())
    return label
  }
  return ACE_PREFIX + encodeLabel(label)
}

/**
 * An `xn--` label must decode, and must re-encode to exactly the input. The
 * re-encoding check rejects a non-canonical encoding: two punycode strings can
 * decode to the same name, and only one of them may be signed, or a proof for
 * one domain would be a proof for several.
 */
function assertValidALabel(label: string): void {
  const body = label.slice(ACE_PREFIX.length)
  if (body === '') throw new Error(`punycode: "${label}" is the bare ACE prefix with no payload`)
  let decoded: string
  try {
    decoded = decodeLabel(body)
  } catch (err) {
    throw new Error(`punycode: "${label}" is not a valid A-label: ${(err as Error).message}`)
  }
  if (ACE_PREFIX + encodeLabel(decoded) !== label) {
    throw new Error(`punycode: "${label}" is not the canonical encoding of "${decoded}"`)
  }
  // An A-label that decodes to pure ASCII is a second spelling of a name that
  // already had one: `xn--a-` and `a` are the same label, and IDNA forbids the
  // first for that reason. Two spellings of one domain means two signed
  // messages for one claim.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(decoded)) {
    throw new Error(`punycode: "${label}" decodes to the ASCII label "${decoded}", which must not be encoded`)
  }
}

/** Convert a whole dot-separated name to A-label form, label by label. */
export function toASCII(name: string): string {
  return name.split('.').map(labelToASCII).join('.')
}

/**
 * The inverse, for display only. Never feed the result back into a signed
 * message: the U-label form is what spec/PROOF.md section 4 normalises away.
 */
export function toUnicode(name: string): string {
  return name
    .split('.')
    .map((l) => (l.toLowerCase().startsWith(ACE_PREFIX) ? tryDecode(l) : l))
    .join('.')
}

function tryDecode(label: string): string {
  try {
    return decodeLabel(label.slice(ACE_PREFIX.length))
  } catch {
    return label // undisplayable is better than throwing inside a renderer
  }
}
