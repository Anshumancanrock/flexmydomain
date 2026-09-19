/**
 * Domain verification attestations, as NIP-90 job requests and results.
 *
 * services/verifier runs the daemon that publishes them.
 *
 * A browser resolving DNS for itself is the strongest check it has, but it is
 * one machine on one network at one moment. An attestation is another party
 * reporting what it saw from somewhere else, and a reader can require k of n
 * independent verifiers so that no single resolver, the site's included, is
 * the oracle. An attestation never replaces resolving the record yourself: a
 * client that trusts three attestations instead of doing one DNS lookup has
 * swapped a check it controls for three it does not.
 *
 * Kinds 5970 and 6970 are this project's own choice inside NIP-90's custom
 * range. They are not registered anywhere.
 */

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'

/** NIP-90 job request, in the custom range. */
export const VERIFY_REQUEST_KIND = 5970

/** Job result: the attestation itself. */
export const VERIFY_RESULT_KIND = 6970

/** NIP-90 job feedback, for "I am working on it" and "I could not". */
export const JOB_FEEDBACK_KIND = 7000

export type AttestationVerdict = 'proven' | 'absent' | 'unreachable'

/**
 * Ask any verifier to check a domain.
 *
 * Most attestations are unsolicited: a verifier watches listings and re-polls
 * them daily. A request is for a client that has just published a proof and
 * wants a second opinion before the daemon's next sweep.
 */
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
    // NIP-90 `i` tags carry the job input: two plain-text inputs that anyone
    // reading the result can reconstruct.
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
  /** Which oracle was used: `dns` or `nip05`. */
  source?: 'dns' | 'nip05'
  /** The `iat` inside the record that verified, where one did. */
  iat?: number
  /** True when every answering resolver reported a validated DNSSEC chain. */
  dnssec?: boolean
  /** Names of the resolvers that answered, so a reader can weigh the claim. */
  resolvers?: readonly string[]
  /** When the verifier looked, not when it published. */
  observedAt: number
  createdAt: number
  /** The kind 5970 this answers, when it answers one. */
  requestId?: string
  requester?: string
}

/**
 * Build the event recording what this verifier saw.
 *
 * The observation is JSON in the content, because a reader wants it as one
 * object and NIP-90 results carry their payload in content. The tags carry
 * only what a relay needs to index on (the domain and the claimant), so a
 * client can filter without parsing every body.
 */
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

  // The tag and the body must name the same domain and the same claimant.
  // Relays index the tags, so an attestation whose tags and body disagree
  // would be fetched for one claim while its verdict is about another.
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
 * k-of-n over a set of attestations.
 *
 * Counts distinct verifiers, not attestations: one verifier publishing four
 * times is one opinion, and without this a single daemon could meet any
 * threshold by itself. Only each verifier's newest observation counts.
 * Verifiers outside `trusted` are ignored entirely, because the reader decides
 * whom to trust and an attestation from an unknown key is a stranger's
 * assertion.
 *
 * `unreachable` is counted separately and never against the claimant: a
 * verifier whose network failed has said nothing about the domain.
 */
export function tally(params: {
  attestations: readonly Attestation[]
  domain: string
  claimant: string
  /** The verifiers whose opinions the reader accepts. */
  trusted: readonly string[]
  /** How many must agree. */
  threshold: number
  /** Ignore observations older than this many seconds, when given. */
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

/** The filter that fetches attestations about a set of domains. */
export function attestationFilter(params: { domains?: readonly string[]; verifiers?: readonly string[]; since?: number }): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [VERIFY_RESULT_KIND] }
  if (params.domains?.length) filter['#fmd_domain'] = [...params.domains]
  if (params.verifiers?.length) filter.authors = [...params.verifiers]
  if (params.since !== undefined) filter.since = params.since
  return filter
}

/** NIP-90 job feedback: a status and an optional human-readable message. */
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
