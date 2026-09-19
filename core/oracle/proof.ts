/**
 * The flexmydomain domain proof. spec/PROOF.md is normative: where this file
 * disagrees with it, this file has the bug.
 *
 * Pure: a caller that wants a freshness check passes `now` in. Resolving the
 * record (DoH through two providers) happens in net/, which calls into here.
 *
 * A proof binds a domain to a key. The key signs a message naming the domain,
 * so the record cannot be copied to another name or claimed by another key.
 * The signature is over the id of a canonical NIP-01 event rather than over
 * the bare message, because a NIP-07 extension exposes only `signEvent`;
 * signing a bare string would mean pasting a private key into a web page. The
 * record alone rebuilds that event (its pubkey, its `iat` as created_at, a
 * fixed kind, and a `d` tag and content derived from the domain), so the proof
 * stays self-contained. Published to relays, the same event and signature
 * prove the claim on Nostr as well as in DNS.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import {
  eventDigest,
  isHex32,
  isHex64,
  tagValue,
  verifyDigestSignature,
  type NostrEvent,
  type Signer,
  type UnsignedEvent,
} from '../nostr/event.js'
import { normaliseDomain, tryNormaliseDomain } from './domain.js'

/** The record's version field. A verifier rejects every other value. */
export const PROOF_VERSION = 'fmd1'

/** The message's version, inside the signed content. Bumped with the format. */
export const PROOF_MESSAGE_PREFIX = 'flexmydomain:v1'

/**
 * NIP-78 application data. Addressable, so re-proving a domain replaces the
 * previous event instead of adding another, and a relay holds one current
 * proof per domain per key.
 */
export const PROOF_KIND = 30078

/** The `d` tag prefix, in the project's `fmd:` namespace. */
export const PROOF_D_PREFIX = 'fmd:proof:'

/** spec section 3, "Freshness": a clock-skew guard, not an expiry. */
export const MAX_CLOCK_SKEW_SECONDS = 300

/** A parsed record. Every field is already syntactically checked. */
export interface ProofRecord {
  version: string
  iat: number
  pubkey: string
  sig: string
}

/** The addressable `d` tag for one domain's proof. */
export function proofDTag(domain: string): string {
  return PROOF_D_PREFIX + normaliseDomain(domain)
}

/**
 * The signed message (spec section 2).
 *
 * It binds the domain, so a record copied into another zone does not verify,
 * and the timestamp, so a reader can apply a freshness policy. It carries no
 * nonce from us on purpose: a challenge code we issued would make this a
 * claim only we could check.
 */
export function proofMessage(domain: string, iat: number): string {
  assertIat(iat)
  return `${PROOF_MESSAGE_PREFIX}:${normaliseDomain(domain)}:${iat}`
}

/**
 * The canonical proof event, fully determined by (domain, pubkey, iat). No
 * field may depend on anything a verifier cannot rebuild.
 */
export function proofEvent(params: { domain: string; pubkey: string; iat: number }): UnsignedEvent {
  const domain = normaliseDomain(params.domain)
  if (!isHex32(params.pubkey)) {
    throw new Error(`proofEvent: pubkey must be 64 lowercase hex characters, got ${JSON.stringify(params.pubkey)}`)
  }
  assertIat(params.iat)
  return {
    pubkey: params.pubkey,
    created_at: params.iat,
    kind: PROOF_KIND,
    tags: [['d', PROOF_D_PREFIX + domain]],
    content: `${PROOF_MESSAGE_PREFIX}:${domain}:${params.iat}`,
  }
}

/** What the signature covers: sha256 of that event's NIP-01 serialisation. */
export function proofDigest(params: { domain: string; pubkey: string; iat: number }): Uint8Array {
  return eventDigest(proofEvent(params))
}

/** The same, as hex: the proof event's `id` if it is published. */
export function proofDigestHex(params: { domain: string; pubkey: string; iat: number }): string {
  return bytesToHex(proofDigest(params))
}

/**
 * Render a record for a registrar's DNS panel.
 *
 * One token, no spaces, 209 characters (spec section 1). A generator emits
 * only the `.`-joined form.
 */
export function encodeProofRecord(record: ProofRecord): string {
  if (record.version !== PROOF_VERSION) {
    throw new Error(`encodeProofRecord: refusing to emit version ${JSON.stringify(record.version)}`)
  }
  assertIat(record.iat)
  if (!isHex32(record.pubkey)) throw new Error('encodeProofRecord: pubkey must be 64 lowercase hex characters')
  if (!isHex64(record.sig)) throw new Error('encodeProofRecord: sig must be 128 lowercase hex characters')
  return `${record.version}.${record.iat}.${record.pubkey}.${record.sig}`
}

/**
 * Parse one TXT value.
 *
 * Liberal on input (spec section 1). A value has usually passed through a
 * registrar's panel and a resolver's JSON, so it may be quoted, split into
 * several character-strings, space-joined instead of dot-joined, or
 * upper-cased. None of that changes the claim, and rejecting a correct record
 * over a stray quote would make nothing safer.
 *
 * Still rejected: a wrong version, a wrong field count, or a field that does
 * not have the shape spec section 1 gives it.
 */
export function parseProofRecord(raw: unknown): { ok: true; record: ProofRecord } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' }

  // Resolvers return multi-string TXT RDATA in several shapes: `"a" "b"`,
  // `a b`, or already concatenated. Drop the quotes, then treat runs of
  // whitespace and dots alike as separators.
  const cleaned = raw.trim().replace(/"/g, '').trim()
  if (cleaned === '') return { ok: false, reason: 'empty' }

  const fields = cleaned.toLowerCase().split(/[\s.]+/).filter((f) => f !== '')
  if (fields.length !== 4) {
    return { ok: false, reason: `expected 4 fields, found ${fields.length}` }
  }

  const [version, iatText, pubkey, sig] = fields
  if (version !== PROOF_VERSION) {
    return { ok: false, reason: `unknown version ${JSON.stringify(version)}` }
  }
  if (!/^\d{1,10}$/.test(iatText)) {
    return { ok: false, reason: 'iat is not decimal unix seconds' }
  }
  const iat = Number(iatText)
  if (!Number.isSafeInteger(iat)) return { ok: false, reason: 'iat is out of range' }
  if (!isHex32(pubkey)) return { ok: false, reason: 'pubkey is not 64 hex characters' }
  if (!isHex64(sig)) return { ok: false, reason: 'sig is not 128 hex characters' }

  return { ok: true, record: { version, iat, pubkey, sig } }
}

/** One record's verdict, with enough detail for the UI to explain itself. */
export interface ProofVerification {
  ok: boolean
  reason?: string
  record?: ProofRecord
  /** Seconds between `iat` and the `now` the caller supplied. */
  ageSeconds?: number
}

/**
 * Verify one record against a domain and a pubkey.
 *
 * `now` is optional. When given, it applies only the clock-skew guard of spec
 * section 3: a record dated in the future is rejected, an old one is not. A
 * proof does not become false with age: if the record is still in the zone,
 * the claimant still controls it. The age is reported, and the reader decides.
 */
export function verifyProofRecord(params: {
  domain: string
  pubkey: string
  record: ProofRecord | string
  now?: number
}): ProofVerification {
  const normalised = tryNormaliseDomain(params.domain)
  if (!normalised.ok) return { ok: false, reason: `domain: ${normalised.reason}` }
  if (!isHex32(params.pubkey)) return { ok: false, reason: 'pubkey is not 64 lowercase hex characters' }

  let record: ProofRecord
  if (typeof params.record === 'string') {
    const parsed = parseProofRecord(params.record)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    record = parsed.record
  } else {
    record = params.record
  }

  if (record.pubkey !== params.pubkey) {
    // Not a failure of the zone (spec section 3, step 3.3): a domain may carry
    // proofs for several keys at once, as it does during a handover.
    return { ok: false, reason: 'record is for a different pubkey', record }
  }

  const ageSeconds = params.now === undefined ? undefined : params.now - record.iat
  if (ageSeconds !== undefined && ageSeconds < -MAX_CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      reason: `dated ${-ageSeconds} seconds in the future`,
      record,
      ageSeconds,
    }
  }

  const digest = proofDigest({ domain: normalised.domain, pubkey: record.pubkey, iat: record.iat })
  if (!verifyDigestSignature(record.sig, digest, record.pubkey)) {
    return { ok: false, reason: 'signature does not verify', record, ageSeconds }
  }

  return { ok: true, record, ageSeconds }
}

/**
 * Verify a whole RRset, which is what a resolver returns.
 *
 * Per spec section 3, step 4, the domain is proven if at least one record
 * verifies, and a malformed or non-matching record is skipped rather than
 * fatal. Zones accumulate junk, and a stale proof for a previous owner beside a
 * valid one must not break the valid one.
 *
 * When several verify, the newest wins, so the reported age is that of the
 * best evidence rather than of whichever record the resolver listed first.
 */
export function verifyProofRecords(params: {
  domain: string
  pubkey: string
  records: readonly string[]
  now?: number
}): ProofVerification & { checked: number; rejected: { value: string; reason: string }[] } {
  const rejected: { value: string; reason: string }[] = []
  let best: ProofVerification | undefined

  for (const value of params.records) {
    const result = verifyProofRecord({ ...params, record: value })
    if (!result.ok) {
      rejected.push({ value, reason: result.reason ?? 'rejected' })
      continue
    }
    if (!best || (result.record as ProofRecord).iat > (best.record as ProofRecord).iat) best = result
  }

  return {
    ...(best ?? { ok: false, reason: rejected.length ? 'no record verified' : 'no records found' }),
    checked: params.records.length,
    rejected,
  }
}

/**
 * Verify a proof that arrived as a published event rather than from DNS.
 *
 * It checks that the event is the canonical proof event for its domain (same
 * kind, `d` tag, content and created_at) before trusting any field of it. An
 * event that only looks like a proof proves nothing; only the one whose id the
 * signature covers does.
 *
 * The caller still has to resolve the TXT record: this says "this key signed a
 * proof for this domain", and DNS says "the zone agrees".
 */
export function proofFromEvent(event: NostrEvent): { ok: true; domain: string; record: ProofRecord } | { ok: false; reason: string } {
  if (event.kind !== PROOF_KIND) return { ok: false, reason: `kind ${event.kind} is not ${PROOF_KIND}` }

  const d = tagValue(event, 'd')
  if (!d || !d.startsWith(PROOF_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${PROOF_D_PREFIX}* identifier` }
  }
  const claimed = tryNormaliseDomain(d.slice(PROOF_D_PREFIX.length))
  if (!claimed.ok) return { ok: false, reason: `d tag domain: ${claimed.reason}` }
  if (d !== PROOF_D_PREFIX + claimed.domain) {
    return { ok: false, reason: 'd tag is not in normalised form' }
  }

  const expected = proofEvent({ domain: claimed.domain, pubkey: event.pubkey, iat: event.created_at })
  if (event.content !== expected.content) {
    return { ok: false, reason: 'content is not the canonical proof message for this domain and timestamp' }
  }
  if (!isHex64(event.sig)) return { ok: false, reason: 'sig is not 128 lowercase hex characters' }

  const digest = eventDigest(expected)
  if (!verifyDigestSignature(event.sig, digest, event.pubkey)) {
    return { ok: false, reason: 'signature does not verify' }
  }

  return {
    ok: true,
    domain: claimed.domain,
    record: { version: PROOF_VERSION, iat: event.created_at, pubkey: event.pubkey, sig: event.sig },
  }
}

/**
 * Produce a proof with a {@link Signer}. This works with a NIP-07 extension,
 * and it is the only way the UI should create a proof.
 *
 * Returns both artefacts: the TXT value to paste and the signed event to
 * publish. They carry the same signature, so a verifier reaches the same
 * conclusion from either.
 */
export async function createProof(params: {
  domain: string
  iat: number
  signer: Signer
}): Promise<{ domain: string; record: ProofRecord; txt: string; event: NostrEvent }> {
  const domain = normaliseDomain(params.domain)
  const pubkey = (await params.signer.getPublicKey()).toLowerCase()
  const unsigned = proofEvent({ domain, pubkey, iat: params.iat })
  const event = await params.signer.signEvent(unsigned)

  // Check what the signer returns: an extension may sign under a different
  // pubkey than it reported, or alter created_at. Either would produce a TXT
  // record that never verifies, found days later when a buyer reports the
  // listing as unproven.
  const check = proofFromEvent(event)
  if (!check.ok) throw new Error(`createProof: the signer returned an event that does not verify: ${check.reason}`)
  if (check.domain !== domain) throw new Error('createProof: the signer changed the domain')

  return { domain, record: check.record, txt: encodeProofRecord(check.record), event }
}

function assertIat(iat: number): void {
  if (!Number.isSafeInteger(iat) || iat < 0) {
    throw new Error(`iat must be a non-negative integer of unix seconds, got ${JSON.stringify(iat)}`)
  }
  if (iat > 9999999999) {
    throw new Error(`iat ${iat} exceeds 10 decimal digits, which the record format cannot carry`)
  }
}
