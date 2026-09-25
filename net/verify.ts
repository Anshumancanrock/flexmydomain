/**
 * Where net/ and core/oracle meet. Verdicts come back with the raw lookups attached.
 * Pages, services/verifier and services/indexer all call this. Keep it the only copy
 * of the checking rules. Two verifiers that disagree are worse than one wrong one.
 */

import {
  checkEligibility,
  combineProofs,
  nip05DocumentUrl,
  proofRecordName,
  normaliseDomain,
  verifyNip05,
  verifyProofRecords,
  type DomainProofStatus,
  type Eligibility,
  type Nip05Verification,
  type ProofVerification,
} from '../core/oracle/index.js'
import { fetchNip05, lookupTxt, type TxtLookup } from './dns.js'
import { fetchRdapDomain, type RdapSnapshot } from './rdap.js'

export interface DomainReport {
  domain: string
  pubkey: string
  status: DomainProofStatus
  /** At least one resolver answered. */
  answered: boolean
  dnssec: boolean
  lookup: TxtLookup
  dns: ProofVerification
  nip05?: Nip05Verification
  nip05Url?: string
  checkedAt: number
}

/**
 * DNS first, NIP-05 only if DNS didn't prove it. DNS outranks NIP-05.
 * Only records every answering resolver returned are verified. A partial record is
 * mid-propagation or a resolver being lied to, and neither proves anything to a buyer.
 */
export async function checkDomainProof(params: {
  domain: string
  pubkey: string
  now?: number
  signal?: AbortSignal
  /** Skip NIP-05, for bulk re-polls. */
  dnsOnly?: boolean
}): Promise<DomainReport> {
  const domain = normaliseDomain(params.domain)
  const checkedAt = params.now ?? Math.floor(Date.now() / 1000)

  const lookup = await lookupTxt(proofRecordName(domain), { signal: params.signal, now: checkedAt })
  const dns = verifyProofRecords({
    domain,
    pubkey: params.pubkey,
    records: lookup.agreed,
    now: checkedAt,
  })

  let nip05: Nip05Verification | undefined
  let url: string | undefined
  if (!dns.ok && !params.dnsOnly) {
    url = nip05DocumentUrl(domain)
    const fetched = await fetchNip05(url, { signal: params.signal, now: checkedAt })
    nip05 = fetched.ok
      ? verifyNip05({ domain, pubkey: params.pubkey, document: fetched.document })
      : { ok: false, reason: fetched.error ?? 'no document' }
  }

  return {
    domain,
    pubkey: params.pubkey,
    status: combineProofs({ domain, pubkey: params.pubkey, dns, nip05 }),
    answered: lookup.answered,
    dnssec: lookup.dnssec,
    lookup,
    dns,
    nip05,
    nip05Url: url,
    checkedAt,
  }
}

/** Snapshot kept for the evidence file. */
export interface RegistryReport {
  domain: string
  /** Unset when the TLD has no RDAP or gave no usable answer. */
  eligibility?: Eligibility
  snapshot: RdapSnapshot
  /** False means flex only, no escrow. */
  supported: boolean
  checkedAt: number
}

/**
 * Registry lookup plus eligibility rules. No RDAP means `supported: false` and no
 * eligibility at all. A verdict we couldn't reach must never render as one that passed.
 */
export async function checkRegistry(params: {
  domain: string
  now?: number
  signal?: AbortSignal
  bootstrap?: unknown
}): Promise<RegistryReport> {
  const domain = normaliseDomain(params.domain)
  const checkedAt = params.now ?? Math.floor(Date.now() / 1000)
  const snapshot = await fetchRdapDomain(domain, { ...params, now: checkedAt })

  if (!snapshot.supported || !snapshot.ok) {
    return { domain, snapshot, supported: snapshot.supported, checkedAt }
  }

  return {
    domain,
    snapshot,
    supported: true,
    checkedAt,
    eligibility: checkEligibility({
      domain,
      response: snapshot.response,
      now: checkedAt,
      bootstrap: snapshot.bootstrap,
    }),
  }
}

/** Both oracles in parallel, for the add-a-domain flow. */
export async function checkDomain(params: {
  domain: string
  pubkey: string
  now?: number
  signal?: AbortSignal
  bootstrap?: unknown
}): Promise<{ proof: DomainReport; registry: RegistryReport }> {
  const [proof, registry] = await Promise.all([checkDomainProof(params), checkRegistry(params)])
  return { proof, registry }
}
