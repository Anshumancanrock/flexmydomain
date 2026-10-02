// NIP-17 DMs over NIP-59 gift wrap and NIP-44. Pure, the caller supplies all entropy.

import { conversationKey, decrypt, encrypt } from './nip44.js'
import { checkEvent, eventId, isHex32, signEvent, type NostrEvent, type NostrTag, type Signer, type UnsignedEvent } from './event.js'
import { normaliseRelayUrl } from './relays.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const CHAT_KIND = 14
export const SEAL_KIND = 13
export const GIFT_WRAP_KIND = 1059
/** NIP-17's list of the relays a key reads its private messages from. */
export const DM_RELAY_LIST_KIND = 10050

/** Max backdating in seconds. */
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
  sealCreatedAt: number
  wrapCreatedAt: number
}

export function buildRumor(params: {
  pubkey: string
  recipient: string
  content: string
  createdAt: number
  subject?: string
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
    throw new Error('giftWrap: the rumor claims an author other than the signing key')
  }

  const sealed = signEvent(
    {
      pubkey: senderPubkey,
      created_at: entropy.sealCreatedAt,
      kind: SEAL_KIND,
      tags: [],
      content: encrypt(JSON.stringify(rumor), conversationKey(senderSecretKey, recipient), entropy.sealNonce),
    },
    senderSecretKey,
  )

  return wrapSeal(sealed, recipient, entropy)
}

/** Wrap, signed by the one-off key, so the outside names only the recipient. */
function wrapSeal(sealed: NostrEvent, recipient: string, entropy: WrapEntropy): NostrEvent {
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

export async function giftWrapWith(params: {
  rumor: Rumor
  signer: Signer
  recipient: string
  entropy: WrapEntropy
}): Promise<NostrEvent> {
  const { rumor, signer, recipient, entropy } = params
  if (!isHex32(recipient)) throw new Error('giftWrapWith: recipient must be 64 lowercase hex characters')
  if (!signer.nip44) throw new Error('giftWrapWith: this signer cannot encrypt private messages')
  if ((await signer.getPublicKey()) !== rumor.pubkey) {
    throw new Error('giftWrapWith: the rumor claims an author other than the signing key')
  }
  const content = await signer.nip44.encrypt(recipient, JSON.stringify(rumor))
  const sealed = await signer.signEvent({ pubkey: rumor.pubkey, created_at: entropy.sealCreatedAt, kind: SEAL_KIND, tags: [], content })
  const checked = checkEvent(sealed)
  if (!checked.ok || sealed.pubkey !== rumor.pubkey || sealed.kind !== SEAL_KIND) {
    throw new Error('giftWrapWith: the signer returned a seal that does not verify')
  }
  return wrapSeal(sealed, recipient, entropy)
}

type Unwrapped = { ok: true; rumor: Rumor; sender: string; sealedAt: number } | { ok: false; reason: string }

function outerProblem(wrap: NostrEvent): string | undefined {
  if (wrap.kind !== GIFT_WRAP_KIND) return `kind ${wrap.kind} is not ${GIFT_WRAP_KIND}`
  const outer = checkEvent(wrap)
  return outer.ok ? undefined : `gift wrap: ${outer.reason}`
}

function readSeal(sealJson: string): { ok: true; seal: NostrEvent } | { ok: false; reason: string } {
  let seal: NostrEvent
  try {
    seal = JSON.parse(sealJson) as NostrEvent
  } catch {
    return { ok: false, reason: 'the wrapped payload is not JSON' }
  }
  if (seal?.kind !== SEAL_KIND) return { ok: false, reason: 'the wrapped payload is not a seal' }
  const inner = checkEvent(seal)
  if (!inner.ok) return { ok: false, reason: `seal: ${inner.reason}` }
  return { ok: true, seal }
}

function readRumor(seal: NostrEvent, rumorJson: string): Unwrapped {
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

  // A malformed rumor would throw here, and one bad message must not hide the rest.
  let expectedId: string
  try {
    expectedId = eventId(rumor)
  } catch (err) {
    return { ok: false, reason: `the message is malformed: ${(err as Error).message}` }
  }
  if (rumor.id !== expectedId) return { ok: false, reason: 'the message id does not cover its own content' }

  return { ok: true, rumor, sender: seal.pubkey, sealedAt: seal.created_at }
}

export function unwrap(wrap: NostrEvent, recipientSecretKey: Uint8Array): Unwrapped {
  const problem = outerProblem(wrap)
  if (problem) return { ok: false, reason: problem }

  let sealJson: string
  try {
    sealJson = decrypt(wrap.content, conversationKey(recipientSecretKey, wrap.pubkey))
  } catch (err) {
    return { ok: false, reason: `gift wrap does not decrypt to this key: ${(err as Error).message}` }
  }
  const sealed = readSeal(sealJson)
  if (!sealed.ok) return sealed

  let rumorJson: string
  try {
    rumorJson = decrypt(sealed.seal.content, conversationKey(recipientSecretKey, sealed.seal.pubkey))
  } catch (err) {
    return { ok: false, reason: `seal does not decrypt: ${(err as Error).message}` }
  }
  return readRumor(sealed.seal, rumorJson)
}

export async function unwrapWith(
  wrap: NostrEvent,
  decryptFrom: (peer: string, payload: string) => Promise<string>,
): Promise<Unwrapped> {
  const problem = outerProblem(wrap)
  if (problem) return { ok: false, reason: problem }

  let sealJson: string
  try {
    sealJson = await decryptFrom(wrap.pubkey, wrap.content)
  } catch (err) {
    return { ok: false, reason: `gift wrap does not decrypt to this key: ${(err as Error).message}` }
  }
  const sealed = readSeal(sealJson)
  if (!sealed.ok) return sealed

  let rumorJson: string
  try {
    rumorJson = await decryptFrom(sealed.seal.pubkey, sealed.seal.content)
  } catch (err) {
    return { ok: false, reason: `seal does not decrypt: ${(err as Error).message}` }
  }
  return readRumor(sealed.seal, rumorJson)
}

export function giftWrapFilter(recipient: string, since?: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [GIFT_WRAP_KIND], '#p': [recipient] }
  if (since !== undefined) filter.since = since - MAX_TIMESTAMP_JITTER
  return filter
}

export function dmRelaysOf(event: NostrEvent): string[] {
  if (event.kind !== DM_RELAY_LIST_KIND) return []
  const urls = event.tags.filter((t) => t[0] === 'relay').map((t) => normaliseRelayUrl(t[1])).filter((u): u is string => u !== undefined)
  return [...new Set(urls)]
}

export function dmRelayListFilter(pubkeys: readonly string[]): Record<string, unknown> {
  return { kinds: [DM_RELAY_LIST_KIND], authors: [...pubkeys] }
}
