// Browser signers behind core/nostr's Signer. NIP-07 extension first, the site never sees the key.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { eventId, isHex32, verifyDigestSignature, type NostrEvent, type Signer, type UnsignedEvent } from '../core/nostr/event.js'
import { conversationKey, decrypt, encrypt } from '../core/nostr/nip44.js'
import { npubEncode, nsecEncode } from '../core/nostr/nip19.js'

/** The NIP-07 subset we use. Nothing asks for a private key. */
interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent & { id?: string }): Promise<NostrEvent>
  /** Optional in NIP-07. Extensions that have it encrypt and decrypt NIP-17 messages for us. */
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
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

export async function waitForExtension(timeoutMs = 1000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (hasExtension()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return hasExtension()
}

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
      if (typeof signed !== 'object' || signed === null) throw new Error('The extension returned no signed event')
      if (signed.pubkey?.toLowerCase() !== unsigned.pubkey) {
        throw new Error('The extension signed under a different key than the one it reported')
      }
      if (signed.id?.toLowerCase() !== expected) {
        throw new Error('The extension altered the event before signing it')
      }
      const sig = typeof signed.sig === 'string' ? signed.sig.toLowerCase() : ''
      if (!verifyDigestSignature(sig, hexToBytes(expected), unsigned.pubkey)) {
        throw new Error('The extension returned a signature that does not verify')
      }
      return { ...unsigned, id: expected, sig }
    },

    // Only when the extension has NIP-44 now; it can't be added later, and a missing one can't be faked.
    ...(hasExtension() && typeof window.nostr?.nip44?.encrypt === 'function' && typeof window.nostr?.nip44?.decrypt === 'function'
      ? {
          nip44: {
            async encrypt(peer: string, plaintext: string): Promise<string> {
              if (!isHex32(peer)) throw new Error('nip44: the peer is not a public key')
              const out = await (window.nostr as Nip07).nip44!.encrypt(peer, plaintext)
              if (typeof out !== 'string' || out === '') throw new Error('The extension returned no ciphertext')
              return out
            },
            async decrypt(peer: string, payload: string): Promise<string> {
              if (!isHex32(peer)) throw new Error('nip44: the peer is not a public key')
              const out = await (window.nostr as Nip07).nip44!.decrypt(peer, payload)
              if (typeof out !== 'string') throw new Error('The extension returned no plaintext')
              return out
            },
          },
        }
      : {}),
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
      return { ...unsigned, id: bytesToHex(digest), sig: bytesToHex(schnorr.sign(digest, secretKey)) }
    },
    nip44: {
      async encrypt(peer: string, plaintext: string): Promise<string> {
        // A fresh nonce every time: reusing one under a conversation key leaks plaintext.
        return encrypt(plaintext, conversationKey(secretKey, peer), crypto.getRandomValues(new Uint8Array(32)))
      },
      async decrypt(peer: string, payload: string): Promise<string> {
        return decrypt(payload, conversationKey(secretKey, peer))
      },
    },
  }
}

export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey()
}

const STORAGE_KEY = 'fmd-key-v1'
const PBKDF2_ITERATIONS = 310_000

interface StoredKey {
  v: 1
  salt: string
  iv: string
  ct: string
  /** The key's public half, x-only hex. Not secret; tells which key the slot holds without the passphrase. */
  pk?: string
}

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

export async function storeKey(
  secretKey: Uint8Array,
  passphrase: string,
  options: { replace?: boolean } = {},
): Promise<void> {
  if (passphrase.length < 8) throw new Error('Choose a passphrase of at least 8 characters')
  if (!options.replace && hasStoredKey()) {
    throw new Error('A key is already stored in this browser. Unlock it, or confirm that you want to replace it')
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, salt)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, secretKey as BufferSource),
  )
  const stored: StoredKey = { v: 1, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct), pk: bytesToHex(schnorr.getPublicKey(secretKey)) }
  if (!options.replace && hasStoredKey()) {
    throw new Error('A key is already stored in this browser. Unlock it, or confirm that you want to replace it')
  }
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
    throw new Error('That passphrase does not unlock the stored key')
  }
  const secretKey = new Uint8Array(plain)
  if (secretKey.length !== 32) throw new Error('The stored key is not 32 bytes')
  // Older records don't say whose key they hold.
  const pk = bytesToHex(schnorr.getPublicKey(secretKey))
  if (stored.pk !== pk) {
    try {
      if (localStorage.getItem(STORAGE_KEY) === raw) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, pk }))
    } catch { /* Only a hint; the key itself is what counts. */ }
  }
  return secretKey
}

export function storedPubkey(): string | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const pk = (JSON.parse(raw) as Partial<StoredKey>).pk
    return typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk) ? pk : undefined
  } catch {
    return undefined
  }
}

/** Irreversible without the `nsec` backup. Confirm in the UI first, this doesn't ask. */
export function forgetStoredKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}

const UNLOCKED_KEY = 'fmd-unlocked-v2'

/** Seconds a key kept unlocked may go unread before it locks again. */
export const UNLOCKED_MAX_IDLE = 8 * 60 * 60

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export function keepUnlocked(secretKey: Uint8Array, now = nowSeconds()): void {
  if (secretKey.length !== 32) throw new Error('keepUnlocked: a secret key is 32 bytes')
  try {
    sessionStorage.setItem(UNLOCKED_KEY, JSON.stringify({ key: bytesToHex(secretKey), at: now }))
  } catch {
    // Storage off or full: the key stays unlocked on this page only.
  }
}

export function unlockedKey(now = nowSeconds()): Uint8Array | undefined {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(UNLOCKED_KEY)
  } catch {
    return undefined
  }
  if (raw === null) {
    // One kept by an earlier build has no time on it, so it can't be trusted to expire: drop it.
    try { if (sessionStorage.getItem('fmd-unlocked-v1') !== null) sessionStorage.removeItem('fmd-unlocked-v1') } catch { }
    return undefined
  }
  let kept: { key?: unknown; at?: unknown }
  try {
    kept = JSON.parse(raw)
  } catch {
    forgetUnlocked()
    return undefined
  }
  if (typeof kept?.key !== 'string' || !/^[0-9a-f]{64}$/.test(kept.key) || !Number.isSafeInteger(kept.at)) {
    forgetUnlocked()
    return undefined
  }
  const at = kept.at as number
  if (now - at > UNLOCKED_MAX_IDLE || at > now + 300) {
    forgetUnlocked()
    return undefined
  }
  const secretKey = hexToBytes(kept.key)
  try {
    schnorr.getPublicKey(secretKey)
  } catch {
    forgetUnlocked()
    return undefined
  }
  keepUnlocked(secretKey, now)
  return secretKey
}

export function forgetUnlocked(): void {
  try {
    sessionStorage.removeItem(UNLOCKED_KEY)
    sessionStorage.removeItem('fmd-unlocked-v1')
  } catch {
  }
}
