import { parseRdapDomain, rdapAnswerProblem, rdapBaseUrls, rdapDomainUrl, snapshotHash, type RdapFacts } from '../core/oracle/rdap.js'

export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

export interface RdapSnapshot {
  domain: string
  url: string
  ok: boolean
  status: number | undefined
  /** Only set on success with a body that parsed. */
  response?: unknown
  /** Bytes as received. Store these, publish the hash. */
  raw?: string
  hash?: string
  observedAt: number
  error?: string
}

/** IANA bootstrap file, cached in the module for a day by default (`force` skips). It is ~150 KB and changes daily at most. */
let bootstrapCache: { at: number; value: unknown } | undefined

export async function fetchRdapBootstrap(
  options: { signal?: AbortSignal; ttlSeconds?: number; force?: boolean; now?: number } = {},
): Promise<unknown> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const ttl = options.ttlSeconds ?? 86400
  if (!options.force && bootstrapCache && now - bootstrapCache.at < ttl) return bootstrapCache.value

  const response = await fetch(RDAP_BOOTSTRAP_URL, { signal: options.signal, credentials: 'omit' })
  if (!response.ok) throw new Error(`RDAP bootstrap: HTTP ${response.status}`)
  const value = await response.json()
  bootstrapCache = { at: now, value }
  return value
}

export function clearBootstrapCache(): void {
  bootstrapCache = undefined
}

export async function fetchRdapDomainAt(
  baseUrl: string,
  domain: string,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<RdapSnapshot> {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000)
  const url = rdapDomainUrl(baseUrl, domain)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/rdap+json, application/json' },
      signal: options.signal,
      credentials: 'omit',
      // Two polls that agree only mean something if both reached the registry.
      cache: 'no-store',
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const raw = new TextDecoder().decode(bytes)
    if (!response.ok) {
      return { domain, url, ok: false, status: response.status, raw, hash: snapshotHash(bytes), observedAt }
    }
    return {
      domain,
      url,
      ok: true,
      status: response.status,
      response: JSON.parse(raw),
      raw,
      hash: snapshotHash(bytes),
      observedAt,
    }
  } catch (err) {
    return { domain, url, ok: false, status: undefined, observedAt, error: (err as Error).message }
  }
}

export async function fetchRdapDomain(
  domain: string,
  options: { bootstrap?: unknown; signal?: AbortSignal; now?: number } = {},
): Promise<RdapSnapshot & { bootstrap: unknown; supported: boolean }> {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000)
  const bootstrap = options.bootstrap ?? (await fetchRdapBootstrap(options))
  const bases = rdapBaseUrls(bootstrap, domain)

  if (bases.length === 0) {
    // Not an error. "Flex any domain, escrow only what we can verify", and without RDAP we can't verify.
    return {
      domain,
      url: '',
      ok: false,
      status: undefined,
      observedAt,
      error: 'this TLD publishes no RDAP service over HTTPS',
      bootstrap,
      supported: false,
    }
  }

  let last: RdapSnapshot | undefined
  for (const base of bases) {
    const snapshot = await fetchRdapDomainAt(base, domain, { ...options, now: observedAt })
    if (snapshot.ok) return { ...snapshot, bootstrap, supported: true }
    if (snapshot.status === 404) return { ...snapshot, bootstrap, supported: true }
    last = snapshot
  }
  return { ...(last as RdapSnapshot), bootstrap, supported: true }
}

/** One reading of a domain's registry record, or why there isn't one. */
export async function readDomain(
  domain: string,
  options: { bootstrap?: unknown; signal?: AbortSignal; now?: number } = {},
): Promise<{ ok: true; facts: RdapFacts; hash: string } | { ok: false; reason: string; final?: boolean }> {
  const snapshot = await fetchRdapDomain(domain, options)
  if (!snapshot.supported) {
    return { ok: false, reason: 'this TLD publishes no RDAP service over HTTPS, so its registrar cannot be checked', final: true }
  }
  if (snapshot.status === 404) return { ok: false, reason: 'the registry says this domain is not registered', final: true }
  if (!snapshot.ok || snapshot.raw === undefined) {
    return { ok: false, reason: snapshot.error ?? `the registry did not answer (HTTP ${snapshot.status ?? 'none'})` }
  }
  const problem = rdapAnswerProblem(snapshot.response, domain)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, facts: parseRdapDomain(snapshot.response), hash: snapshot.hash ?? snapshotHash(snapshot.raw) }
}
