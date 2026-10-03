/** RFC 8484 JSON endpoints, both CORS-enabled (checked 2026-09-18). */
export const DOH_PROVIDERS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
] as const

export const TXT_TYPE = 16

export interface DohObservation {
  provider: string
  records: string[]
  status: number | undefined
  dnssec: boolean
  error?: string
  /** Unix seconds. */
  observedAt: number
  raw?: string
}

export interface TxtLookup {
  name: string
  observations: DohObservation[]
  /** Returned by every provider, all of which answered. Verify against these only. */
  agreed: string[]
  /** Returned by only some providers, or by one while another failed. Shown, never trusted. */
  disputed: string[]
  /** At least one provider answered. */
  answered: boolean
  complete: boolean
  dnssec: boolean
}

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
    const status = typeof body.Status === 'number' ? body.Status : undefined
    if (status !== 0 && status !== 3) {
      return { provider: provider.name, records: [], status, dnssec: false, observedAt, raw, error: `DNS status ${status ?? 'missing'}` }
    }
    const records = (Array.isArray(body.Answer) ? body.Answer : [])
      .filter((a) => a?.type === TXT_TYPE && typeof a.data === 'string')
      .map((a) => unquoteTxt(a.data as string))

    return {
      provider: provider.name,
      records,
      status,
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

export function unquoteTxt(data: string): string {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g)
  if (!parts) return data.trim()
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

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

  const complete = answering.length === observations.length && observations.length > 0
  const agreed: string[] = []
  const disputed: string[] = []
  for (const [record, count] of counts) {
    if (complete && count === answering.length) agreed.push(record)
    else disputed.push(record)
  }

  return {
    name,
    observations,
    agreed: agreed.sort(),
    disputed: disputed.sort(),
    answered: answering.length > 0,
    complete,
    dnssec: answering.length > 0 && answering.every((o) => o.dnssec),
  }
}

/** NIP-05 document, the alternative proof (spec/PROOF.md section 7). */
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
