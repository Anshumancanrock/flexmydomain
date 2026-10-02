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

export const PROOF_VERSION = 'fmd1'

export const PROOF_MESSAGE_PREFIX = 'flexmydomain:v1'

/** NIP-78 app data. Addressable, so a relay keeps one current proof per domain per key. */
export const PROOF_KIND = 30078

export const PROOF_D_PREFIX = 'fmd:proof:'

export const MAX_CLOCK_SKEW_SECONDS = 300

export interface ProofRecord {
  version: string
  iat: number
  pubkey: string
  sig: string
}

export function proofDTag(domain: string): string {
  return PROOF_D_PREFIX + normaliseDomain(domain)
}

export function proofMessage(domain: string, iat: number): string {
  assertIat(iat)
  return `${PROOF_MESSAGE_PREFIX}:${normaliseDomain(domain)}:${iat}`
}

/** Fully determined by (domain, pubkey, iat). A verifier must be able to rebuild every field. */
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

/** What the signature covers, sha256 of the event's NIP-01 serialisation. */
export function proofDigest(params: { domain: string; pubkey: string; iat: number }): Uint8Array {
  return eventDigest(proofEvent(params))
}

export function proofDigestHex(params: { domain: string; pubkey: string; iat: number }): string {
  return bytesToHex(proofDigest(params))
}

export function encodeProofRecord(record: ProofRecord): string {
  if (record.version !== PROOF_VERSION) {
    throw new Error(`encodeProofRecord: refusing to emit version ${JSON.stringify(record.version)}`)
  }
  assertIat(record.iat)
  if (!isHex32(record.pubkey)) throw new Error('encodeProofRecord: pubkey must be 64 lowercase hex characters')
  if (!isHex64(record.sig)) throw new Error('encodeProofRecord: sig must be 128 lowercase hex characters')
  return `${record.version}.${record.iat}.${record.pubkey}.${record.sig}`
}

export function parseProofRecord(raw: unknown): { ok: true; record: ProofRecord } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' }

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

export interface ProofVerification {
  ok: boolean
  reason?: string
  record?: ProofRecord
  /** `now - iat`, only when `now` was given. */
  ageSeconds?: number
}

/** `now` only enables the clock-skew guard (spec section 3). Future-dated records fail. */
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

/** Verify a proof published as a Nostr event. It must match the canonical proof event exactly before any field is trusted. */
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

/** The only way the UI should make a proof. Works with a NIP-07 {@link Signer}. */
export async function createProof(params: {
  domain: string
  iat: number
  signer: Signer
}): Promise<{ domain: string; record: ProofRecord; txt: string; event: NostrEvent }> {
  const domain = normaliseDomain(params.domain)
  const pubkey = (await params.signer.getPublicKey()).toLowerCase()
  const unsigned = proofEvent({ domain, pubkey, iat: params.iat })
  const event = await params.signer.signEvent(unsigned)

  // Extensions may sign with another pubkey than reported, or change created_at.
  const check = proofFromEvent(event)
  if (!check.ok) throw new Error(`createProof: the signer returned an event that does not verify: ${check.reason}`)
  if (check.domain !== domain) throw new Error('createProof: the signer changed the domain')

  return { domain, record: check.record, txt: encodeProofRecord(check.record), event }
}

/** What a record's `iat` can carry: non-negative unix seconds, at most 10 digits. */
export function isValidIat(iat: unknown): iat is number {
  return Number.isSafeInteger(iat) && (iat as number) >= 0 && (iat as number) <= 9999999999
}

function assertIat(iat: number): void {
  if (!Number.isSafeInteger(iat) || iat < 0) {
    throw new Error(`iat must be a non-negative integer of unix seconds, got ${JSON.stringify(iat)}`)
  }
  if (iat > 9999999999) {
    throw new Error(`iat ${iat} exceeds 10 decimal digits, which the record format cannot carry`)
  }
}
