/**
 * The recovery string: the only thing a user needs to get their money back.
 * It carries the escrow's private key and every parameter needed to rebuild
 * the tree, so web/recover.html (a single file opened from file://, with no
 * network and no server) can rebuild the address and build and sign a sweep.
 *
 * It contains a private key. It is not a receipt or an identifier, and does
 * not belong in a support ticket. Nothing in this repository may log it, store
 * it, transmit it or put it in an error message.
 *
 * The escrow key is generated fresh and handed to the user rather than derived
 * from their Nostr key: a NIP-07 signer never exposes the private key, and
 * BIP-340 signing is not reliably deterministic across signers, so there is
 * nothing stable to derive from.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildTree, type EscrowTree, type TimeoutTo } from './tree.js'
import { u32, u64 } from './tx.js'

/** Human-readable prefix, so a string found in a notebook is identifiable. */
export const RECOVERY_PREFIX = 'fmdrec1'

const VERSION = 1
const CHECKSUM_BYTES = 4

const HAS_ARBITER = 0b0000_0001
const TIMEOUT_TO_SELLER = 0b0000_0010
const HAS_FUNDING = 0b0000_0100

export interface Recovery {
  version: number
  /** The key this user must sign with. 32 bytes of secret. */
  secretKey: Uint8Array
  buyer: Uint8Array
  seller: Uint8Array
  arbiter?: Uint8Array
  timeoutTo: TimeoutTo
  timeoutBlocks: number
  /** Known once the escrow is funded. Without it a sweep cannot be built. */
  funding?: { txid: string; vout: number; amountSats: bigint }
}

/**
 * Encode. The output is one token with no spaces, safe in a URL and in a QR.
 *
 * Fixed-width fields rather than a self-describing format: this string is
 * meant to be written down, and every byte of framing is a byte a human might
 * mistype. The flags byte carries what varies.
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
  // A truncated sha256, so a mistyped string fails loudly instead of
  // reconstructing a different tree and a different address.
  const checksum = sha256(payload).subarray(0, CHECKSUM_BYTES)
  return RECOVERY_PREFIX + base64urlnopad.encode(concatBytes(payload, checksum))
}

/** Decode, or explain why not. Never throws on user input. */
export function decodeRecovery(text: unknown): { ok: true; recovery: Recovery } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not a string' }
  // Tolerate whitespace and line breaks: this is a string people write down.
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
 * Rebuild the tree a recovery string describes, and say which party the key is.
 *
 * The role is found by comparing the secret key's public key against the keys
 * in the tree. A string whose key is in no leaf is refused here, instead of
 * producing a sweep that fails only at the signing step.
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
