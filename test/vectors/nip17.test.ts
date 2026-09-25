// NIP-44 and NIP-17 vs nostr-tools (dev dep, imported only here), an independent implementation.
// The registrar auth code rides this channel. Whoever holds it can take the domain.

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip17 as refNip17, nip44 as refNip44 } from 'nostr-tools'

import {
  CHAT_KIND,
  GIFT_WRAP_KIND,
  SEAL_KIND,
  buildRumor,
  conversationKey,
  decrypt,
  encrypt,
  giftWrap,
  giftWrapFilter,
  paddedLength,
  signEvent,
  unwrap,
  type NostrEvent,
} from '../../core/nostr/index.ts'

const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
const ALICE = key(0x11)   // Seller.
const BOB = key(0x22)     // Buyer.
const MALLORY = key(0x44)
const EPHEMERAL = new Uint8Array(32).fill(0x33)
const NOW = 1789430400

const entropy = {
  ephemeralSecretKey: EPHEMERAL,
  sealNonce: new Uint8Array(32).fill(1),
  wrapNonce: new Uint8Array(32).fill(2),
  sealCreatedAt: NOW - 400,
  wrapCreatedAt: NOW - 1400,
}

const AUTH_CODE = 'auth code for lumenary.com: 7Kq-2Xp-9Fw'

function sealed(sender = ALICE, recipient = BOB.pk, content = AUTH_CODE): NostrEvent {
  const rumor = buildRumor({ pubkey: sender.pk, recipient, content, createdAt: NOW, subject: 'lumenary.com' })
  return giftWrap({ rumor, senderSecretKey: sender.sk, recipient, entropy })
}

describe('NIP-44 agrees with the reference, byte for byte', () => {
  test('the conversation key matches, and is symmetric', () => {
    const mine = conversationKey(ALICE.sk, BOB.pk)
    expect(bytesToHex(mine)).toBe(bytesToHex(refNip44.getConversationKey(ALICE.sk, BOB.pk)))
    expect(bytesToHex(conversationKey(BOB.sk, ALICE.pk))).toBe(bytesToHex(mine))
  })

  test('ciphertexts are identical for the same nonce', () => {
    const nonce = new Uint8Array(32).fill(0x42)
    const mine = encrypt(AUTH_CODE, conversationKey(ALICE.sk, BOB.pk), nonce)
    expect(mine).toBe(refNip44.v2.encrypt(AUTH_CODE, refNip44.getConversationKey(ALICE.sk, BOB.pk), nonce))
  })

  test("each side decrypts the other's output", () => {
    const nonce = new Uint8Array(32).fill(7)
    const mine = encrypt(AUTH_CODE, conversationKey(ALICE.sk, BOB.pk), nonce)
    const ref = refNip44.v2.encrypt(AUTH_CODE, refNip44.getConversationKey(BOB.sk, ALICE.pk), nonce)
    expect(decrypt(ref, conversationKey(BOB.sk, ALICE.pk))).toBe(AUTH_CODE)
    expect(refNip44.v2.decrypt(mine, refNip44.getConversationKey(BOB.sk, ALICE.pk))).toBe(AUTH_CODE)
  })

  test('the padding curve matches at every boundary', () => {
    for (const n of [1, 2, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 512, 1000, 65535]) {
      expect(paddedLength(n)).toBe(refNip44.v2.utils.calcPaddedLen(n))
    }
  })

  test('messages under 32 bytes are indistinguishable by length', () => {
    const conversation = conversationKey(ALICE.sk, BOB.pk)
    const nonce = new Uint8Array(32).fill(9)
    const short = encrypt('a', conversation, nonce).length
    const longer = encrypt('a'.repeat(32), conversation, nonce).length
    expect(short).toBe(longer)
  })

  test('a tampered ciphertext is refused, not decrypted', () => {
    const conversation = conversationKey(ALICE.sk, BOB.pk)
    const payload = encrypt(AUTH_CODE, conversation, new Uint8Array(32).fill(3))
    const bytes = [...atob(payload)].map((c) => c.charCodeAt(0))
    bytes[40] ^= 0x01 // Inside the ciphertext.
    const tampered = btoa(String.fromCharCode(...bytes))
    expect(() => decrypt(tampered, conversation)).toThrow(/authentication code/)
  })

  test('a stranger cannot decrypt it', () => {
    const payload = encrypt(AUTH_CODE, conversationKey(ALICE.sk, BOB.pk), new Uint8Array(32).fill(4))
    expect(() => decrypt(payload, conversationKey(MALLORY.sk, ALICE.pk))).toThrow()
  })

  test('malformed payloads are refused rather than crashing', () => {
    const conversation = conversationKey(ALICE.sk, BOB.pk)
    for (const bad of ['', '#unsupported', 'not base64!!', btoa('short')]) {
      expect(() => decrypt(bad, conversation)).toThrow()
    }
  })
})

describe('NIP-17 gift wrap', () => {
  test('the wrap hides the sender from the relay', () => {
    const wrap = sealed()
    expect(wrap.kind).toBe(GIFT_WRAP_KIND)
    expect(wrap.pubkey).not.toBe(ALICE.pk)         // Throwaway signing key.
    expect(wrap.tags).toEqual([['p', BOB.pk]])      // Names only the recipient.
    expect(JSON.stringify(wrap)).not.toContain(AUTH_CODE)
  })

  test('timestamps are fuzzed backwards, independently', () => {
    const wrap = sealed()
    expect(wrap.created_at).toBeLessThan(NOW)
    const out = unwrap(wrap, BOB.sk)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.sealedAt).not.toBe(wrap.created_at)
  })

  test('the recipient reads it, and learns who sent it', () => {
    const out = unwrap(sealed(), BOB.sk)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.rumor.content).toBe(AUTH_CODE)
      expect(out.rumor.kind).toBe(CHAT_KIND)
      expect(out.sender).toBe(ALICE.pk)
    }
  })

  test('nobody else can', () => {
    expect(unwrap(sealed(), MALLORY.sk).ok).toBe(false)
  })

  test('the rumor is unsigned, which makes it deniable', () => {
    const out = unwrap(sealed(), BOB.sk)
    expect(out.ok).toBe(true)
    if (out.ok) expect('sig' in out.rumor).toBe(false)
  })

  test('a rumor claiming to be from somebody else is refused', () => {
    // Mallory seals a rumor claiming Alice as author. The author mismatch is what stops a
    // forged "here is the auth code".
    const forgedRumor = buildRumor({ pubkey: ALICE.pk, recipient: BOB.pk, content: 'send the domain to me', createdAt: NOW })
    const forgedSeal = signEvent(
      {
        pubkey: MALLORY.pk,
        created_at: NOW,
        kind: SEAL_KIND,
        tags: [],
        content: encrypt(JSON.stringify(forgedRumor), conversationKey(MALLORY.sk, BOB.pk), new Uint8Array(32).fill(5)),
      },
      MALLORY.sk,
    )
    const forgedWrap = signEvent(
      {
        pubkey: bytesToHex(schnorr.getPublicKey(EPHEMERAL)),
        created_at: NOW,
        kind: GIFT_WRAP_KIND,
        tags: [['p', BOB.pk]],
        content: encrypt(JSON.stringify(forgedSeal), conversationKey(EPHEMERAL, BOB.pk), new Uint8Array(32).fill(6)),
      },
      EPHEMERAL,
    )

    const out = unwrap(forgedWrap, BOB.sk)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('claims an author')
  })

  test('a rumor whose id does not cover its content is refused', () => {
    const rumor = buildRumor({ pubkey: ALICE.pk, recipient: BOB.pk, content: 'original', createdAt: NOW })
    const rewritten = { ...rumor, content: 'rewritten after the id was computed' }
    const seal = signEvent(
      {
        pubkey: ALICE.pk,
        created_at: NOW,
        kind: SEAL_KIND,
        tags: [],
        content: encrypt(JSON.stringify(rewritten), conversationKey(ALICE.sk, BOB.pk), new Uint8Array(32).fill(8)),
      },
      ALICE.sk,
    )
    const wrap = signEvent(
      {
        pubkey: bytesToHex(schnorr.getPublicKey(EPHEMERAL)),
        created_at: NOW,
        kind: GIFT_WRAP_KIND,
        tags: [['p', BOB.pk]],
        content: encrypt(JSON.stringify(seal), conversationKey(EPHEMERAL, BOB.pk), new Uint8Array(32).fill(9)),
      },
      EPHEMERAL,
    )
    const out = unwrap(wrap, BOB.sk)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('id does not cover')
  })

  test('wrapping a rumor with a key other than its author is refused up front', () => {
    const rumor = buildRumor({ pubkey: ALICE.pk, recipient: BOB.pk, content: 'x', createdAt: NOW })
    expect(() => giftWrap({ rumor, senderSecretKey: MALLORY.sk, recipient: BOB.pk, entropy })).toThrow(/claims an author/)
  })

  test('the filter looks further back than the jitter, or it misses messages', () => {
    const filter = giftWrapFilter(BOB.pk, NOW)
    expect(filter['#p']).toEqual([BOB.pk])
    expect(filter.since as number).toBeLessThanOrEqual(NOW - 2 * 24 * 60 * 60)
  })
})

describe('interop with nostr-tools, both directions', () => {
  test('the reference reads our wrap', () => {
    const read = refNip17.unwrapEvent(sealed() as never, BOB.sk)
    expect(read.content).toBe(AUTH_CODE)
    expect(read.pubkey).toBe(ALICE.pk)
  })

  test("we read the reference's wrap", () => {
    const theirs = refNip17.wrapEvent(ALICE.sk, { publicKey: BOB.pk }, 'from the reference')
    const out = unwrap(theirs as never, BOB.sk)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.rumor.content).toBe('from the reference')
      expect(out.sender).toBe(ALICE.pk)
    }
  })
})
