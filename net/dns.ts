/**
 * TXT lookups over DoH through two independent resolvers. core/oracle judges.
 * One resolver can be wrong, stale, poisoned or compelled, so both must agree.
 * A disagreement is reported, never settled by picking one.
 */

/** RFC 8484 JSON endpoints, both CORS-enabled (checked 2026-09-18). */
export const DOH_PROVIDERS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
] as const

export const TXT_TYPE = 16

/** One provider's answer, kept verbatim as evidence. */
export interface DohObservation {
  provider: string
  /** Quotes stripped, multi-strings joined. */
  records: string[]
  /** DNS RCODE. 0 (NOERROR) and 3 (NXDOMAIN) are both answers. */
  status: number | undefined
  /** Provider validated the DNSSEC chain. */
  dnssec: boolean
  /** Provider did not answer at all. Not the same as no records. */
  error?: string
  /** Unix seconds. */
  observedAt: number
  /** Body as received, for the evidence file. */
  raw?: string
}

export interface TxtLookup {
  name: string
  observations: DohObservation[]
  /** Returned by every answering provider. Verify against these only. */
  agreed: string[]
  /** Returned by only some providers. Shown, never trusted. */
  disputed: string[]
  answered: boolean
  /** Every answering provider validated DNSSEC. */
  dnssec: boolean
}

/**
 * One provider. `cd=false&do=true` asks it to validate DNSSEC and say so. A
 * provider that ignores the flags returns AD false, shown as "not DNSSEC-signed".
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
      // No credentials. A cookie would leak which domains the user looks up.
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
 * Join a DoH TXT value like `"chunk one" "chunk two"`. RDATA chunks are at most
 * 255 bytes and concatenate with no separator, so never join on a space.
 * The 209-char proof record never splits, but other records in the zone may.
 */
export function unquoteTxt(data: string): string {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g)
  if (!parts) return data.trim()
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

/**
 * Ask every provider in parallel and compare. A failed provider is recorded as
 * failed, not empty. Escrow must never move on one failed lookup, and
 * `answered` lets callers enforce that.
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
 * NIP-05 document, the alternative proof (spec/PROOF.md section 7). A CORS
 * failure means the domain doesn't offer this proof. Not a fault.
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
