/**
 * NIP-01 events: serialisation, id, signature, verification.
 *
 * Pure: the only impurity is entropy, and only when a caller passes it in.
 *
 * Built on @noble directly, with no Nostr library underneath. nostr-tools is
 * only a dev dependency: test/vectors/nip17.test.ts uses it as an independent
 * implementation and verifies events it signed.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

/** A tag is a list of strings. The first element names it; NIP-01 says no more. */
export type NostrTag = string[]

/** What a signer is given: everything but `id` and `sig`, which it derives. */
export interface UnsignedEvent {
  pubkey: string
  created_at: number
  kind: number
  tags: NostrTag[]
  content: string
}

/** A complete event, as it travels on the wire. */
export interface NostrEvent extends UnsignedEvent {
  id: string
  sig: string
}

/**
 * The NIP-07 window.nostr surface, as an interface rather than a global.
 *
 * core/ may not touch `window`. A NIP-07 extension, the in-browser
 * generated-key fallback and the tests all implement this shape, so the code
 * above it needs no branch.
 *
 * There is no method to sign an arbitrary message because no extension offers
 * one. That is why spec/PROOF.md signs a reconstructible event id instead of a
 * bare string.
 */
export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent): Promise<NostrEvent>
}

const HEX32_RE = /^[0-9a-f]{64}$/
const HEX64_RE = /^[0-9a-f]{128}$/

/** 32 bytes of lowercase hex: an event id, or an x-only pubkey. */
export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && HEX32_RE.test(value)
}

/** 64 bytes of lowercase hex: a BIP-340 signature. */
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_RE.test(value)
}

/**
 * NIP-01's id preimage:
 *
 *   [0, <pubkey>, <created_at>, <kind>, <tags>, <content>]
 *
 * serialised as JSON with no whitespace and only the escapes NIP-01 lists.
 * `JSON.stringify` produces that for any well-formed JS string: it emits
 * `\n \r \t \b \f \" \\`, leaves every other printable character (all
 * non-ASCII included) unescaped as UTF-8, and escapes the remaining C0
 * controls as `\uXXXX`, which NIP-01 also requires. Do not replace it with a
 * hand-rolled serialiser: one byte of difference is a different event id.
 *
 * The pubkey must already be lowercase hex. An uppercase one serialises to a
 * different string, and so to an id no relay will accept.
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

/** sha256 of the NIP-01 serialisation, as bytes. This is what gets signed. */
export function eventDigest(event: UnsignedEvent): Uint8Array {
  return sha256(utf8ToBytes(serializeEvent(event)))
}

/** The same digest as lowercase hex: the event's `id`. */
export function eventId(event: UnsignedEvent): string {
  return bytesToHex(eventDigest(event))
}

/**
 * Sign an event with a raw secret key.
 *
 * `auxRand` is BIP-340's auxiliary randomness. Pass 32 bytes for a
 * deterministic signature, as every test vector in this repo does. Omit it and
 * @noble draws from the platform CSPRNG, which is the right default for a real
 * signature (it hardens against side channels) but makes the output
 * non-deterministic.
 *
 * Most signing goes through a {@link Signer} instead: a NIP-07 extension,
 * which never exposes the key.
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
 * Check an event end to end: shape, then id, then signature.
 *
 * Skipping either check is a vulnerability. Verifying the signature without
 * recomputing the id lets an attacker keep a valid signature while rewriting
 * the content it is supposed to cover, because a relay supplies the id as an
 * unchecked field. Checking the id without the signature proves only that
 * somebody ran sha256.
 *
 * Returns a reason rather than throwing: the caller is usually a loop over a
 * relay's output, where bad events are routine.
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

/** The boolean form, for filters and assertions. */
export function verifyEvent(event: unknown): event is NostrEvent {
  return checkEvent(event).ok
}

/**
 * Verify a BIP-340 signature over a digest directly.
 *
 * For a caller with a digest but no event, such as a proof record read from
 * DNS, where the event is reconstructed rather than received.
 */
export function verifyDigestSignature(sigHex: string, digest: Uint8Array, pubkeyHex: string): boolean {
  if (!isHex64(sigHex) || !isHex32(pubkeyHex)) return false
  try {
    return schnorr.verify(hexToBytes(sigHex), digest, hexToBytes(pubkeyHex))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

/** The first tag with this name, or undefined. */
export function findTag(event: Pick<UnsignedEvent, 'tags'>, name: string): NostrTag | undefined {
  return event.tags.find((t) => t[0] === name)
}

/** The value (element 1) of the first tag with this name. */
export function tagValue(event: Pick<UnsignedEvent, 'tags'>, name: string): string | undefined {
  return findTag(event, name)?.[1]
}

/** Every value of every tag with this name: `t` topics, `relay` hints, `p`s. */
export function tagValues(event: Pick<UnsignedEvent, 'tags'>, name: string): string[] {
  return event.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1])
}

/**
 * NIP-01 addressable identifier: `<kind>:<pubkey>:<d>`.
 *
 * This is the coordinate a NIP-19 `naddr` encodes and the string an `a` tag
 * carries. A replaceable event with no `d` tag addresses as `<kind>:<pubkey>:`
 * with an empty third field, which is a valid address.
 */
export function addressOf(event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>): string {
  return `${event.kind}:${event.pubkey}:${tagValue(event, 'd') ?? ''}`
}

/** Kind ranges, NIP-01 section "Kinds". Relay retention depends on these. */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000
}
export function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000
}
