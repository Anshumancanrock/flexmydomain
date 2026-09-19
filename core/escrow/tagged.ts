/**
 * BIP-341 tagged hashes and the CompactSize length prefix.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** The three tags BIP-341 defines. Case sensitive, no separators, no padding. */
export const TAG_TAPLEAF = 'TapLeaf'
export const TAG_TAPBRANCH = 'TapBranch'
export const TAG_TAPTWEAK = 'TapTweak'

/** Tapscript leaf version. The only version BIP-342 defines. */
export const TAP_LEAF_VERSION = 0xc0

/**
 * tagged_hash(tag, m) = SHA256( SHA256(tag) || SHA256(tag) || m )
 *
 * The 32-byte digest of the tag appears twice, back to back, before the
 * message. Hashing the tag once, or prefixing the ASCII tag directly, gives a
 * different digest for every leaf, branch and tweak, and so a funded address
 * nobody can ever spend. That cannot be recovered from, so this function is
 * the only place the construction is written.
 *
 * The tag is hashed as raw ASCII: no length prefix, no NUL terminator.
 */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const prefix = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(prefix, prefix, ...msgs))
}

/**
 * Bitcoin's CompactSize integer, the length prefix the TapLeaf preimage uses.
 *
 * It is not a script push opcode, although for a 68-byte leaf both are the
 * single byte 0x44. They diverge above 75 bytes (where a push needs
 * OP_PUSHDATA1) and again at 253 (where CompactSize needs the 0xfd marker).
 *
 * The shortest encoding is mandatory: a non-minimal length prefix is a
 * different preimage and therefore a different address.
 */
export function compactSize(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`compactSize: expected a non-negative integer, got ${describeValue(n)}`)
  }
  if (n <= 0xfc) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >>> 8) & 0xff)
  if (n <= 0xffffffff) {
    return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
  }
  // A tapscript leaf can never reach 2^32 bytes; refuse rather than silently
  // truncate to 32 bits.
  throw new Error(`compactSize: value ${n} exceeds the 32-bit range this encoder supports`)
}

/**
 * Render a rejected value for an error message without hiding its type.
 *
 * `String("4320")` and `String(4320)` are the same four characters, so a bare
 * interpolation turns a type error into the self-contradictory "expected an
 * integer, got 4320". That is the likely error on the JSON paths (the escrow
 * event, the recovery flow), where a number can arrive as a string.
 * JSON.stringify alone renders NaN and Infinity as `null` and throws on a
 * BigInt. Used by the assertions in this module, script.ts and tree.ts.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'object' && value !== null) return Object.prototype.toString.call(value)
  return String(value)
}

/**
 * BIP-341's constraints on the leaf version, all of them about bytes:
 *
 *   - it is one byte of the preimage, and Uint8Array.of() truncates mod 256
 *     silently, so 0x1c0 or -64 would hash as 0xc0 and give the caller a
 *     plausible hash for a version they did not ask for;
 *   - a verifier recovers it as `c[0] & 0xfe`, so no control block can carry
 *     an odd version;
 *   - 0x50 is excluded: as a control block's first byte it is
 *     indistinguishable from the annex marker.
 *
 * Any of these would otherwise hash normally and commit to a branch that can
 * never be spent, leaving a funded address with no way out, so they throw.
 * This is the same rule as @scure/btc-signer's tapLeafVersion
 * (src/payment.ts). Every call site passes TAP_LEAF_VERSION or an
 * already-masked `c[0] & 0xfe`.
 */
function assertLeafVersion(leafVersion: number): void {
  if (!Number.isInteger(leafVersion) || leafVersion < 0 || leafVersion > 0xfe) {
    throw new Error(
      `tapLeafHash: leafVersion must be an integer in 0..254, got ${describeValue(leafVersion)}`,
    )
  }
  if ((leafVersion & 1) !== 0) {
    throw new Error(
      `tapLeafHash: leafVersion must be even: a verifier reads c[0] & 0xfe, so ${leafVersion} can never be committed to`,
    )
  }
  if (leafVersion === 0x50) {
    throw new Error('tapLeafHash: leafVersion 0x50 is reserved; it collides with the annex marker')
  }
}

/**
 * leaf_hash = tagged_hash("TapLeaf", leaf_version || compact_size(|s|) || s)
 *
 * Nothing else goes into the preimage: no internal key, no depth, no trailing
 * bytes. Omitting the CompactSize prefix (hashing 0xc0 || script) is a common
 * mistake and gives a wrong leaf hash and a wrong address.
 */
export function tapLeafHash(script: Uint8Array, leafVersion: number = TAP_LEAF_VERSION): Uint8Array {
  assertLeafVersion(leafVersion)
  return taggedHash(TAG_TAPLEAF, Uint8Array.of(leafVersion), compactSize(script.length), script)
}

/**
 * branch = tagged_hash("TapBranch", min(a,b) || max(a,b))
 *
 * The two child hashes are sorted lexicographically (unsigned, most significant
 * byte first) before hashing, so the root does not depend on which child was
 * written left and which right.
 *
 * The preimage is 64 bytes: children are not length-prefixed and a branch
 * carries no version byte.
 */
export function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  return taggedHash(TAG_TAPBRANCH, lo, hi)
}

/** t-preimage = internal_key_x(32) || merkle_root(32). Both enter bare. */
export function tapTweakHash(internalKeyX: Uint8Array, merkleRoot: Uint8Array): Uint8Array {
  return taggedHash(TAG_TAPTWEAK, internalKeyX, merkleRoot)
}

/** Unsigned bytewise comparison, most significant byte first. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/** Constant-shape equality for byte strings. Used for assertions, not secrets. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0
}
