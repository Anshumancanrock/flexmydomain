/**
 * Resolve, then decide: the one place net/ and core/oracle meet.
 *
 * This module only orchestrates. It fetches with net/, decides with
 * core/oracle and returns the verdict with the raw observations attached, so
 * a page can show "proven" together with what was looked up, from which
 * provider and when. A dispute is then about evidence rather than memory.
 *
 * The pages, services/verifier and services/indexer all call this module, and
 * it must stay the only implementation of the checking rules: two verifiers
 * that disagree are worse than one that is wrong, because nobody can tell
 * which is which.
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

/** Everything learned about one domain in one pass. */
export interface DomainReport {
  domain: string
  pubkey: string
  status: DomainProofStatus
  /** True when at least one resolver answered. */
  answered: boolean
  dnssec: boolean
  lookup: TxtLookup
  dns: ProofVerification
  nip05?: Nip05Verification
  nip05Url?: string
  checkedAt: number
}

/**
 * Check a domain's proof: DNS first, NIP-05 only if DNS did not settle it.
 *
 * The NIP-05 request is skipped when DNS succeeds, since DNS outranks it and
 * the round trip would learn nothing. It is still made when no resolver could
 * be reached, because that is not evidence against the claimant.
 *
 * Only records that every answering resolver returned are verified. A record
 * one provider returns and another does not is reported as disputed and left
 * unverified: it is either mid-propagation or one resolver is being lied to,
 * and neither is a basis for telling a buyer a domain is proven.
 */
export async function checkDomainProof(params: {
  domain: string
  pubkey: string
  now?: number
  signal?: AbortSignal
  /** Skip the NIP-05 request, for a bulk re-poll. */
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

/** A registry check, with the snapshot kept for the evidence file. */
export interface RegistryReport {
  domain: string
  /** Undefined when the TLD has no RDAP service or gave no usable answer. */
  eligibility?: Eligibility
  snapshot: RdapSnapshot
  /** False when this TLD cannot be verified: it can be flexed but not escrowed. */
  supported: boolean
  checkedAt: number
}

/**
 * Ask the registry about a domain and apply the eligibility rules.
 *
 * A TLD with no RDAP service is `supported: false` with no eligibility at all,
 * rather than an eligibility that happens to pass. The product rule is "flex
 * any domain, escrow only what we can verify", and a verdict that could not
 * be reached must never render as one that was.
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

/** Both oracles in one call, in parallel. What the add-a-domain flow needs. */
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
