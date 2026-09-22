/**
 * Browser helpers for NIP-17 private messages, and the randomness core/ does
 * not draw itself.
 *
 * core/nostr/nip17.ts is pure and takes every random value as an argument, so
 * a wrap is reproducible in a test and every nonce is visible at the call
 * site. This file draws those values.
 *
 * Sealing needs the sender's secret key for ECDH, and a NIP-07 extension signs
 * events without exposing its key. So sealing here works only with a local
 * key; for any other signer `canSealWith` returns false, and the caller should
 * say so rather than fall back to something weaker.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  MAX_TIMESTAMP_JITTER,
  buildRumor,
  giftWrap,
  unwrap,
  type NostrEvent,
  type NostrTag,
  type Rumor,
} from '../core/nostr/index.js'

/** Fresh randomness for one wrap. Each value is used once. */
export function wrapEntropy(now: number): {
  ephemeralSecretKey: Uint8Array
  sealNonce: Uint8Array
  wrapNonce: Uint8Array
  sealCreatedAt: number
  wrapCreatedAt: number
} {
  /* Both timestamps are moved back by independent random amounts. One shared
     jitter would let a relay pair a seal with its wrap by their offset. */
  const jitter = () => now - Math.floor(Math.random() * MAX_TIMESTAMP_JITTER)
  return {
    ephemeralSecretKey: schnorr.utils.randomSecretKey(),
    sealNonce: crypto.getRandomValues(new Uint8Array(32)),
    wrapNonce: crypto.getRandomValues(new Uint8Array(32)),
    sealCreatedAt: jitter(),
    wrapCreatedAt: jitter(),
  }
}

/**
 * Seal a message for one recipient, with a local key.
 *
 * The ephemeral key is generated inside {@link wrapEntropy} and never leaves
 * this call, so there is nothing to discard afterwards.
 */
export function sealMessage(params: {
  senderSecretKey: Uint8Array
  recipient: string
  content: string
  now: number
  subject?: string
  tags?: NostrTag[]
}): NostrEvent {
  const rumor = buildRumor({
    pubkey: bytesToHex(schnorr.getPublicKey(params.senderSecretKey)),
    recipient: params.recipient,
    content: params.content,
    createdAt: params.now,
    subject: params.subject,
    tags: params.tags,
  })
  return giftWrap({
    rumor,
    senderSecretKey: params.senderSecretKey,
    recipient: params.recipient,
    entropy: wrapEntropy(params.now),
  })
}

/**
 * Read every wrap in a batch that this key can open.
 *
 * Most wraps a relay returns are for somebody else and fail to decrypt. That
 * is normal, so they are dropped without an error and only counted, for a UI
 * that wants to show the number.
 */
export function readMessages(
  wraps: readonly NostrEvent[],
  recipientSecretKey: Uint8Array,
): { messages: { rumor: Rumor; sender: string; sealedAt: number; wrap: NostrEvent }[]; unreadable: number } {
  const messages: { rumor: Rumor; sender: string; sealedAt: number; wrap: NostrEvent }[] = []
  let unreadable = 0

  for (const wrap of wraps) {
    const out = unwrap(wrap, recipientSecretKey)
    if (out.ok) messages.push({ rumor: out.rumor, sender: out.sender, sealedAt: out.sealedAt, wrap })
    else unreadable++
  }
  // Newest first by the rumor's own created_at. The seal and wrap timestamps
  // are random noise, and sorting by them would shuffle a conversation.
  messages.sort((a, b) => b.rumor.created_at - a.rumor.created_at)
  return { messages, unreadable }
}

/**
 * Can this session send a private message at all?
 *
 * True only when the signer holds a local secret key. Sealing needs ECDH with
 * the sender's key, which a NIP-07 extension does not hand over. When this is
 * false, say so rather than fall back to something weaker: an auth code sent
 * over NIP-04, or in the clear, is an auth code given away.
 */
export function canSealWith(signer: { secretKey?: Uint8Array } | null): boolean {
  return Boolean(signer?.secretKey)
}
