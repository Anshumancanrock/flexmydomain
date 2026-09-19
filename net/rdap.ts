/**
 * RDAP fetching: the IANA bootstrap file and registry domain queries.
 *
 * Isomorphic: `fetch` only. Fetches and records; core/oracle/rdap.ts decides.
 *
 * Every response is kept as raw text alongside its sha256. The digest goes
 * into the escrow event, and a digest of a re-serialised object would prove
 * nothing about what the registry sent.
 */

import { rdapBaseUrls, rdapDomainUrl, snapshotHash } from '../core/oracle/rdap.js'

export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/** One RDAP observation, with everything a dispute would need. */
export interface RdapSnapshot {
  domain: string
  url: string
  ok: boolean
  status: number | undefined
  /** Parsed JSON. Undefined unless the request succeeded and the body parsed. */
  response?: unknown
  /** The bytes as received. Store these; publish the hash. */
  raw?: string
  hash?: string
  observedAt: number
  error?: string
}

/**
 * Fetch and cache the IANA bootstrap file.
 *
 * The cache is a module-level value with a TTL (a day by default). The file
 * changes daily at most, and without the cache every lookup would fetch about
 * 150 KB again to answer "does .io have RDAP". Pass `force` to bypass it.
 *
 * The supported TLDs are whatever this file lists. There is no hardcoded TLD
 * list, so a registry that starts publishing RDAP is supported with no code
 * change.
 */
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

/** Drop the cached bootstrap file. For tests, and for a manual refresh. */
export function clearBootstrapCache(): void {
  bootstrapCache = undefined
}

/**
 * Query one registry for one domain.
 *
 * A 404 means the registry says the name is not registered. That is an
 * answer, returned with `ok: false` and `status: 404` rather than thrown. A
 * network failure has no status at all. The difference matters: an answer may
 * move an escrow, and a failed request never may.
 */
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
    })
    const raw = await response.text()
    if (!response.ok) {
      return { domain, url, ok: false, status: response.status, raw, hash: snapshotHash(raw), observedAt }
    }
    return {
      domain,
      url,
      ok: true,
      status: response.status,
      response: JSON.parse(raw),
      raw,
      hash: snapshotHash(raw),
      observedAt,
    }
  } catch (err) {
    return { domain, url, ok: false, status: undefined, observedAt, error: (err as Error).message }
  }
}

/**
 * Query a domain through the bootstrap file, trying each published base URL.
 *
 * Registries publish more than one base because the first is often slow or
 * down, so a failure on one is not a verdict about the name. Rate limits are
 * the realistic failure here, so a caller that polls should back off rather
 * than retry in a tight loop.
 */
export async function fetchRdapDomain(
  domain: string,
  options: { bootstrap?: unknown; signal?: AbortSignal; now?: number } = {},
): Promise<RdapSnapshot & { bootstrap: unknown; supported: boolean }> {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000)
  const bootstrap = options.bootstrap ?? (await fetchRdapBootstrap(options))
  const bases = rdapBaseUrls(bootstrap, domain)

  if (bases.length === 0) {
    // Not an error. The product rule is "flex any domain, escrow only what we
    // can verify", and a TLD with no RDAP service cannot be verified.
    return {
      domain,
      url: '',
      ok: false,
      status: undefined,
      observedAt,
      error: 'this TLD publishes no RDAP service',
      bootstrap,
      supported: false,
    }
  }

  let last: RdapSnapshot | undefined
  for (const base of bases) {
    const snapshot = await fetchRdapDomainAt(base, domain, { ...options, now: observedAt })
    if (snapshot.ok) return { ...snapshot, bootstrap, supported: true }
    // A 404 is the registry answering. Stop; another mirror will say the same.
    if (snapshot.status === 404) return { ...snapshot, bootstrap, supported: true }
    last = snapshot
  }
  return { ...(last as RdapSnapshot), bootstrap, supported: true }
}
