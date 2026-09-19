/**
 * NIP-19 bech32 entities: npub, nsec, note, nprofile, nevent, naddr.
 *
 * A listing is shared as an `naddr`, not as a URL on any server. Whoever has
 * one can open the listing in any client, from any relay, whether or not this
 * site still exists.
 */

import { bech32 } from '@scure/base'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { isHex32 } from './event.js'

/**
 * bech32's 90-character limit is a BIP-173 rule for Bitcoin addresses, where
 * it bounds the error-correction properties. NIP-19 entities carry relay
 * hints and identifiers and routinely run past it, so the limit is raised
 * rather than honoured. Every Nostr implementation does the same.
 */
const BECH32_LIMIT = 5000

/** TLV types, NIP-19. `special` means "whatever this entity is mainly about". */
const TLV_SPECIAL = 0
const TLV_RELAY = 1
const TLV_AUTHOR = 2
const TLV_KIND = 3

export type Nip19Prefix = 'npub' | 'nsec' | 'note' | 'nprofile' | 'nevent' | 'naddr'

export interface ProfilePointer {
  pubkey: string
  relays?: string[]
}

export interface EventPointer {
  id: string
  relays?: string[]
  author?: string
  kind?: number
}

/** NIP-01's addressable coordinate, as the three fields it is made of. */
export interface AddressPointer {
  identifier: string
  pubkey: string
  kind: number
  relays?: string[]
}

export type DecodedNip19 =
  | { type: 'npub'; data: string }
  | { type: 'nsec'; data: Uint8Array }
  | { type: 'note'; data: string }
  | { type: 'nprofile'; data: ProfilePointer }
  | { type: 'nevent'; data: EventPointer }
  | { type: 'naddr'; data: AddressPointer }

// ---------------------------------------------------------------------------
// the bare forms
// ---------------------------------------------------------------------------

function encodeBytes(prefix: string, bytes: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT)
}

/** An x-only pubkey as `npub1…`. */
export function npubEncode(pubkeyHex: string): string {
  if (!isHex32(pubkeyHex)) throw new Error(`npubEncode: expected 64 lowercase hex characters, got ${JSON.stringify(pubkeyHex)}`)
  return encodeBytes('npub', hexToBytes(pubkeyHex))
}

/** An event id as `note1…`. */
export function noteEncode(idHex: string): string {
  if (!isHex32(idHex)) throw new Error(`noteEncode: expected 64 lowercase hex characters, got ${JSON.stringify(idHex)}`)
  return encodeBytes('note', hexToBytes(idHex))
}

/**
 * A secret key as `nsec1…`.
 *
 * Exists for the in-browser generated-key fallback, which must show the user
 * something to write down, and `nsec` is the form other clients accept.
 * Nothing else in this repository may call it, and nothing may log, store or
 * transmit its output.
 */
export function nsecEncode(secretKey: Uint8Array): string {
  if (secretKey.length !== 32) throw new Error('nsecEncode: a secret key is 32 bytes')
  return encodeBytes('nsec', secretKey)
}

// ---------------------------------------------------------------------------
// the TLV forms
// ---------------------------------------------------------------------------

function tlv(type: number, value: Uint8Array): Uint8Array {
  if (value.length > 255) {
    // NIP-19 gives the length one byte. A relay URL longer than 255 bytes is
    // not a real relay URL, so this is a caller error. A continuation scheme
    // could work around it, but no other implementation would read one.
    throw new Error(`nip19: a TLV value of ${value.length} bytes does not fit in one length byte`)
  }
  const out = new Uint8Array(2 + value.length)
  out[0] = type
  out[1] = value.length
  out.set(value, 2)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function relayParts(relays: string[] | undefined): Uint8Array[] {
  return (relays ?? []).map((r) => tlv(TLV_RELAY, utf8ToBytes(r)))
}

function kindBytes(kind: number): Uint8Array {
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xffffffff) {
    throw new Error(`nip19: kind must be a uint32, got ${kind}`)
  }
  // Big-endian, four bytes. NIP-19 says so, and a little-endian kind decodes
  // to a plausible-looking wrong number rather than to an error.
  return Uint8Array.of((kind >>> 24) & 0xff, (kind >>> 16) & 0xff, (kind >>> 8) & 0xff, kind & 0xff)
}

export function nprofileEncode(pointer: ProfilePointer): string {
  if (!isHex32(pointer.pubkey)) throw new Error('nprofileEncode: pubkey must be 64 lowercase hex characters')
  return encodeBytes(
    'nprofile',
    concat([tlv(TLV_SPECIAL, hexToBytes(pointer.pubkey)), ...relayParts(pointer.relays)]),
  )
}

export function neventEncode(pointer: EventPointer): string {
  if (!isHex32(pointer.id)) throw new Error('neventEncode: id must be 64 lowercase hex characters')
  const parts = [tlv(TLV_SPECIAL, hexToBytes(pointer.id)), ...relayParts(pointer.relays)]
  if (pointer.author !== undefined) {
    if (!isHex32(pointer.author)) throw new Error('neventEncode: author must be 64 lowercase hex characters')
    parts.push(tlv(TLV_AUTHOR, hexToBytes(pointer.author)))
  }
  if (pointer.kind !== undefined) parts.push(tlv(TLV_KIND, kindBytes(pointer.kind)))
  return encodeBytes('nevent', concat(parts))
}

/**
 * `naddr1…`: a pointer to an addressable event by (kind, author, d).
 *
 * Listings are shared this way. An naddr survives the seller editing the
 * price, because it names the coordinate rather than one version.
 */
export function naddrEncode(pointer: AddressPointer): string {
  if (!isHex32(pointer.pubkey)) throw new Error('naddrEncode: pubkey must be 64 lowercase hex characters')
  return encodeBytes(
    'naddr',
    concat([
      tlv(TLV_SPECIAL, utf8ToBytes(pointer.identifier)),
      ...relayParts(pointer.relays),
      tlv(TLV_AUTHOR, hexToBytes(pointer.pubkey)),
      tlv(TLV_KIND, kindBytes(pointer.kind)),
    ]),
  )
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

function parseTlv(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const found = new Map<number, Uint8Array[]>()
  let at = 0
  while (at < bytes.length) {
    if (at + 2 > bytes.length) throw new Error('nip19: truncated TLV header')
    const type = bytes[at]
    const length = bytes[at + 1]
    const start = at + 2
    if (start + length > bytes.length) throw new Error('nip19: TLV value runs past the end')
    const list = found.get(type)
    const value = bytes.slice(start, start + length)
    if (list) list.push(value)
    else found.set(type, [value])
    at = start + length
  }
  return found
}

function decodeRelays(found: Map<number, Uint8Array[]>): string[] | undefined {
  const raw = found.get(TLV_RELAY)
  if (!raw || raw.length === 0) return undefined
  return raw.map((b) => new TextDecoder().decode(b))
}

function decodeKind(found: Map<number, Uint8Array[]>): number | undefined {
  const raw = found.get(TLV_KIND)?.[0]
  if (!raw) return undefined
  if (raw.length !== 4) throw new Error('nip19: a kind TLV must be exactly four bytes')
  return ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0
}

/**
 * Decode any NIP-19 entity, or throw with a reason.
 *
 * Rejects an unknown prefix rather than guessing. One of the valid prefixes
 * marks a secret key, so a near-miss must fail rather than be read as the
 * closest match.
 */
export function decodeNip19(value: string): DecodedNip19 {
  const trimmed = value.trim().replace(/^nostr:/i, '')
  const { prefix, words } = bech32.decode(trimmed as `${string}1${string}`, BECH32_LIMIT)
  const bytes = bech32.fromWords(words)

  switch (prefix) {
    case 'npub':
      assertLength(bytes, 32, 'npub')
      return { type: 'npub', data: bytesToHex(bytes) }
    case 'note':
      assertLength(bytes, 32, 'note')
      return { type: 'note', data: bytesToHex(bytes) }
    case 'nsec':
      assertLength(bytes, 32, 'nsec')
      return { type: 'nsec', data: bytes }
    case 'nprofile': {
      const found = parseTlv(bytes)
      const special = found.get(TLV_SPECIAL)?.[0]
      if (!special || special.length !== 32) throw new Error('nip19: nprofile has no 32-byte pubkey')
      return { type: 'nprofile', data: { pubkey: bytesToHex(special), relays: decodeRelays(found) } }
    }
    case 'nevent': {
      const found = parseTlv(bytes)
      const special = found.get(TLV_SPECIAL)?.[0]
      if (!special || special.length !== 32) throw new Error('nip19: nevent has no 32-byte event id')
      const author = found.get(TLV_AUTHOR)?.[0]
      if (author && author.length !== 32) throw new Error('nip19: nevent author is not 32 bytes')
      return {
        type: 'nevent',
        data: {
          id: bytesToHex(special),
          relays: decodeRelays(found),
          author: author ? bytesToHex(author) : undefined,
          kind: decodeKind(found),
        },
      }
    }
    case 'naddr': {
      const found = parseTlv(bytes)
      const special = found.get(TLV_SPECIAL)?.[0]
      const author = found.get(TLV_AUTHOR)?.[0]
      const kind = decodeKind(found)
      if (special === undefined) throw new Error('nip19: naddr has no identifier')
      if (!author || author.length !== 32) throw new Error('nip19: naddr has no 32-byte author')
      if (kind === undefined) throw new Error('nip19: naddr has no kind')
      return {
        type: 'naddr',
        data: {
          identifier: new TextDecoder().decode(special),
          pubkey: bytesToHex(author),
          kind,
          relays: decodeRelays(found),
        },
      }
    }
    default:
      throw new Error(`nip19: unknown prefix ${JSON.stringify(prefix)}`)
  }
}

function assertLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error(`nip19: ${what} must carry ${expected} bytes, found ${bytes.length}`)
  }
}

/** The non-throwing form, for anything reading user input. */
export function tryDecodeNip19(value: unknown): DecodedNip19 | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return decodeNip19(value)
  } catch {
    return undefined
  }
}

/**
 * Accept an npub, an nprofile or bare hex, and return hex.
 *
 * Every field in this project that asks for a pubkey should run its input
 * through this, because users paste whichever form their other client showed
 * them.
 */
export function toPubkeyHex(value: unknown): string | undefined {
  if (isHex32(value)) return value
  const decoded = tryDecodeNip19(value)
  if (!decoded) return undefined
  if (decoded.type === 'npub') return decoded.data
  if (decoded.type === 'nprofile') return decoded.data.pubkey
  return undefined
}

/** NIP-21: the URI form, which opens in whatever client the reader prefers. */
export function nostrUri(entity: string): string {
  return `nostr:${entity.trim().replace(/^nostr:/i, '')}`
}

/** A short, unambiguous rendering: `npub1abcd…wxyz`. For labels, never for ids. */
export function shorten(entity: string, keep = 8): string {
  if (entity.length <= keep * 2 + 1) return entity
  return `${entity.slice(0, keep)}…${entity.slice(-keep)}`
}
