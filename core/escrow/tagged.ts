// BIP-341 tagged hashes and the CompactSize length prefix.

import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** BIP-341 tag strings. Case sensitive, hashed exactly as written. */
export const TAG_TAPLEAF = 'TapLeaf'
export const TAG_TAPBRANCH = 'TapBranch'
export const TAG_TAPTWEAK = 'TapTweak'

/** Tapscript leaf version, the only one BIP-342 defines. */
export const TAP_LEAF_VERSION = 0xc0

export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const prefix = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(prefix, prefix, ...msgs))
}

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

export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'object' && value !== null) return Object.prototype.toString.call(value)
  return String(value)
}

/** BIP-341 leaf version rules. */
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

export function tapLeafHash(script: Uint8Array, leafVersion: number = TAP_LEAF_VERSION): Uint8Array {
  assertLeafVersion(leafVersion)
  return taggedHash(TAG_TAPLEAF, Uint8Array.of(leafVersion), compactSize(script.length), script)
}

export function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  return taggedHash(TAG_TAPBRANCH, lo, hi)
}

export function tapTweakHash(internalKeyX: Uint8Array, merkleRoot: Uint8Array): Uint8Array {
  return taggedHash(TAG_TAPTWEAK, internalKeyX, merkleRoot)
}

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
