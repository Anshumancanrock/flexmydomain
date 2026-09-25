// NIP-17 DMs in the browser. Draws the randomness core/nostr/nip17.ts takes as arguments.
// Sealing needs the sender's secret key for ECDH, and NIP-07 never exposes it,
// so only a local key can seal.

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
  /* Jitter each timestamp independently. A shared offset lets a relay pair seal and wrap. */
  const jitter = () => now - Math.floor(Math.random() * MAX_TIMESTAMP_JITTER)
  return {
    ephemeralSecretKey: schnorr.utils.randomSecretKey(),
    sealNonce: crypto.getRandomValues(new Uint8Array(32)),
    wrapNonce: crypto.getRandomValues(new Uint8Array(32)),
    sealCreatedAt: jitter(),
    wrapCreatedAt: jitter(),
  }
}

/** The ephemeral key from {@link wrapEntropy} never leaves this call. */
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

/** Most wraps are for somebody else and fail to decrypt. That's normal, so they're only counted. */
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
  // By the rumor's created_at. Seal and wrap timestamps are random noise.
  messages.sort((a, b) => b.rumor.created_at - a.rumor.created_at)
  return { messages, unreadable }
}

/** When false, say so and never fall back. An auth code over NIP-04 or in the clear is given away. */
export function canSealWith(signer: { secretKey?: Uint8Array } | null): boolean {
  return Boolean(signer?.secretKey)
}
