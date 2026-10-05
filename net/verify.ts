import {
  checkEligibility,
  combineProofs,
  nip05DocumentUrl,
  proofRecordName,
  normaliseDomain,
  rdapAnswerProblem,
  verifyNip05,
  verifyProofRecords,
  type DomainProofStatus,
  type Eligibility,
  type Nip05Verification,
  type ProofRecord,
  type ProofVerification,
} from '../core/oracle/index.js'
import { fetchNip05, lookupTxt, type TxtLookup } from './dns.js'
import { fetchRdapDomain, type RdapSnapshot } from './rdap.js'

export interface DomainReport {
  domain: string
  pubkey: string
  status: DomainProofStatus
  answered: boolean
  dnssec: boolean
  lookup: TxtLookup
  dns: ProofVerification
  nip05?: Nip05Verification
  nip05Url?: string
  checkedAt: number
}

/** DNS first, NIP-05 only if DNS didn't prove it. DNS outranks NIP-05. */
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
  const silent = lookup.observations.filter((o) => o.error !== undefined)
  const dns: ProofVerification = lookup.answered
    ? verifyEachResolver(domain, params.pubkey, lookup, checkedAt)
    : {
        ok: false,
        reason: silent.length
          ? `not checked, ${silent.map((o) => `${o.provider} did not answer (${o.error})`).join(' and ')}`
          : 'not checked, no resolver was asked',
      }

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
    answered: lookup.complete,
    dnssec: lookup.dnssec,
    lookup,
    dns,
    nip05,
    nip05Url: url,
    checkedAt,
  }
}

// One resolver showing a record that proves this key is enough. DNS caches catch up at their own
// pace, and a proof signed again can sit in one cache long after the other has the new one.
function verifyEachResolver(domain: string, pubkey: string, lookup: TxtLookup, now: number): ProofVerification {
  const agreed = verifyProofRecords({ domain, pubkey, records: lookup.agreed, now })
  if (agreed.ok) return agreed
  const each = lookup.observations
    .filter((o) => o.error === undefined)
    .map((o) => verifyProofRecords({ domain, pubkey, records: o.records, now }))
  const good = each.filter((v) => v.ok)
  if (good.length === 0) {
    // say why a record was refused, such as one signed by another key
    const why = each.flatMap((v) => v.rejected)[0]?.reason
    return why ? { ok: false, reason: why } : agreed
  }
  return good.reduce((a, b) => ((b.record as ProofRecord).iat < (a.record as ProofRecord).iat ? b : a))
}

export interface RegistryReport {
  domain: string
  eligibility?: Eligibility
  snapshot: RdapSnapshot
  /** False means flex only, no escrow. */
  supported: boolean
  checkedAt: number
}

export async function checkRegistry(params: {
  domain: string
  now?: number
  signal?: AbortSignal
  bootstrap?: unknown
}): Promise<RegistryReport> {
  const domain = normaliseDomain(params.domain)
  const checkedAt = params.now ?? Math.floor(Date.now() / 1000)
  let snapshot: Awaited<ReturnType<typeof fetchRdapDomain>>
  try {
    snapshot = await fetchRdapDomain(domain, { ...params, now: checkedAt })
  } catch (err) {
    return {
      domain,
      snapshot: { domain, url: '', ok: false, status: undefined, observedAt: checkedAt, error: (err as Error).message },
      supported: true,
      checkedAt,
    }
  }

  if (!snapshot.supported || !snapshot.ok || rdapAnswerProblem(snapshot.response, domain)) {
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
