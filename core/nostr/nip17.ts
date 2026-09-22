/**
 * NIP-17 private direct messages, over NIP-59 gift wrap and NIP-44.
 *
 * Pure: all entropy comes from the caller. client/messages.ts draws it in the
 * browser.
 *
 * This is how the registrar auth code travels from seller to buyer. Whoever
 * holds that code can take the domain, and sent this way only the recipient
 * can read it: the site cannot read it, be compelled to produce it, or lose
 * it.
 *
 * Three layers, each hiding something different:
 *
 *   rumor      kind 14, unsigned. The message itself. A signature would be a
 *              transferable proof of who said what, so leaving it out makes
 *              the conversation deniable.
 *   seal       kind 13, signed by the sender's real key, encrypted to the
 *              recipient. Hides the content from everyone else.
 *   gift wrap  kind 1059, signed by a throwaway key, encrypted to the
 *              recipient. Hides the sender from the relay.
 *
 * A relay storing a gift wrap learns only that somebody sent something to
 * this pubkey, at a timestamp fuzzed into the past.
 */

import { conversationKey, decrypt, encrypt } from './nip44.js'
import { checkEvent, eventId, isHex32, signEvent, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** NIP-17 chat message. */
export const CHAT_KIND = 14
/** NIP-59 seal. */
export const SEAL_KIND = 13
/** NIP-59 gift wrap. */
export const GIFT_WRAP_KIND = 1059

/**
 * How far into the past a timestamp may be fuzzed. NIP-59 suggests two days.
 *
 * A relay then cannot correlate a seal and its wrap by their clocks, nor tell
 * when a conversation happened.
 */
export const MAX_TIMESTAMP_JITTER = 2 * 24 * 60 * 60

/** An unsigned message. `id` is computed so it can be referenced; `sig` never exists. */
export interface Rumor extends UnsignedEvent {
  id: string
}

/** Everything random a wrap needs, supplied by the caller so core stays pure. */
export interface WrapEntropy {
  /** A throwaway key, used for one wrap and then discarded. */
  ephemeralSecretKey: Uint8Array
  /** 32 bytes, fresh. Reusing a nonce under one conversation key leaks plaintext. */
  sealNonce: Uint8Array
  wrapNonce: Uint8Array
  /** Both fuzzed backwards, independently. */
  sealCreatedAt: number
  wrapCreatedAt: number
}

/**
 * Build the unsigned message.
 *
 * `subject` is optional. It is inside the encryption like everything else, so
 * only the recipient sees it.
 */
export function buildRumor(params: {
  pubkey: string
  recipient: string
  content: string
  createdAt: number
  subject?: string
  /** Extra tags, e.g. an `a` pointing at the escrow this message concerns. */
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

/**
 * Seal and wrap a rumor for one recipient.
 *
 * Returns the kind 1059 to publish. Nothing in it ties the wrap to the
 * sender: its author is the ephemeral key, which the caller should discard as
 * soon as this returns.
 */
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
    // unwrap checks this on the recipient's side, so a wrap whose rumor
    // claims another author would only be discarded.
    throw new Error('giftWrap: the rumor claims an author other than the signing key')
  }

  // Layer 2, the seal: signed by the real key, so the recipient learns who
  // wrote it. It is encrypted to them, so nobody else can.
  const sealed = signEvent(
    {
      pubkey: senderPubkey,
      created_at: entropy.sealCreatedAt,
      kind: SEAL_KIND,
      // No `p` tag. A seal that names its recipient in the clear would undo
      // the wrap it is about to go inside.
      tags: [],
      content: encrypt(JSON.stringify(rumor), conversationKey(senderSecretKey, recipient), entropy.sealNonce),
    },
    senderSecretKey,
  )

  // Layer 3, the wrap: signed by a key that exists for this one message.
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
 * Unwrap a gift wrap addressed to the holder of `recipientSecretKey`.
 *
 * The check that matters is that the rumor's author equals the seal's author.
 * Without it anyone could sign a seal with their own key, put a
 * counterparty's pubkey in the rumor, and have the message render as coming
 * from that counterparty. For an auth-code handover that is the attack: a
 * forged "here is the code" from a stranger.
 *
 * Returns a reason instead of throwing, because the caller loops over a
 * relay's output and many wraps in it are not for this key.
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
    // Usually just "not addressed to this key", which is the common case when
    // sweeping a relay, so it is a reason rather than an alarm.
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
    // A signed rumor is a transferable proof of authorship, which NIP-17
    // leaves out on purpose. Refuse one rather than accept it quietly.
    return { ok: false, reason: 'a rumor must not be signed' }
  }

  const expectedId = eventId(rumor)
  if (rumor.id !== expectedId) return { ok: false, reason: 'the message id does not cover its own content' }

  return { ok: true, rumor, sender: seal.pubkey, sealedAt: seal.created_at }
}

/** The filter that fetches gift wraps addressed to a key. */
export function giftWrapFilter(recipient: string, since?: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [GIFT_WRAP_KIND], '#p': [recipient] }
  // Wraps are backdated by up to two days, so a caller asking for "since I last
  // looked" has to look further back than that or it will miss messages.
  if (since !== undefined) filter.since = since - MAX_TIMESTAMP_JITTER
  return filter
}
