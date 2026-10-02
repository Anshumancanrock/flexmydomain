// RDAP registry oracle. Parsing and eligibility only, net/rdap.ts fetches.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { normaliseDomain, tldOf, tryNormaliseDomain } from './domain.js'

export const SECONDS_PER_DAY = 86400

/** ICANN lock after a registration or transfer. */
export const TRANSFER_LOCK_DAYS = 60

export const MIN_EXPIRY_DAYS = 45

/** IANA bootstrap (RFC 7484). Cache daily, never hardcode a TLD list. */
export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

export function rdapBaseUrls(bootstrap: unknown, domain: string): string[] {
  const d = tryNormaliseDomain(domain)
  if (!d.ok) return []
  if (typeof bootstrap !== 'object' || bootstrap === null) return []
  const services = (bootstrap as { services?: unknown }).services
  if (!Array.isArray(services)) return []

  const labels = d.domain.split('.')
  let bestLength = -1
  let best: string[] = []

  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue
    const [entries, urls] = service as [unknown, unknown]
    if (!Array.isArray(entries) || !Array.isArray(urls)) continue

    for (const entry of entries) {
      if (typeof entry !== 'string') continue
      const suffix = entry.toLowerCase().replace(/^\.|\.$/g, '')
      if (suffix === '') continue
      const suffixLabels = suffix.split('.')
      if (suffixLabels.length >= labels.length) continue
      const tail = labels.slice(labels.length - suffixLabels.length).join('.')
      if (tail !== suffix) continue
      if (suffixLabels.length > bestLength) {
        bestLength = suffixLabels.length
        best = urls.filter((u): u is string => typeof u === 'string')
      }
    }
  }

  // HTTPS only: a plain-HTTP answer can be rewritten by anyone on the path.
  return best.filter((u) => /^https:\/\//i.test(u)).map((u) => (u.endsWith('/') ? u : `${u}/`))
}

export function rdapDomainUrl(baseUrl: string, domain: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}domain/${normaliseDomain(domain)}`
}

export function tldHasRdap(bootstrap: unknown, domain: string): boolean {
  return rdapBaseUrls(bootstrap, domain).length > 0
}

export function foldStatus(value: string): string {
  return value.toLowerCase().replace(/[\s\-_]/g, '')
}

/** `unix` is `date` in seconds, undefined when it doesn't parse. */
export interface RdapEvent {
  action: string
  date: string
  unix: number | undefined
}

export interface RdapFacts {
  domain: string | undefined
  /** Folded. Compare against these, never the raw ones. */
  statuses: string[]
  rawStatuses: string[]
  events: RdapEvent[]
  registration: number | undefined
  expiration: number | undefined
  lastTransfer: number | undefined
  lastChanged: number | undefined
  registrarName: string | undefined
  registrarIanaId: string | undefined
  nameservers: string[]
  /** RFC 9537 redaction notice present. */
  hasRedaction: boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[Tt]/

function parseDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return undefined
  const ms = Date.parse(value)
  // Only host facility in core/. Reads registry timestamps, never the clock.
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

function lastEvent(events: RdapEvent[], action: string): number | undefined {
  let latest: number | undefined
  for (const e of events) {
    if (foldStatus(e.action) !== foldStatus(action) || e.unix === undefined) continue
    if (latest === undefined || e.unix > latest) latest = e.unix
  }
  return latest
}

export function parseRdapDomain(response: unknown): RdapFacts {
  const r = (typeof response === 'object' && response !== null ? response : {}) as Record<string, unknown>

  const rawStatuses = Array.isArray(r.status) ? r.status.filter((s): s is string => typeof s === 'string') : []

  const events: RdapEvent[] = (Array.isArray(r.events) ? r.events : [])
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      action: typeof e.eventAction === 'string' ? e.eventAction : '',
      date: typeof e.eventDate === 'string' ? e.eventDate : '',
      unix: parseDate(e.eventDate),
    }))

  const ldh = typeof r.ldhName === 'string' ? r.ldhName : typeof r.unicodeName === 'string' ? r.unicodeName : undefined
  const parsedDomain = ldh ? tryNormaliseDomain(ldh) : undefined

  const registrar = findRegistrar(r.entities)

  const nameservers = (Array.isArray(r.nameservers) ? r.nameservers : [])
    .map((ns) => (typeof ns === 'object' && ns !== null ? (ns as Record<string, unknown>).ldhName : undefined))
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.toLowerCase().replace(/\.$/, ''))
    .sort()

  return {
    domain: parsedDomain && parsedDomain.ok ? parsedDomain.domain : undefined,
    statuses: rawStatuses.map(foldStatus),
    rawStatuses,
    events,
    registration: lastEvent(events, 'registration'),
    expiration: lastEvent(events, 'expiration'),
    lastTransfer: lastEvent(events, 'transfer'),
    lastChanged: lastEvent(events, 'last changed'),
    registrarName: registrar.name,
    registrarIanaId: registrar.ianaId,
    nameservers,
    hasRedaction: Array.isArray(r.redacted) && r.redacted.length > 0,
  }
}

function findRegistrar(entities: unknown): { name?: string; ianaId?: string } {
  if (!Array.isArray(entities)) return {}
  for (const entity of entities) {
    if (typeof entity !== 'object' || entity === null) continue
    const e = entity as Record<string, unknown>
    const roles = Array.isArray(e.roles) ? e.roles.map((x) => String(x).toLowerCase()) : []
    if (!roles.includes('registrar')) continue

    let ianaId: string | undefined
    if (Array.isArray(e.publicIds)) {
      for (const pid of e.publicIds) {
        if (typeof pid !== 'object' || pid === null) continue
        const p = pid as Record<string, unknown>
        if (typeof p.type === 'string' && /iana/i.test(p.type) && p.identifier !== undefined) {
          ianaId = String(p.identifier).trim()
        }
      }
    }
    return { name: vcardName(e.vcardArray), ianaId }
  }
  return {}
}

/** Registrar `fn` from a jCard (RFC 7095), `["vcard", [["fn", {}, "text", "Name"], ...]]`. */
function vcardName(vcardArray: unknown): string | undefined {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return undefined
  const properties = vcardArray[1]
  if (!Array.isArray(properties)) return undefined
  for (const property of properties) {
    if (!Array.isArray(property) || property.length < 4) continue
    if (property[0] === 'fn' && typeof property[3] === 'string') return property[3]
  }
  return undefined
}

export const REFUSING_STATUSES = [
  'pendingdelete',
  'redemptionperiod',
  'servertransferprohibited',
  'pendingrenew',
  'pendingrestore',
] as const

/** Not fatal, but the buyer must see them. */
export const WARNING_STATUSES = ['clienthold', 'serverhold', 'inactive', 'pendingupdate'] as const

/** Must be seen on, then off, before funding. Only the registrant can flip it. */
export const TRANSFER_LOCK_STATUS = 'clienttransferprohibited'

/** Some registries send RFC 9083's generic "transfer prohibited" for the same lock. */
export function isTransferLocked(statuses: readonly string[]): boolean {
  return statuses.includes(TRANSFER_LOCK_STATUS) || statuses.includes('transferprohibited')
}

export const PENDING_TRANSFER_STATUS = 'pendingtransfer'

export type FindingLevel = 'refuse' | 'warn'

export interface Finding {
  level: FindingLevel
  code: string
  message: string
}

export interface Eligibility {
  listable: boolean
  unlocked: boolean
  pendingTransfer: boolean
  findings: Finding[]
  facts: RdapFacts
  daysUntilExpiry: number | undefined
  daysSinceRegistration: number | undefined
  daysSinceTransfer: number | undefined
}

export function checkEligibility(params: {
  domain: string
  response: unknown
  now: number
  bootstrap?: unknown
}): Eligibility {
  const facts = parseRdapDomain(params.response)
  const findings = eligibilityFindings({ facts, now: params.now, domain: params.domain, bootstrap: params.bootstrap })
  const days = (from: number | undefined) => (from === undefined ? undefined : (params.now - from) / SECONDS_PER_DAY)

  return {
    listable: !findings.some((f) => f.level === 'refuse'),
    unlocked: !isTransferLocked(facts.statuses),
    pendingTransfer: facts.statuses.includes(PENDING_TRANSFER_STATUS),
    findings,
    facts,
    daysUntilExpiry: facts.expiration === undefined ? undefined : (facts.expiration - params.now) / SECONDS_PER_DAY,
    daysSinceRegistration: days(facts.registration),
    daysSinceTransfer: days(facts.lastTransfer),
  }
}

export function eligibilityFindings(params: {
  facts: RdapFacts
  now: number
  domain?: string
  bootstrap?: unknown
}): Finding[] {
  const { facts } = params
  const findings: Finding[] = []
  const days = (from: number | undefined) => (from === undefined ? undefined : (params.now - from) / SECONDS_PER_DAY)

  const domain = params.domain === undefined ? undefined : tryNormaliseDomain(params.domain)
  if (domain?.ok && facts.domain && facts.domain !== domain.domain) {
    findings.push({
      level: 'refuse',
      code: 'domain-mismatch',
      message: `the registry answered about ${facts.domain}, not ${domain.domain}`,
    })
  }

  if (params.bootstrap !== undefined && domain?.ok && !tldHasRdap(params.bootstrap, domain.domain)) {
    findings.push({
      level: 'refuse',
      code: 'no-rdap',
      message: `.${tldOf(domain.domain)} publishes no RDAP service over HTTPS, so nothing about this name can be verified`,
    })
  }

  for (const status of REFUSING_STATUSES) {
    if (facts.statuses.includes(status)) {
      findings.push({ level: 'refuse', code: `status:${status}`, message: `registry status ${status}` })
    }
  }
  for (const status of WARNING_STATUSES) {
    if (facts.statuses.includes(status)) {
      findings.push({ level: 'warn', code: `status:${status}`, message: `registry status ${status}` })
    }
  }

  const daysSinceRegistration = days(facts.registration)
  const daysSinceTransfer = days(facts.lastTransfer)
  const daysUntilExpiry =
    facts.expiration === undefined ? undefined : (facts.expiration - params.now) / SECONDS_PER_DAY

  // Refuse, don't warn. The sale can't complete, and they'd only find out after funding.
  if (daysSinceRegistration !== undefined && daysSinceRegistration < TRANSFER_LOCK_DAYS) {
    findings.push({
      level: 'refuse',
      code: 'transfer-lock:registration',
      message: `registered ${Math.floor(daysSinceRegistration)} days ago; ICANN locks transfers for ${TRANSFER_LOCK_DAYS}`,
    })
  }
  if (daysSinceTransfer !== undefined && daysSinceTransfer < TRANSFER_LOCK_DAYS) {
    findings.push({
      level: 'refuse',
      code: 'transfer-lock:transfer',
      message: `transferred ${Math.floor(daysSinceTransfer)} days ago; ICANN locks transfers for ${TRANSFER_LOCK_DAYS}`,
    })
  }

  if (daysUntilExpiry !== undefined) {
    if (daysUntilExpiry < 0) {
      findings.push({
        level: 'refuse',
        code: 'expired',
        message: `expired ${Math.floor(-daysUntilExpiry)} days ago`,
      })
    } else if (daysUntilExpiry < MIN_EXPIRY_DAYS) {
      findings.push({
        level: 'refuse',
        code: 'expiring',
        message: `expires in ${Math.floor(daysUntilExpiry)} days; a sale inside ${MIN_EXPIRY_DAYS} days raises who pays the renewal`,
      })
    }
  } else {
    findings.push({
      level: 'warn',
      code: 'no-expiry',
      message: 'the registry published no expiration date, so the expiry rule could not be applied',
    })
  }

  if (facts.registration === undefined) {
    findings.push({
      level: 'warn',
      code: 'no-registration',
      message: 'the registry published no registration date, so age could not be checked',
    })
  }

  if (facts.statuses.includes(PENDING_TRANSFER_STATUS)) {
    findings.push({
      level: 'warn',
      code: 'pending-transfer',
      message: 'a transfer is already underway on this name',
    })
  }

  return findings
}

export function rdapAnswerProblem(response: unknown, domain: string): string | undefined {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    return 'the registry sent no domain object'
  }
  const r = response as Record<string, unknown>
  if (r.objectClassName !== undefined && r.objectClassName !== 'domain') {
    return `the registry sent a ${JSON.stringify(r.objectClassName)} object, not a domain`
  }
  if (!Array.isArray(r.status)) return 'the registry answer has no status list'

  // RFC 9083 section 10.2.1 truncation notices. "Due to authorization" only hides personal data, which is redacted anyway.
  const truncated = [r.notices, r.remarks].some(
    (list) =>
      Array.isArray(list) &&
      list.some(
        (n) =>
          typeof n === 'object' &&
          n !== null &&
          /truncated due to (excessive load|unexplainable reasons)/i.test(String((n as { type?: unknown }).type ?? '')),
      ),
  )
  if (truncated) return 'the registry truncated its answer'

  const wanted = tryNormaliseDomain(domain)
  if (!wanted.ok) return `${JSON.stringify(domain)} is not a domain`
  const echoed = parseRdapDomain(response).domain
  if (echoed !== wanted.domain) return `the registry answered about ${echoed ?? 'no name'}, not ${wanted.domain}`
  return undefined
}

/** sha256 of the response as received, for each poll's snapshot. Pass the bytes when you have them. */
export function snapshotHash(raw: string | Uint8Array): string {
  return bytesToHex(sha256(typeof raw === 'string' ? utf8ToBytes(raw) : raw))
}
