/**
 * NIP-17 DMs over NIP-59 gift wrap and NIP-44. Pure, the caller supplies all entropy.
 * Carries the registrar auth code from seller to buyer. Only the recipient can read it.
 *
 *   rumor      kind 14, unsigned so the chat stays deniable.
 *   seal       kind 13, signed by the sender's real key, encrypted to the recipient. Hides content.
 *   gift wrap  kind 1059, signed by a throwaway key, encrypted to the recipient. Hides the sender.
 *
 * A relay learns only that someone sent this pubkey something, at a backdated time.
 */

import { conversationKey, decrypt, encrypt } from './nip44.js'
import { checkEvent, eventId, isHex32, signEvent, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const CHAT_KIND = 14
export const SEAL_KIND = 13
export const GIFT_WRAP_KIND = 1059

/**
 * Max backdating in seconds. NIP-59 suggests two days, so a relay can't match
 * a seal to its wrap by clock or tell when a conversation happened.
 */
export const MAX_TIMESTAMP_JITTER = 2 * 24 * 60 * 60

/** Unsigned. `id` is computed for references, `sig` never exists. */
export interface Rumor extends UnsignedEvent {
  id: string
}

export interface WrapEntropy {
  /** One wrap only, then discard. */
  ephemeralSecretKey: Uint8Array
  /** 32 bytes each, fresh. Nonce reuse under one conversation key leaks plaintext. */
  sealNonce: Uint8Array
  wrapNonce: Uint8Array
  /** Each backdated independently. */
  sealCreatedAt: number
  wrapCreatedAt: number
}

/** Unsigned kind 14. `subject` is encrypted with the rest. */
export function buildRumor(params: {
  pubkey: string
  recipient: string
  content: string
  createdAt: number
  subject?: string
  /** E.g. an `a` for the escrow this message is about. */
  tags?: NostrTag[]
}): Rumor {
  if (!isHex32(params.pubkey)) throw new Error('buildRumor: pubkey must be 64 lowercase hex characters')
  if (!isHex32(params.recipient)) throw new Error('buildRumor: recipient must be 64 lowercase hex characters')

  const tags: NostrTag[] = [['p', params.recipient], ...(params.tags ?? [])]
  if (params.subject) tags.push(['subject', params.subject])

  const unsigned: UnsignedEvent = {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: CHAT_KIND,
    tags,
    content: params.content,
  }
  return { ...unsigned, id: eventId(unsigned) }
}

/** Seal and wrap for one recipient. Returns the kind 1059. Discard the ephemeral key after. */
export function giftWrap(params: {
  rumor: Rumor
  senderSecretKey: Uint8Array
  recipient: string
  entropy: WrapEntropy
}): NostrEvent {
  const { rumor, senderSecretKey, recipient, entropy } = params
  if (!isHex32(recipient)) throw new Error('giftWrap: recipient must be 64 lowercase hex characters')

  const senderPubkey = bytesToHex(schnorr.getPublicKey(senderSecretKey))
  if (rumor.pubkey !== senderPubkey) {
    // The recipient's unwrap would discard it anyway.
    throw new Error('giftWrap: the rumor claims an author other than the signing key')
  }

  // Seal, signed by the real key.
  const sealed = signEvent(
    {
      pubkey: senderPubkey,
      created_at: entropy.sealCreatedAt,
      kind: SEAL_KIND,
      // No `p` tag. Naming the recipient in the clear would undo the wrap.
      tags: [],
      content: encrypt(JSON.stringify(rumor), conversationKey(senderSecretKey, recipient), entropy.sealNonce),
    },
    senderSecretKey,
  )

  // Wrap, signed by the one-off key.
  const ephemeralPubkey = bytesToHex(schnorr.getPublicKey(entropy.ephemeralSecretKey))
  return signEvent(
    {
      pubkey: ephemeralPubkey,
      created_at: entropy.wrapCreatedAt,
      kind: GIFT_WRAP_KIND,
      tags: [['p', recipient]],
      content: encrypt(
        JSON.stringify(sealed),
        conversationKey(entropy.ephemeralSecretKey, recipient),
        entropy.wrapNonce,
      ),
    },
    entropy.ephemeralSecretKey,
  )
}

/**
 * The key check is rumor author == seal author. Without it anyone could seal with
 * their own key, put a counterparty's pubkey in the rumor and forge "here is the code".
 * Returns a reason instead of throwing. Most wraps on a relay aren't for this key.
 */
export function unwrap(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
): { ok: true; rumor: Rumor; sender: string; sealedAt: number } | { ok: false; reason: string } {
  if (wrap.kind !== GIFT_WRAP_KIND) return { ok: false, reason: `kind ${wrap.kind} is not ${GIFT_WRAP_KIND}` }

  const outer = checkEvent(wrap)
  if (!outer.ok) return { ok: false, reason: `gift wrap: ${outer.reason}` }

  let sealJson: string
  try {
    sealJson = decrypt(wrap.content, conversationKey(recipientSecretKey, wrap.pubkey))
  } catch (err) {
    // Usually just not addressed to this key.
    return { ok: false, reason: `gift wrap does not decrypt to this key: ${(err as Error).message}` }
  }

  let seal: NostrEvent
  try {
    seal = JSON.parse(sealJson) as NostrEvent
  } catch {
    return { ok: false, reason: 'the wrapped payload is not JSON' }
  }
  if (seal?.kind !== SEAL_KIND) return { ok: false, reason: 'the wrapped payload is not a seal' }

  const inner = checkEvent(seal)
  if (!inner.ok) return { ok: false, reason: `seal: ${inner.reason}` }

  let rumorJson: string
  try {
    rumorJson = decrypt(seal.content, conversationKey(recipientSecretKey, seal.pubkey))
  } catch (err) {
    return { ok: false, reason: `seal does not decrypt: ${(err as Error).message}` }
  }

  let rumor: Rumor
  try {
    rumor = JSON.parse(rumorJson) as Rumor
  } catch {
    return { ok: false, reason: 'the sealed payload is not JSON' }
  }

  if (rumor?.pubkey !== seal.pubkey) {
    return { ok: false, reason: 'the message claims an author the seal was not signed by' }
  }
  if ('sig' in rumor && (rumor as { sig?: unknown }).sig !== undefined) {
    // A signed rumor is transferable proof of authorship, which NIP-17 leaves out.
    return { ok: false, reason: 'a rumor must not be signed' }
  }

  const expectedId = eventId(rumor)
  if (rumor.id !== expectedId) return { ok: false, reason: 'the message id does not cover its own content' }

  return { ok: true, rumor, sender: seal.pubkey, sealedAt: seal.created_at }
}

export function giftWrapFilter(recipient: string, since?: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [GIFT_WRAP_KIND], '#p': [recipient] }
  // Wraps are backdated, so widen `since` by the max jitter or miss messages.
  if (since !== undefined) filter.since = since - MAX_TIMESTAMP_JITTER
  return filter
}
