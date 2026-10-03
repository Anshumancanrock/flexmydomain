// NIP-17 DMs in the browser. Draws the randomness core/nostr/nip17.ts takes as arguments.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  MAX_TIMESTAMP_JITTER,
  buildRumor,
  giftWrap,
  giftWrapWith,
  unwrap,
  unwrapWith,
  type NostrEvent,
  type NostrTag,
  type Rumor,
  type Signer,
} from '../core/nostr/index.js'

export function wrapEntropy(now: number): {
  ephemeralSecretKey: Uint8Array
  sealNonce: Uint8Array
  wrapNonce: Uint8Array
  sealCreatedAt: number
  wrapCreatedAt: number
} {
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
    let out: ReturnType<typeof unwrap>
    try {
      out = unwrap(wrap, recipientSecretKey)
    } catch {
      unreadable++
      continue
    }
    if (out.ok) messages.push({ rumor: out.rumor, sender: out.sender, sealedAt: out.sealedAt, wrap })
    else unreadable++
  }
  messages.sort((a, b) => b.rumor.created_at - a.rumor.created_at)
  return { messages, unreadable }
}

/** When false, say so and never fall back. A secret over NIP-04 or in the clear is given away. */
export function canSealWith(signer: { secretKey?: Uint8Array; nip44?: unknown } | null): boolean {
  return Boolean(signer?.secretKey || signer?.nip44)
}

export function wrapForEach(rumor: Rumor, senderSecretKey: Uint8Array, recipients: readonly string[], now: number): NostrEvent[] {
  return [...new Set(recipients)].map((recipient) =>
    giftWrap({ rumor, senderSecretKey, recipient, entropy: wrapEntropy(now) }))
}

/** As wrapForEach, sealed by a signer that encrypts for itself, such as a NIP-07 extension. */
export async function wrapForEachWith(rumor: Rumor, signer: Signer, recipients: readonly string[], now: number): Promise<NostrEvent[]> {
  const out: NostrEvent[] = []
  // One at a time: an extension asks its user about each, and parallel prompts confuse.
  for (const recipient of new Set(recipients)) out.push(await giftWrapWith({ rumor, signer, recipient, entropy: wrapEntropy(now) }))
  return out
}

/** As readMessages, opened through a signer's NIP-44. Each wrap costs the signer two decrypts. */
export async function readMessagesWith(
  wraps: readonly NostrEvent[],
  signer: Signer,
): Promise<{ messages: { rumor: Rumor; sender: string; sealedAt: number; wrap: NostrEvent }[]; unreadable: number }> {
  const nip44 = signer.nip44
  if (!nip44) return { messages: [], unreadable: wraps.length }
  const messages: { rumor: Rumor; sender: string; sealedAt: number; wrap: NostrEvent }[] = []
  let unreadable = 0
  for (const wrap of wraps) {
    const out = await unwrapWith(wrap, (peer, payload) => nip44.decrypt(peer, payload)).catch(() => ({ ok: false as const, reason: '' }))
    if (out.ok) messages.push({ rumor: out.rumor, sender: out.sender, sealedAt: out.sealedAt, wrap })
    else unreadable++
  }
  messages.sort((a, b) => b.rumor.created_at - a.rumor.created_at)
  return { messages, unreadable }
}
