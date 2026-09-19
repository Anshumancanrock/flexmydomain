/**
 * DNS over HTTPS: TXT lookups through two independent public resolvers.
 *
 * Isomorphic: `fetch` only. Runs in a page and under Bun unchanged.
 *
 * This module resolves, and core/oracle decides whether a proof is valid.
 * Keeping the two apart lets every verification test run with fixed inputs
 * and no network.
 *
 * A single resolver is a single party that can be wrong, cached, poisoned or
 * compelled. Two independent providers must agree, so a reader does not have
 * to take one lookup on trust and can repeat it themselves. A disagreement is
 * reported, not settled by picking one provider.
 */

/** RFC 8484 JSON endpoints, both CORS-enabled (checked 2026-09-18). */
export const DOH_PROVIDERS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
] as const

export const TXT_TYPE = 16

/** What one provider said, kept verbatim as evidence. */
export interface DohObservation {
  provider: string
  /** Records as returned, quotes stripped and multi-strings joined. */
  records: string[]
  /** The DNS RCODE. 0 is NOERROR and 3 is NXDOMAIN; both are answers. */
  status: number | undefined
  /** True when the provider validated the DNSSEC chain. A free strength signal. */
  dnssec: boolean
  /** Set when the provider did not answer at all. Not the same as "no records". */
  error?: string
  /** Unix seconds when the lookup was made. */
  observedAt: number
  /** The response body as received, for the evidence file. */
  raw?: string
}

export interface TxtLookup {
  name: string
  observations: DohObservation[]
  /** Records every answering provider returned: the set to verify against. */
  agreed: string[]
  /** Records only some providers returned. Shown, never trusted. */
  disputed: string[]
  /** True when at least one provider answered rather than failing. */
  answered: boolean
  /** True when every answering provider reported a validated DNSSEC chain. */
  dnssec: boolean
}

/**
 * A TXT lookup against one DoH provider.
 *
 * `cd=false` and `do=true` ask the resolver to validate DNSSEC and to report
 * whether it did. A provider that ignores the flags reports `AD: false`, which
 * the UI shows as "not DNSSEC-signed".
 */
export async function lookupTxtVia(
  provider: { name: string; url: string },
  name: string,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<DohObservation> {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000)
  const url = `${provider.url}?name=${encodeURIComponent(name)}&type=TXT&cd=false&do=true`

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: options.signal,
      // Never send credentials to a resolver. There is nothing to authenticate
      // and a cookie here would leak which domains a user is looking at.
      credentials: 'omit',
      redirect: 'follow',
    })
    const raw = await response.text()
    if (!response.ok) {
      return { provider: provider.name, records: [], status: undefined, dnssec: false, observedAt, raw, error: `HTTP ${response.status}` }
    }

    const body = JSON.parse(raw) as { Status?: number; AD?: boolean; Answer?: { type?: number; data?: string }[] }
    const records = (body.Answer ?? [])
      .filter((a) => a.type === TXT_TYPE && typeof a.data === 'string')
      .map((a) => unquoteTxt(a.data as string))

    return {
      provider: provider.name,
      records,
      status: typeof body.Status === 'number' ? body.Status : undefined,
      dnssec: body.AD === true,
      observedAt,
      raw,
    }
  } catch (err) {
    return {
      provider: provider.name,
      records: [],
      status: undefined,
      dnssec: false,
      observedAt,
      error: (err as Error).message,
    }
  }
}

/**
 * Join a TXT value as DoH hands it back: `"chunk one" "chunk two"`.
 *
 * TXT RDATA is a sequence of character-strings of at most 255 bytes each, and
 * the value is their concatenation with no separator. A resolver shows them
 * quoted and space-separated, so joining on a space would insert a byte that
 * was never in the zone. The proof record is 209 characters and never splits,
 * but other records in the same zone may.
 */
export function unquoteTxt(data: string): string {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g)
  if (!parts) return data.trim()
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

/**
 * Resolve TXT at `name` through every provider and compare the answers.
 *
 * The providers are asked in parallel. One that fails is recorded as failed,
 * not as having returned nothing: escrow state must never move on a single
 * failed lookup, and `answered` is what lets a caller apply that rule.
 */
export async function lookupTxt(
  name: string,
  options: { providers?: readonly { name: string; url: string }[]; signal?: AbortSignal; now?: number } = {},
): Promise<TxtLookup> {
  const providers = options.providers ?? DOH_PROVIDERS
  const observations = await Promise.all(providers.map((p) => lookupTxtVia(p, name, options)))

  const answering = observations.filter((o) => o.error === undefined)
  const counts = new Map<string, number>()
  for (const observation of answering) {
    for (const record of new Set(observation.records)) {
      counts.set(record, (counts.get(record) ?? 0) + 1)
    }
  }

  const agreed: string[] = []
  const disputed: string[] = []
  for (const [record, count] of counts) {
    if (count === answering.length && answering.length > 0) agreed.push(record)
    else disputed.push(record)
  }

  return {
    name,
    observations,
    agreed: agreed.sort(),
    disputed: disputed.sort(),
    answered: answering.length > 0,
    dnssec: answering.length > 0 && answering.every((o) => o.dnssec),
  }
}

/**
 * Fetch a NIP-05 document, the alternative proof of spec/PROOF.md section 7.
 *
 * Returns the parsed JSON and the raw text. A domain that does not serve the
 * document with permissive CORS is not offering this proof, so the resulting
 * network error means "not offered" and is not reported as a fault.
 */
export async function fetchNip05(
  url: string,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<{ ok: boolean; document?: unknown; raw?: string; error?: string; observedAt: number }> {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000)
  try {
    const response = await fetch(url, { signal: options.signal, credentials: 'omit', headers: { accept: 'application/json' } })
    const raw = await response.text()
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, raw, observedAt }
    return { ok: true, document: JSON.parse(raw), raw, observedAt }
  } catch (err) {
    return { ok: false, error: (err as Error).message, observedAt }
  }
}
