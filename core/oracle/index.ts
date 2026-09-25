/**
 * Domain oracles. A DNS TXT record (or NIP-05 document) ties a domain to a Nostr
 * key, and RDAP reports what the registry sees. Checks only, net/ does the fetching.
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
 * `dns` proves zone control, `nip05` proves web server control. Both count, but the
 * UI must show which one and never merge them into one green tick (spec/PROOF.md section 7).
 */
export type ProofSource = 'dns' | 'nip05'

export interface DomainProofStatus {
  domain: string
  pubkey: string
  proven: boolean
  source?: ProofSource
  /** Unix seconds, DNS proofs only. */
  iat?: number
  reason?: string
}

/** One verdict from both proofs. DNS wins when both pass, as the stronger claim with a signed timestamp. */
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
