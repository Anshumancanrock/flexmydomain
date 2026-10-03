// client/signer.ts outside a browser: a stub window.nostr and an in-memory localStorage.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { signEvent, type UnsignedEvent } from '../../core/nostr/event.ts'
import { UNLOCKED_MAX_IDLE, extensionSigner, forgetUnlocked, hasStoredKey, keepUnlocked, loadKey, storeKey, storedPubkey, unlockedKey } from '../../client/signer.ts'

const SK = new Uint8Array(32).fill(0x21)
const PK = bytesToHex(schnorr.getPublicKey(SK))
const AUX = new Uint8Array(32)
const unsigned: UnsignedEvent = { pubkey: PK, created_at: 1_789_430_400, kind: 1, tags: [], content: 'hello' }

const g = globalThis as Record<string, unknown>

describe('the NIP-07 signer checks what the extension hands back', () => {
  const extension = (signEvent: (e: UnsignedEvent) => unknown) => {
    g.window = { nostr: { getPublicKey: async () => PK, signEvent: async (e: UnsignedEvent) => signEvent(e) } }
  }
  afterEach(() => { delete g.window })

  test('a good signature comes back on our own event', async () => {
    extension((e) => signEvent(e, SK, AUX))
    const signed = await extensionSigner().signEvent(unsigned)
    expect(signed).toEqual(signEvent(unsigned, SK, AUX))
  })

  test('a signature that does not verify is refused', async () => {
    extension((e) => ({ ...signEvent(e, SK, AUX), sig: 'ab'.repeat(64) }))
    await expect(extensionSigner().signEvent(unsigned)).rejects.toThrow(/does not verify/)
  })

  test('an event altered before signing is refused', async () => {
    extension((e) => signEvent({ ...e, content: 'swapped' }, SK, AUX))
    await expect(extensionSigner().signEvent(unsigned)).rejects.toThrow(/altered/)
  })
})

describe('the stored key', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterEach(() => { delete g.localStorage })

  test('storing over an existing key needs an explicit replace', async () => {
    await storeKey(SK, 'first passphrase')
    await expect(storeKey(new Uint8Array(32).fill(0x22), 'second passphrase')).rejects.toThrow(/already stored/)
    expect(await loadKey('first passphrase')).toEqual(SK)

    await storeKey(new Uint8Array(32).fill(0x22), 'second passphrase', { replace: true })
    expect(hasStoredKey()).toBe(true)
    await expect(loadKey('first passphrase')).rejects.toThrow(/does not unlock/)
  })

  test('two stores racing (two tabs) cannot both win', async () => {
    const results = await Promise.allSettled([
      storeKey(new Uint8Array(32).fill(0x31), 'passphrase one'),
      storeKey(new Uint8Array(32).fill(0x32), 'passphrase two'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})

describe('a key kept unlocked for one tab', () => {
  let store: Map<string, string>
  const T = 1_791_000_000
  beforeEach(() => {
    store = new Map<string, string>()
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterEach(() => { delete g.sessionStorage })

  test('comes back as the same key until it is forgotten', () => {
    expect(unlockedKey(T)).toBeUndefined()
    keepUnlocked(SK, T)
    expect(unlockedKey(T)).toEqual(SK)
    forgetUnlocked()
    expect(unlockedKey(T)).toBeUndefined()
  })

  test('locks again once unused too long, and each use starts the wait again', () => {
    keepUnlocked(SK, T)
    // Used just before it would lock: still there, and the clock restarts.
    expect(unlockedKey(T + UNLOCKED_MAX_IDLE)).toEqual(SK)
    expect(unlockedKey(T + 2 * UNLOCKED_MAX_IDLE)).toEqual(SK)
    // Then left alone a moment too long.
    expect(unlockedKey(T + 3 * UNLOCKED_MAX_IDLE + 1)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  test('a time from the future is no reason to keep it', () => {
    keepUnlocked(SK, T + 3600)
    expect(unlockedKey(T)).toBeUndefined()
  })

  test('anything malformed is dropped, never used as a key', () => {
    const bad = ['', '{', 'null', JSON.stringify({ key: 'zz'.repeat(32), at: T }), JSON.stringify({ key: 'AB'.repeat(32), at: T }),
      JSON.stringify({ key: '00'.repeat(32), at: T }), JSON.stringify({ key: 'ff'.repeat(32), at: T }),
      JSON.stringify({ key: '11'.repeat(31), at: T }), JSON.stringify({ key: '11'.repeat(32) })]
    for (const value of bad) {
      store.set('fmd-unlocked-v2', value)
      expect(unlockedKey(T)).toBeUndefined()
      expect(store.has('fmd-unlocked-v2')).toBe(false)
    }
  })

  test("an earlier build's bare key, with no time on it, is dropped and never used", () => {
    store.set('fmd-unlocked-v1', '11'.repeat(32))
    expect(unlockedKey(T)).toBeUndefined()
    expect(store.has('fmd-unlocked-v1')).toBe(false)
  })

  test('only a 32-byte key is kept', () => {
    expect(() => keepUnlocked(new Uint8Array(31))).toThrow()
    expect(store.size).toBe(0)
  })

  test('a browser with storage switched off keeps nothing and does not throw', () => {
    g.sessionStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(() => keepUnlocked(SK)).not.toThrow()
    expect(unlockedKey()).toBeUndefined()
    expect(() => forgetUnlocked()).not.toThrow()
  })
})

describe('the stored key says whose it is', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterEach(() => { delete g.localStorage })

  test('a new record names its public key', async () => {
    await storeKey(SK, 'a passphrase')
    expect(storedPubkey()).toBe(PK)
  })

  test('an older record without one gets it written in at the next unlock', async () => {
    await storeKey(SK, 'a passphrase')
    const record = JSON.parse(store.get('fmd-key-v1')!)
    delete record.pk
    store.set('fmd-key-v1', JSON.stringify(record))
    expect(storedPubkey()).toBeUndefined()
    expect(await loadKey('a passphrase')).toEqual(SK)
    expect(storedPubkey()).toBe(PK)
  })

  test('a wrong public key in the record is corrected from the key itself', async () => {
    await storeKey(SK, 'a passphrase')
    const record = JSON.parse(store.get('fmd-key-v1')!)
    store.set('fmd-key-v1', JSON.stringify({ ...record, pk: 'ab'.repeat(32) }))
    expect(await loadKey('a passphrase')).toEqual(SK)
    expect(storedPubkey()).toBe(PK)
  })
})
