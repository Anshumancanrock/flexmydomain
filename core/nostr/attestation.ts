// Domain attestations as NIP-90 jobs, published by services/verifier. Readers
// require k of n independent verifiers, so no one resolver (ours included) is the oracle.
// They add to the client's own DNS lookup, never replace it.
// Kinds 5970/6970 are our pick in NIP-90's custom range, unregistered.

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'

export const VERIFY_REQUEST_KIND = 5970

/** The attestation itself. */
export const VERIFY_RESULT_KIND = 6970

export const JOB_FEEDBACK_KIND = 7000

export type AttestationVerdict = 'proven' | 'absent' | 'unreachable'

/** For a fresh proof that can't wait for the daily sweep. Most attestations are unsolicited. */
export function buildVerifyRequest(params: {
  pubkey: string
  domain: string
  /** The key claiming the domain. */
  claimant: string
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildVerifyRequest: pubkey must be 64 lowercase hex characters')
  if (!isHex32(params.claimant)) throw new Error('buildVerifyRequest: claimant must be 64 lowercase hex characters')
  const domain = normaliseDomain(params.domain)

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: VERIFY_REQUEST_KIND,
    // NIP-90 `i` inputs, plain text so a result reader can rebuild them.
    tags: [
      ['i', domain, 'text', '', 'domain'],
      ['i', params.claimant, 'text', '', 'claimant'],
      ['output', 'application/json'],
    ],
    content: '',
  }
}

export interface AttestationParams {
  /** The verifier's own key. */
  pubkey: string
  domain: string
  claimant: string
  verdict: AttestationVerdict
  source?: 'dns' | 'nip05'
  /** `iat` of the record that verified, if any. */
  iat?: number
  /** Every answering resolver reported a validated DNSSEC chain. */
  dnssec?: boolean
  resolvers?: readonly string[]
  /** When the verifier looked, not when it published. */
  observedAt: number
  createdAt: number
  /** The kind 5970 this answers, if any. */
  requestId?: string
  requester?: string
}

/** Observation goes in content as JSON, per NIP-90. Tags hold only what relays index on. */
export function buildAttestation(params: AttestationParams): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildAttestation: pubkey must be 64 lowercase hex characters')
  if (!isHex32(params.claimant)) throw new Error('buildAttestation: claimant must be 64 lowercase hex characters')
  const domain = normaliseDomain(params.domain)

  const tags: NostrTag[] = [
    ['fmd_domain', domain],
    ['p', params.claimant],
    ['l', params.verdict, 'fmd.verify'],
    ['t', 'flexmydomain'],
  ]
  if (params.requestId) tags.push(['e', params.requestId])
  if (params.requester && params.requester !== params.claimant) tags.push(['p', params.requester])

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: VERIFY_RESULT_KIND,
    tags,
    content: JSON.stringify({
      v: 1,
      domain,
      claimant: params.claimant,
      verdict: params.verdict,
      ...(params.source ? { source: params.source } : {}),
      ...(params.iat !== undefined ? { iat: params.iat } : {}),
      ...(params.dnssec !== undefined ? { dnssec: params.dnssec } : {}),
      ...(params.resolvers?.length ? { resolvers: [...params.resolvers] } : {}),
      observed_at: params.observedAt,
    }),
  }
}

export interface Attestation {
  verifier: string
  domain: string
  claimant: string
  verdict: AttestationVerdict
  source?: 'dns' | 'nip05'
  iat?: number
  dnssec?: boolean
  resolvers: string[]
  observedAt: number
  event: NostrEvent
}

/** Read an attestation, checking the tags and the body agree. */
export function parseAttestation(event: NostrEvent): { ok: true; attestation: Attestation } | { ok: false; reason: string } {
  if (event.kind !== VERIFY_RESULT_KIND) return { ok: false, reason: `kind ${event.kind} is not ${VERIFY_RESULT_KIND}` }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.content) as Record<string, unknown>
  } catch (err) {
    return { ok: false, reason: `content is not JSON: ${(err as Error).message}` }
  }

  const domain = tryNormaliseDomain(body.domain)
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }

  // Relays index the tags. If tags and body disagree, a fetch for one claim
  // returns a verdict on another.
  if (tagValue(event, 'fmd_domain') !== domain.domain) {
    return { ok: false, reason: 'the fmd_domain tag disagrees with the body' }
  }
  const claimant = body.claimant
  if (!isHex32(claimant)) return { ok: false, reason: 'no claimant' }
  if (!event.tags.some((t) => t[0] === 'p' && t[1] === claimant)) {
    return { ok: false, reason: 'the body names a claimant the tags do not' }
  }

  const verdict = body.verdict
  if (verdict !== 'proven' && verdict !== 'absent' && verdict !== 'unreachable') {
    return { ok: false, reason: `unknown verdict ${JSON.stringify(verdict ?? null)}` }
  }

  const observedAt = typeof body.observed_at === 'number' ? body.observed_at : undefined
  if (observedAt === undefined) return { ok: false, reason: 'no observation time' }

  return {
    ok: true,
    attestation: {
      verifier: event.pubkey,
      domain: domain.domain,
      claimant,
      verdict,
      source: body.source === 'nip05' ? 'nip05' : body.source === 'dns' ? 'dns' : undefined,
      iat: typeof body.iat === 'number' ? body.iat : undefined,
      dnssec: typeof body.dnssec === 'boolean' ? body.dnssec : undefined,
      resolvers: Array.isArray(body.resolvers) ? body.resolvers.filter((r): r is string => typeof r === 'string') : [],
      observedAt,
      event,
    },
  }
}

/**
 * k-of-n. Counts distinct verifiers by their newest observation, or one daemon
 * could meet any threshold alone. Keys outside `trusted` are ignored.
 * `unreachable` never counts against the claimant.
 */
export function tally(params: {
  attestations: readonly Attestation[]
  domain: string
  claimant: string
  trusted: readonly string[]
  threshold: number
  maxAgeSeconds?: number
  now?: number
}): { proven: boolean; agreeing: number; absent: number; unreachable: number; verifiers: string[] } {
  const trusted = new Set(params.trusted)
  const newest = new Map<string, Attestation>()

  for (const attestation of params.attestations) {
    if (!trusted.has(attestation.verifier)) continue
    if (attestation.domain !== params.domain) continue
    if (attestation.claimant !== params.claimant) continue
    if (
      params.maxAgeSeconds !== undefined &&
      params.now !== undefined &&
      params.now - attestation.observedAt > params.maxAgeSeconds
    ) continue

    const current = newest.get(attestation.verifier)
    if (!current || attestation.observedAt > current.observedAt) newest.set(attestation.verifier, attestation)
  }

  const opinions = [...newest.values()]
  const agreeing = opinions.filter((a) => a.verdict === 'proven')
  return {
    proven: agreeing.length >= params.threshold && params.threshold > 0,
    agreeing: agreeing.length,
    absent: opinions.filter((a) => a.verdict === 'absent').length,
    unreachable: opinions.filter((a) => a.verdict === 'unreachable').length,
    verifiers: agreeing.map((a) => a.verifier),
  }
}

export function attestationFilter(params: { domains?: readonly string[]; verifiers?: readonly string[]; since?: number }): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [VERIFY_RESULT_KIND] }
  if (params.domains?.length) filter['#fmd_domain'] = [...params.domains]
  if (params.verifiers?.length) filter.authors = [...params.verifiers]
  if (params.since !== undefined) filter.since = params.since
  return filter
}

export function buildJobFeedback(params: {
  pubkey: string
  requestId: string
  requester: string
  status: 'processing' | 'error' | 'success'
  message?: string
  createdAt: number
}): UnsignedEvent {
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: JOB_FEEDBACK_KIND,
    tags: [
      ['status', params.status, params.message ?? ''],
      ['e', params.requestId],
      ['p', params.requester],
    ],
    content: params.message ?? '',
  }
}
