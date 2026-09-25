// Browser signers behind core/nostr's Signer. NIP-07 extension first, the site never
// sees the key. Fallback is a page-generated key, encrypted at rest under a passphrase.
// Rules for every change here: key material is never logged, sent or stored
// unencrypted, and this file makes no network calls.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { eventId, type NostrEvent, type Signer, type UnsignedEvent } from '../core/nostr/event.js'
import { npubEncode, nsecEncode } from '../core/nostr/nip19.js'

/** The NIP-07 subset we use. Nothing asks for a private key. */
interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent & { id?: string }): Promise<NostrEvent>
}

declare global {
  interface Window {
    nostr?: Nip07
  }
}

/** Checked at call time, extensions inject late. */
export function hasExtension(): boolean {
  return typeof window !== 'undefined' && typeof window.nostr?.signEvent === 'function'
}

/** Alby and nos2x set `window.nostr` from a content script that sometimes runs after ours. */
export async function waitForExtension(timeoutMs = 1000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (hasExtension()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return hasExtension()
}

/**
 * Checks the extension's answers against our id and pubkey. Some extensions change
 * `created_at`, which would give a TXT record that never verifies, found days later.
 */
export function extensionSigner(): Signer {
  return {
    async getPublicKey(): Promise<string> {
      if (!hasExtension()) throw new Error('No NIP-07 extension is available in this browser')
      const pubkey = (await (window.nostr as Nip07).getPublicKey()).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('The extension returned something that is not a public key')
      return pubkey
    },

    async signEvent(unsigned: UnsignedEvent): Promise<NostrEvent> {
      if (!hasExtension()) throw new Error('No NIP-07 extension is available in this browser')
      const expected = eventId(unsigned)
      const signed = await (window.nostr as Nip07).signEvent(unsigned)
      if (signed.pubkey?.toLowerCase() !== unsigned.pubkey) {
        throw new Error('The extension signed under a different key than the one it reported')
      }
      if (signed.id !== expected) {
        throw new Error('The extension altered the event before signing it')
      }
      return { ...signed, pubkey: signed.pubkey.toLowerCase() }
    },
  }
}

/** `secretKey` never leaves this closure. The `nsec` backup comes out only on request. */
export function localSigner(secretKey: Uint8Array): Signer & { npub: string; backup: () => string } {
  if (secretKey.length !== 32) throw new Error('localSigner: a secret key is 32 bytes')
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))

  return {
    npub: npubEncode(pubkey),
    backup: () => nsecEncode(secretKey),
    async getPublicKey() {
      return pubkey
    },
    async signEvent(unsigned: UnsignedEvent): Promise<NostrEvent> {
      if (unsigned.pubkey !== pubkey) throw new Error('localSigner: that event is for a different key')
      const digest = hexToBytes(eventId(unsigned))
      // No aux randomness passed, so @noble uses the platform CSPRNG. Fixed aux is for tests.
      return { ...unsigned, id: bytesToHex(digest), sig: bytesToHex(schnorr.sign(digest, secretKey)) }
    },
  }
}

export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey()
}

const STORAGE_KEY = 'fmd-key-v1'
// OWASP 2021 figure for PBKDF2-HMAC-SHA256. Not stored with the key, so changing it
// needs a new StoredKey version or existing keys stop decrypting.
const PBKDF2_ITERATIONS = 310_000

interface StoredKey {
  v: 1
  salt: string
  iv: string
  ct: string
}

/** Says nothing about whether anyone still knows the passphrase. */
export function hasStoredKey(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * AES-256-GCM under a PBKDF2-SHA256 key, fresh salt and IV each time. GCM authenticates,
 * so a wrong passphrase throws instead of giving bytes we'd sign with.
 * Not a backup. Clearing site data wipes it, and any script on this origin can read
 * localStorage. The UI must never let a user skip the `nsec` backup.
 */
export async function storeKey(secretKey: Uint8Array, passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Choose a passphrase of at least 8 characters')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, salt)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, secretKey as BufferSource),
  )
  const stored: StoredKey = { v: 1, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct) }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}

/** Decrypt or throw. The passphrase never leaves this call. */
export async function loadKey(passphrase: string): Promise<Uint8Array> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('No key is stored in this browser')
  const stored = JSON.parse(raw) as StoredKey
  if (stored.v !== 1) throw new Error(`Unknown stored-key version ${stored.v}`)

  const key = await deriveAesKey(passphrase, hexToBytes(stored.salt))
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(stored.iv) as BufferSource },
      key,
      hexToBytes(stored.ct) as BufferSource,
    )
  } catch {
    // GCM tag failed. Almost always the passphrase, maybe a corrupt store.
    throw new Error('That passphrase does not unlock the stored key')
  }
  const secretKey = new Uint8Array(plain)
  if (secretKey.length !== 32) throw new Error('The stored key is not 32 bytes')
  return secretKey
}

/** Irreversible without the `nsec` backup. Confirm in the UI first, this doesn't ask. */
export function forgetStoredKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}
