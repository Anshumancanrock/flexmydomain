/** BIP-341 tagged hashes and the CompactSize length prefix. */

import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** BIP-341 tag strings. Case sensitive, hashed exactly as written. */
export const TAG_TAPLEAF = 'TapLeaf'
export const TAG_TAPBRANCH = 'TapBranch'
export const TAG_TAPTWEAK = 'TapTweak'

/** Tapscript leaf version, the only one BIP-342 defines. */
export const TAP_LEAF_VERSION = 0xc0

/**
 * tagged_hash(tag, m) = SHA256( SHA256(tag) || SHA256(tag) || m )
 *
 * Tag digest twice, then the message. The tag is raw ASCII with no length
 * prefix or NUL. Get it wrong and every hash changes and funds sent to the
 * address are stuck for good, so this is the only place it's written.
 */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const prefix = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(prefix, prefix, ...msgs))
}

/**
 * Bitcoin CompactSize, the length prefix in the TapLeaf preimage. Not a push
 * opcode, though both are 0x44 for a 68-byte leaf. They split above 75 bytes
 * (OP_PUSHDATA1) and again at 253 (0xfd marker).
 *
 * Must be minimal. A longer encoding is a different preimage and address.
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
  // No leaf gets near 2^32 bytes. Throw instead of truncating to 32 bits.
  throw new Error(`compactSize: value ${n} exceeds the 32-bit range this encoder supports`)
}

/**
 * Show a rejected value in an error without hiding its type. The JSON paths
 * (escrow event, recovery) can deliver "4320" as a string, and String() would
 * print the self-contradicting "expected an integer, got 4320". Plain
 * JSON.stringify prints NaN and Infinity as null and throws on BigInt.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'object' && value !== null) return Object.prototype.toString.call(value)
  return String(value)
}

/**
 * BIP-341 leaf version rules. A bad version still hashes, but commits to a
 * branch nobody can spend, so throw instead:
 *   - it's one byte, and Uint8Array.of() wraps mod 256 silently (0x1c0 or -64
 *     would hash as 0xc0)
 *   - it must be even, since verifiers read it as `c[0] & 0xfe`
 *   - 0x50 is out, as a control block's first byte it reads as the annex marker
 * Same rule as @scure/btc-signer's tapLeafVersion (src/payment.ts).
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
 * Nothing else goes in. Dropping the CompactSize prefix is a common bug and
 * gives the wrong address.
 */
export function tapLeafHash(script: Uint8Array, leafVersion: number = TAP_LEAF_VERSION): Uint8Array {
  assertLeafVersion(leafVersion)
  return taggedHash(TAG_TAPLEAF, Uint8Array.of(leafVersion), compactSize(script.length), script)
}

/**
 * branch = tagged_hash("TapBranch", min(a,b) || max(a,b))
 *
 * Children are sorted as unsigned bytes, so left/right order doesn't matter.
 * The preimage is exactly 64 bytes, with no length prefixes or version byte.
 */
export function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  return taggedHash(TAG_TAPBRANCH, lo, hi)
}

/** t-preimage = internal_key_x(32) || merkle_root(32), no prefixes. */
export function tapTweakHash(internalKeyX: Uint8Array, merkleRoot: Uint8Array): Uint8Array {
  return taggedHash(TAG_TAPTWEAK, internalKeyX, merkleRoot)
}

/** Unsigned, most significant byte first, as TapBranch sorts. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/** Not constant-time. For assertions, never secrets. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0
}
