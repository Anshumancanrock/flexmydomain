/**
 * Signers, for the browser.
 *
 * Both signers implement the `Signer` interface from core/nostr, so no page
 * branches on how a user signs.
 *
 *   NIP-07     a browser extension, the primary path. The site never sees
 *              the key.
 *   local      a key generated in the page and encrypted at rest under a
 *              passphrase. The fallback, and the path anyone on a machine
 *              without an extension takes, so it has to be pleasant to use.
 *
 * Check every change to this file against two rules: no key material is
 * logged, sent anywhere or written unencrypted, and the file makes no network
 * calls at all.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { eventId, type NostrEvent, type Signer, type UnsignedEvent } from '../core/nostr/event.js'
import { npubEncode, nsecEncode } from '../core/nostr/nip19.js'

/** The subset of NIP-07 used here. Nothing here asks for a private key. */
interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent & { id?: string }): Promise<NostrEvent>
}

declare global {
  interface Window {
    nostr?: Nip07
  }
}

/** Is an extension present? Checked at call time, because extensions inject late. */
export function hasExtension(): boolean {
  return typeof window !== 'undefined' && typeof window.nostr?.signEvent === 'function'
}

/**
 * Wait briefly for an extension to inject itself.
 *
 * Alby and nos2x set `window.nostr` from a content script, which usually but
 * not always runs before the page's own script. Polling for up to a second
 * catches the late case and costs nothing when the extension is already there.
 */
export async function waitForExtension(timeoutMs = 1000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (hasExtension()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return hasExtension()
}

/**
 * The NIP-07 signer.
 *
 * The extension's answers are checked, not trusted: a returned event must carry
 * the id computed here and the pubkey of the event it was given. Some
 * extensions change `created_at` to avoid leaking the clock; without this
 * check that would produce a TXT record that never verifies, found days later
 * when a buyer reports the listing as unproven.
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

/**
 * A signer over a raw secret key held in memory.
 *
 * `secretKey` is never copied out of this closure. The caller gets a signer
 * and, separately and only on request, the `nsec` backup string.
 */
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
      // No aux randomness argument, so @noble draws it from the platform
      // CSPRNG. Fixed aux randomness is for tests, not for a user's signer.
      return { ...unsigned, id: bytesToHex(digest), sig: bytesToHex(schnorr.sign(digest, secretKey)) }
    },
  }
}

/** Generate a fresh secret key for the local signer. */
export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey()
}

// ---------------------------------------------------------------------------
// encrypted storage for the fallback key
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'fmd-key-v1'
// OWASP's 2021 figure for PBKDF2-HMAC-SHA256. The count is not stored with the
// key, so changing it needs a new StoredKey version or existing keys stop
// decrypting.
const PBKDF2_ITERATIONS = 310_000

interface StoredKey {
  v: 1
  salt: string
  iv: string
  ct: string
}

/**
 * Is there an encrypted key in this browser?
 *
 * It does not say whether anyone knows the passphrase: a stored key nobody can
 * unlock looks the same as one they can. The UI should say the key is
 * encrypted and needs its passphrase.
 */
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
 * Encrypt a secret key under a passphrase and keep it in this browser.
 *
 * AES-256-GCM under a PBKDF2-SHA256 key, with a fresh salt and IV each time.
 * GCM authenticates, so a wrong passphrase raises an error instead of
 * returning plausible bytes that would then be used to sign.
 *
 * This is storage at rest on one machine, not a backup: clearing site data
 * wipes it, and any script that runs on this origin can read localStorage.
 * The forced `nsec` backup step is the real protection, and the UI must not
 * let a user skip it.
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

/** Decrypt the stored key, or throw. The passphrase never leaves this call. */
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
    // GCM's authentication tag failed. Almost always the passphrase; possibly
    // a corrupted store. Either way there is nothing usable here.
    throw new Error('That passphrase does not unlock the stored key')
  }
  const secretKey = new Uint8Array(plain)
  if (secretKey.length !== 32) throw new Error('The stored key is not 32 bytes')
  return secretKey
}

/**
 * Forget the stored key.
 *
 * Irreversible without the `nsec` backup, so the caller must confirm first.
 * This function does not ask: the confirmation belongs in the UI, where the
 * user will read it.
 */
export function forgetStoredKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}
