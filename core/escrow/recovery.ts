/**
 * The recovery string, the one thing a user needs to get their money back. It
 * carries the escrow private key and the tree parameters, so web/recover.html
 * can rebuild the address and sign a sweep offline from file://.
 *
 * It contains a private key. Never log it, store it, send it or put it in an
 * error message.
 *
 * The escrow key is fresh, not derived from the Nostr key. NIP-07 signers never
 * expose the private key and BIP-340 signing isn't deterministic across
 * signers, so there's nothing stable to derive from.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildTree, type EscrowTree, type TimeoutTo } from './tree.js'
import { u32, u64 } from './tx.js'

/** Human-readable, so a string found in a notebook is recognisable. */
export const RECOVERY_PREFIX = 'fmdrec1'

const VERSION = 1
const CHECKSUM_BYTES = 4

const HAS_ARBITER = 0b0000_0001
const TIMEOUT_TO_SELLER = 0b0000_0010
const HAS_FUNDING = 0b0000_0100

export interface Recovery {
  version: number
  /** This user's signing key, 32 bytes. Secret. */
  secretKey: Uint8Array
  buyer: Uint8Array
  seller: Uint8Array
  arbiter?: Uint8Array
  timeoutTo: TimeoutTo
  timeoutBlocks: number
  /** Set once funded. A sweep can't be built without it. */
  funding?: { txid: string; vout: number; amountSats: bigint }
}

/**
 * One token, no spaces, safe in a URL or QR. Fixed-width fields plus a flags
 * byte, since people write this down and every framing byte is one more to mistype.
 */
export function encodeRecovery(recovery: Recovery): string {
  assertKey(recovery.secretKey, 32, 'secretKey')
  assertKey(recovery.buyer, 32, 'buyer')
  assertKey(recovery.seller, 32, 'seller')
  if (recovery.arbiter) assertKey(recovery.arbiter, 32, 'arbiter')
  if (!Number.isInteger(recovery.timeoutBlocks) || recovery.timeoutBlocks < 1 || recovery.timeoutBlocks > 0xffff) {
    throw new Error(`encodeRecovery: timeoutBlocks must be 1..65535, got ${recovery.timeoutBlocks}`)
  }

  let flags = 0
  if (recovery.arbiter) flags |= HAS_ARBITER
  if (recovery.timeoutTo === 'seller') flags |= TIMEOUT_TO_SELLER
  if (recovery.funding) flags |= HAS_FUNDING

  const parts: Uint8Array[] = [
    Uint8Array.of(VERSION, flags),
    Uint8Array.of((recovery.timeoutBlocks >>> 8) & 0xff, recovery.timeoutBlocks & 0xff),
    recovery.secretKey,
    recovery.buyer,
    recovery.seller,
  ]
  if (recovery.arbiter) parts.push(recovery.arbiter)
  if (recovery.funding) {
    if (!/^[0-9a-f]{64}$/.test(recovery.funding.txid)) {
      throw new Error('encodeRecovery: the funding txid must be 64 lowercase hex characters')
    }
    parts.push(hexToBytes(recovery.funding.txid), u32(recovery.funding.vout), u64(recovery.funding.amountSats))
  }

  const payload = concatBytes(...parts)
  // Truncated sha256, so a typo fails loudly instead of rebuilding another address.
  const checksum = sha256(payload).subarray(0, CHECKSUM_BYTES)
  return RECOVERY_PREFIX + base64urlnopad.encode(concatBytes(payload, checksum))
}

/** Decode, or explain why not. Never throws on user input. */
export function decodeRecovery(text: unknown): { ok: true; recovery: Recovery } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not a string' }
  // People write this down, so ignore whitespace and line breaks.
  const trimmed = text.trim().replace(/\s+/g, '')
  if (!trimmed.startsWith(RECOVERY_PREFIX)) {
    return { ok: false, reason: `a recovery string starts with "${RECOVERY_PREFIX}"` }
  }

  let bytes: Uint8Array
  try {
    bytes = base64urlnopad.decode(trimmed.slice(RECOVERY_PREFIX.length))
  } catch {
    return { ok: false, reason: 'the string is not valid base64url; check for a mistyped character' }
  }
  if (bytes.length < 2 + 2 + 32 * 3 + CHECKSUM_BYTES) return { ok: false, reason: 'too short to be a recovery string' }

  const payload = bytes.subarray(0, bytes.length - CHECKSUM_BYTES)
  const checksum = bytes.subarray(bytes.length - CHECKSUM_BYTES)
  const expected = sha256(payload).subarray(0, CHECKSUM_BYTES)
  if (bytesToHex(checksum) !== bytesToHex(expected)) {
    return { ok: false, reason: 'the checksum does not match: a character is wrong or missing' }
  }

  const version = payload[0]
  if (version !== VERSION) return { ok: false, reason: `unsupported recovery version ${version}` }
  const flags = payload[1]
  const timeoutBlocks = (payload[2] << 8) | payload[3]

  let at = 4
  const take = (n: number): Uint8Array => {
    const slice = payload.subarray(at, at + n)
    at += n
    return slice
  }

  const secretKey = take(32)
  const buyer = take(32)
  const seller = take(32)
  const arbiter = flags & HAS_ARBITER ? take(32) : undefined

  let funding: Recovery['funding']
  if (flags & HAS_FUNDING) {
    if (payload.length - at < 32 + 4 + 8) return { ok: false, reason: 'the funding outpoint is truncated' }
    const txid = bytesToHex(take(32))
    const voutBytes = take(4)
    const amountBytes = take(8)
    const vout = voutBytes[0] | (voutBytes[1] << 8) | (voutBytes[2] << 16) | (voutBytes[3] << 24)
    let amountSats = 0n
    for (let i = 7; i >= 0; i--) amountSats = (amountSats << 8n) | BigInt(amountBytes[i])
    funding = { txid, vout: vout >>> 0, amountSats }
  }

  if (at !== payload.length) return { ok: false, reason: 'the recovery string has trailing bytes' }

  return {
    ok: true,
    recovery: {
      version,
      secretKey,
      buyer,
      seller,
      arbiter,
      timeoutTo: flags & TIMEOUT_TO_SELLER ? 'seller' : 'buyer',
      timeoutBlocks,
    ...(funding ? { funding } : {}),
    },
  }
}

/**
 * Rebuild the tree and work out which party the key belongs to. A key in no
 * leaf is refused here, before it turns into a sweep that fails at signing.
 */
export function rebuildFromRecovery(recovery: Recovery): {
  tree: EscrowTree
  role: 'buyer' | 'seller' | 'arbiter'
  pubkey: Uint8Array
} {
  const pubkey = schnorr.getPublicKey(recovery.secretKey)
  const hex = bytesToHex(pubkey)

  const role =
    hex === bytesToHex(recovery.buyer)
      ? 'buyer'
      : hex === bytesToHex(recovery.seller)
        ? 'seller'
        : recovery.arbiter && hex === bytesToHex(recovery.arbiter)
          ? 'arbiter'
          : undefined

  if (!role) {
    throw new Error(
      'rebuildFromRecovery: the key in this string is not one of the keys in this escrow: ' +
        'the string is for a different escrow, or it is damaged',
    )
  }

  return {
    tree: buildTree({
      buyer: recovery.buyer,
      seller: recovery.seller,
      arbiter: recovery.arbiter,
      timeoutTo: recovery.timeoutTo,
      timeoutBlocks: recovery.timeoutBlocks,
    }),
    role,
    pubkey,
  }
}

function assertKey(bytes: Uint8Array, length: number, name: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`encodeRecovery: ${name} must be ${length} bytes`)
  }
}
