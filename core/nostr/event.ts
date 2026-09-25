/**
 * NIP-01 events on @noble directly, no Nostr library. Pure apart from signing entropy.
 * nostr-tools is dev-only, as the independent implementation in test/vectors/nip17.test.ts.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

export type NostrTag = string[]

export interface UnsignedEvent {
  pubkey: string
  created_at: number
  kind: number
  tags: NostrTag[]
  content: string
}

export interface NostrEvent extends UnsignedEvent {
  id: string
  sig: string
}

/**
 * NIP-07 window.nostr as an interface, since core/ may not touch `window`.
 * Extensions can't sign arbitrary messages, so spec/PROOF.md signs a reconstructible event id.
 */
export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent): Promise<NostrEvent>
}

const HEX32_RE = /^[0-9a-f]{64}$/
const HEX64_RE = /^[0-9a-f]{128}$/

/** 32 bytes, lowercase hex. An event id or x-only pubkey. */
export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && HEX32_RE.test(value)
}

/** 64 bytes, lowercase hex. A BIP-340 signature. */
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_RE.test(value)
}

/**
 * NIP-01 id preimage `[0, pubkey, created_at, kind, tags, content]` as compact JSON.
 * JSON.stringify emits exactly the escapes NIP-01 wants for any well-formed string.
 * Don't hand-roll a serialiser. One byte off is a different id.
 */
export function serializeEvent(event: UnsignedEvent): string {
  assertSerialisable(event)
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
}

function assertSerialisable(event: UnsignedEvent): void {
  if (!isHex32(event.pubkey)) {
    throw new Error(`serializeEvent: pubkey must be 64 lowercase hex characters, got ${show(event.pubkey)}`)
  }
  if (!Number.isInteger(event.created_at) || event.created_at < 0) {
    throw new Error(`serializeEvent: created_at must be a non-negative integer, got ${show(event.created_at)}`)
  }
  if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 65535) {
    throw new Error(`serializeEvent: kind must be an integer in 0..65535, got ${show(event.kind)}`)
  }
  if (typeof event.content !== 'string') {
    throw new Error(`serializeEvent: content must be a string, got ${show(event.content)}`)
  }
  if (!Array.isArray(event.tags)) {
    throw new Error(`serializeEvent: tags must be an array, got ${show(event.tags)}`)
  }
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.some((v) => typeof v !== 'string')) {
      throw new Error(`serializeEvent: every tag must be an array of strings, got ${show(tag)}`)
    }
  }
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  return String(value)
}

/** sha256 of the serialisation. This is what gets signed. */
export function eventDigest(event: UnsignedEvent): Uint8Array {
  return sha256(utf8ToBytes(serializeEvent(event)))
}

export function eventId(event: UnsignedEvent): string {
  return bytesToHex(eventDigest(event))
}

/**
 * Sign with a raw secret key. 32 bytes of BIP-340 `auxRand` give a deterministic sig,
 * as the test vectors use. Omit it for real signing and @noble uses the CSPRNG (side-channel hardening).
 * Most signing goes through a {@link Signer}, which never exposes the key.
 */
export function signEvent(
  unsigned: UnsignedEvent,
  secretKey: Uint8Array,
  auxRand?: Uint8Array,
): NostrEvent {
  const derived = bytesToHex(schnorr.getPublicKey(secretKey))
  if (derived !== unsigned.pubkey) {
    throw new Error(
      `signEvent: this key is ${derived}, but the event claims ${show(unsigned.pubkey)}; ` +
        'a signature under the wrong pubkey verifies nowhere',
    )
  }
  const digest = eventDigest(unsigned)
  const sig = auxRand ? schnorr.sign(digest, secretKey, auxRand) : schnorr.sign(digest, secretKey)
  return { ...unsigned, id: bytesToHex(digest), sig: bytesToHex(sig) }
}

/**
 * Checks shape, then id, then sig. Both crypto checks are required. Relays supply `id`
 * unchecked, so a sig check alone lets content be rewritten under a valid sig.
 * An id check alone proves only that someone ran sha256.
 * Returns a reason instead of throwing. Bad events from relays are routine.
 */
export function checkEvent(event: unknown): { ok: true; event: NostrEvent } | { ok: false; reason: string } {
  if (typeof event !== 'object' || event === null) return { ok: false, reason: 'not an object' }
  const e = event as Record<string, unknown>
  if (!isHex32(e.id)) return { ok: false, reason: 'id is not 64 lowercase hex characters' }
  if (!isHex64(e.sig)) return { ok: false, reason: 'sig is not 128 lowercase hex characters' }

  let digest: Uint8Array
  try {
    digest = eventDigest(e as unknown as UnsignedEvent)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }

  const computed = bytesToHex(digest)
  if (computed !== e.id) {
    return { ok: false, reason: `id mismatch: the content hashes to ${computed}, not ${e.id as string}` }
  }

  let valid: boolean
  try {
    valid = schnorr.verify(hexToBytes(e.sig as string), digest, hexToBytes(e.pubkey as string))
  } catch (err) {
    return { ok: false, reason: `signature did not parse: ${(err as Error).message}` }
  }
  if (!valid) return { ok: false, reason: 'signature does not verify under this pubkey' }

  return { ok: true, event: e as unknown as NostrEvent }
}

/** Boolean form of checkEvent. */
export function verifyEvent(event: unknown): event is NostrEvent {
  return checkEvent(event).ok
}

/** BIP-340 check over a bare digest, for events rebuilt locally (e.g. a DNS proof record). */
export function verifyDigestSignature(sigHex: string, digest: Uint8Array, pubkeyHex: string): boolean {
  if (!isHex64(sigHex) || !isHex32(pubkeyHex)) return false
  try {
    return schnorr.verify(hexToBytes(sigHex), digest, hexToBytes(pubkeyHex))
  } catch {
    return false
  }
}

export function findTag(event: Pick<UnsignedEvent, 'tags'>, name: string): NostrTag | undefined {
  return event.tags.find((t) => t[0] === name)
}

export function tagValue(event: Pick<UnsignedEvent, 'tags'>, name: string): string | undefined {
  return findTag(event, name)?.[1]
}

export function tagValues(event: Pick<UnsignedEvent, 'tags'>, name: string): string[] {
  return event.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1])
}

/**
 * NIP-01 address `<kind>:<pubkey>:<d>`, as in a NIP-19 naddr or an `a` tag.
 * With no `d` tag the third field is empty, which is still valid.
 */
export function addressOf(event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>): string {
  return `${event.kind}:${event.pubkey}:${tagValue(event, 'd') ?? ''}`
}

/** NIP-01 kind ranges. Relay retention depends on them. */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000
}
export function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000
}
