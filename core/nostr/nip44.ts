/**
 * NIP-44 v2 encrypted payloads.
 *
 * Pure: the nonce comes from the caller.
 *
 * Inside a NIP-17 gift wrap this carries the registrar auth code from seller
 * to buyer. The ciphertext decrypts only for the two parties, so the site
 * never holds an auth code it could read.
 *
 * NIP-04 is not used: it is unauthenticated AES-CBC with the shared secret as
 * the key, so anyone can tamper with a ciphertext undetected. It is
 * deprecated.
 *
 * test/vectors/nip17.test.ts checks this file against nostr-tools:
 * conversation keys, ciphertexts, the padding curve, and decryption in both
 * directions.
 */

import { chacha20 } from '@noble/ciphers/chacha.js'
import { hmac } from '@noble/hashes/hmac.js'
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base64 } from '@scure/base'

/** The only version this file speaks. A payload starting with anything else is refused. */
export const NIP44_VERSION = 2

/** NIP-44's HKDF salt. Domain separation: this key is for nothing else. */
const SALT = utf8ToBytes('nip44-v2')

/** Plaintext bounds, in bytes, from the spec. */
export const MIN_PLAINTEXT_BYTES = 1
export const MAX_PLAINTEXT_BYTES = 65535

/**
 * The long-lived key for one pair of participants.
 *
 * ECDH over secp256k1, keeping only the X coordinate, then HKDF-extract. It is
 * symmetric (Alice with Bob's pubkey and Bob with Alice's produce the same 32
 * bytes) and does not change per message, so a caller can compute it once per
 * conversation rather than per note.
 *
 * It is key material. Do not log it, store it, or put it in an error message.
 */
export function conversationKey(secretKey: Uint8Array, peerPublicKeyHex: string): Uint8Array {
  // `02` prefix: BIP-340 x-only keys are always the even-Y point.
  const shared = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${peerPublicKeyHex}`))
  // getSharedSecret returns a compressed point; the X coordinate is bytes 1..33.
  return hkdfExtract(sha256, shared.subarray(1, 33), SALT)
}

/** Per-message keys, expanded from the conversation key and this message's nonce. */
function messageKeys(conversation: Uint8Array, nonce: Uint8Array): {
  chachaKey: Uint8Array
  chachaNonce: Uint8Array
  hmacKey: Uint8Array
} {
  if (conversation.length !== 32) throw new Error('nip44: the conversation key must be 32 bytes')
  if (nonce.length !== 32) throw new Error('nip44: the nonce must be 32 bytes')
  const expanded = hkdfExpand(sha256, conversation, nonce, 76)
  return {
    chachaKey: expanded.subarray(0, 32),
    chachaNonce: expanded.subarray(32, 44),
    hmacKey: expanded.subarray(44, 76),
  }
}

/**
 * How long a plaintext of `length` bytes is padded to.
 *
 * Padding leaks less about message length: every message of up to 32 bytes
 * pads to the same size, and longer ones round up to one of a small set of
 * buckets. The curve is normative. A different rule produces payloads other
 * clients reject, so none of these numbers can be tuned.
 */
export function paddedLength(length: number): number {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`nip44: plaintext length must be a positive integer, got ${length}`)
  }
  if (length <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((length - 1) / chunk) + 1)
}

/** u16be(length) || plaintext || zeros. */
function pad(plaintext: string): Uint8Array {
  const bytes = utf8ToBytes(plaintext)
  if (bytes.length < MIN_PLAINTEXT_BYTES || bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`nip44: plaintext must be ${MIN_PLAINTEXT_BYTES}..${MAX_PLAINTEXT_BYTES} bytes, got ${bytes.length}`)
  }
  const total = paddedLength(bytes.length)
  const out = new Uint8Array(2 + total)
  out[0] = (bytes.length >>> 8) & 0xff
  out[1] = bytes.length & 0xff
  out.set(bytes, 2)
  return out
}

/** The inverse, refusing anything whose declared length disagrees with its padding. */
function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error('nip44: padded plaintext is too short')
  const length = (padded[0] << 8) | padded[1]
  const bytes = padded.subarray(2, 2 + length)
  // Both checks matter: a wrong declared length is how a tampered payload
  // tries to make a decryptor read past its own plaintext.
  if (length < MIN_PLAINTEXT_BYTES || bytes.length !== length) {
    throw new Error('nip44: declared plaintext length does not match the payload')
  }
  if (padded.length !== 2 + paddedLength(length)) {
    throw new Error('nip44: padding length is not the one this plaintext requires')
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Encrypt.
 *
 * `nonce` is 32 bytes and must be fresh for every message under a given
 * conversation key: reuse leaks the XOR of two plaintexts, which for a short
 * secret like an auth code is close to leaking both. It is a required
 * parameter because core/ draws no randomness of its own, and that keeps the
 * tests deterministic.
 */
export function encrypt(plaintext: string, conversation: Uint8Array, nonce: Uint8Array): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce)
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext))
  // The MAC covers the nonce as well as the ciphertext, so a payload cannot be
  // replayed under a different nonce.
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext))
  return base64.encode(concatBytes(Uint8Array.of(NIP44_VERSION), nonce, ciphertext, mac))
}

/**
 * Decrypt, or throw.
 *
 * The MAC is checked before the ciphertext is decrypted. Decrypting first and
 * authenticating afterwards is the classic error, and it hands an attacker a
 * padding oracle.
 */
export function decrypt(payload: string, conversation: Uint8Array): string {
  if (payload.length === 0) throw new Error('nip44: empty payload')
  if (payload[0] === '#') throw new Error('nip44: this payload declares an unsupported version')

  let bytes: Uint8Array
  try {
    bytes = base64.decode(payload)
  } catch {
    throw new Error('nip44: payload is not valid base64')
  }
  // 1 version + 32 nonce + 32 mac + at least a 34-byte padded plaintext.
  if (bytes.length < 99) throw new Error('nip44: payload is too short to be a v2 message')
  if (bytes[0] !== NIP44_VERSION) throw new Error(`nip44: unsupported version ${bytes[0]}`)

  const nonce = bytes.subarray(1, 33)
  const ciphertext = bytes.subarray(33, bytes.length - 32)
  const mac = bytes.subarray(bytes.length - 32)

  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce)
  const expected = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext))
  if (!timingSafeEqual(expected, mac)) {
    throw new Error('nip44: the message authentication code does not match')
  }

  return unpad(chacha20(chachaKey, chachaNonce, ciphertext))
}

/** Constant-time comparison. A short-circuiting compare on a MAC is a forgery oracle. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
