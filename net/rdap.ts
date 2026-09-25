/**
 * RDAP fetching (IANA bootstrap and registry queries). core/oracle/rdap.ts decides.
 * Responses are kept as raw text plus sha256. The digest goes in the escrow event,
 * and a hash of re-serialised JSON would prove nothing about what the registry sent.
 */

import { rdapBaseUrls, rdapDomainUrl, snapshotHash } from '../core/oracle/rdap.js'

export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/** One RDAP observation, with what a dispute needs. */
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

/**
 * IANA bootstrap file, cached in the module for a day by default (`force` skips).
 * It is ~150 KB and changes daily at most. Supported TLDs are whatever it lists,
 * so a registry that adds RDAP works with no code change.
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

/** For tests, and for a manual refresh. */
export function clearBootstrapCache(): void {
  bootstrapCache = undefined
}

/**
 * Query one registry. A 404 is the registry saying "not registered", returned
 * with status 404, not thrown. A network failure has no status. An answer may
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
 * Query through the bootstrap file, trying each published base URL in turn.
 * The first is often slow or down, so one failure is no verdict on the name.
 * Rate limits are the usual failure. Pollers should back off, not spin.
 */
export async function fetchRdapDomain(
  domain: string,
  options: { bootstrap?: unknown; signal?: AbortSignal; now?: number } = {},
): Promise<RdapSnapshot & { bootstrap: unknown; supported: boolean }> {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000)
  const bootstrap = options.bootstrap ?? (await fetchRdapBootstrap(options))
  const bases = rdapBaseUrls(bootstrap, domain)

  if (bases.length === 0) {
    // Not an error. "Flex any domain, escrow only what we can verify", and
    // without RDAP we can't verify.
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
    // A 404 is the registry answering. Another mirror would say the same.
    if (snapshot.status === 404) return { ...snapshot, bootstrap, supported: true }
    last = snapshot
  }
  return { ...(last as RdapSnapshot), bootstrap, supported: true }
}
