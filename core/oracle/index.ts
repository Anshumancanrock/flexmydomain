/**
 * core/oracle: the two independent domain oracles. A DNS TXT record (or a
 * NIP-05 document) ties a domain to a Nostr key, and RDAP reports what the
 * registry says about the name.
 *
 *   The TXT record says  "this key speaks for this domain."
 *   The unlock says      "this key can actually sell it."
 *   RDAP says            "and here is the registry agreeing that it moved."
 *
 * None of the three sources is this project. This module does the checking
 * and net/ does the fetching that feeds it, so every check here runs with
 * fixed inputs and no network.
 *
 *   import { verifyProofRecords, checkEligibility } from './core/oracle/index.js'
 */

export {
  ACE_PREFIX,
  encodeLabel,
  decodeLabel,
  labelToASCII,
  toASCII,
  toUnicode,
} from './punycode.js'

export {
  MAX_DOMAIN_LENGTH,
  MAX_LABEL_LENGTH,
  PROOF_LABEL,
  isNormalisedDomain,
  nip05Url,
  normaliseDomain,
  proofRecordName,
  splitDomain,
  tldOf,
  tryNormaliseDomain,
} from './domain.js'
export type { NormaliseResult } from './domain.js'

export {
  MAX_CLOCK_SKEW_SECONDS,
  PROOF_D_PREFIX,
  PROOF_KIND,
  PROOF_MESSAGE_PREFIX,
  PROOF_VERSION,
  createProof,
  encodeProofRecord,
  parseProofRecord,
  proofDTag,
  proofDigest,
  proofDigestHex,
  proofEvent,
  proofFromEvent,
  proofMessage,
  verifyProofRecord,
  verifyProofRecords,
} from './proof.js'
export type { ProofRecord, ProofVerification } from './proof.js'

export {
  ROOT_NAME,
  namesForPubkey,
  nip05DocumentUrl,
  parseNip05Identifier,
  relayHints,
  verifyNip05,
} from './nip05.js'
export type { Nip05Document, Nip05Verification } from './nip05.js'

export {
  MIN_EXPIRY_DAYS,
  PENDING_TRANSFER_STATUS,
  RDAP_BOOTSTRAP_URL,
  REFUSING_STATUSES,
  SECONDS_PER_DAY,
  TRANSFER_LOCK_DAYS,
  TRANSFER_LOCK_STATUS,
  WARNING_STATUSES,
  checkEligibility,
  fingerprintMatches,
  fingerprintOf,
  foldStatus,
  parseRdapDomain,
  rdapBaseUrls,
  rdapDomainUrl,
  snapshotHash,
  tldHasRdap,
} from './rdap.js'
export type { Eligibility, Finding, FindingLevel, Fingerprint, RdapEvent, RdapFacts } from './rdap.js'

import type { Nip05Verification } from './nip05.js'
import type { ProofVerification } from './proof.js'

/**
 * Which oracle backed a claim. Always carry this to the UI.
 *
 * `dns` proves control of the zone; `nip05` proves control of the web server.
 * Either is accepted, but they are different claims, and the UI must not
 * collapse them into one green tick. See spec/PROOF.md section 7.
 */
export type ProofSource = 'dns' | 'nip05'

/** A domain's proof state as a page renders it. */
export interface DomainProofStatus {
  domain: string
  pubkey: string
  proven: boolean
  source?: ProofSource
  /** Unix seconds the claimant signed at. Only DNS proofs carry one. */
  iat?: number
  reason?: string
}

/**
 * Combine the two proofs into one verdict, preferring DNS.
 *
 * When both pass, DNS wins: it is the stronger claim and the only one of the
 * two with a signed timestamp. A NIP-05 document says only what was true when
 * it was fetched.
 */
export function combineProofs(params: {
  domain: string
  pubkey: string
  dns?: ProofVerification
  nip05?: Nip05Verification
}): DomainProofStatus {
  const base = { domain: params.domain, pubkey: params.pubkey }
  if (params.dns?.ok) {
    return { ...base, proven: true, source: 'dns', iat: params.dns.record?.iat }
  }
  if (params.nip05?.ok) {
    return { ...base, proven: true, source: 'nip05' }
  }
  return {
    ...base,
    proven: false,
    reason: params.dns?.reason ?? params.nip05?.reason ?? 'no proof was checked',
  }
}
