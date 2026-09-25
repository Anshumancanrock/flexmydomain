/**
 * RDAP registry oracle. Parsing and eligibility only, net/rdap.ts fetches.
 * Time comes in as `now`, so a verdict replays from the snapshot in a dispute.
 * GDPR redacts the registrant almost everywhere. We see which registrar a name
 * moved to, never to whom, which is why the buyer commits to a fingerprint.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { normaliseDomain, tldOf, tryNormaliseDomain } from './domain.js'

export const SECONDS_PER_DAY = 86400

/** ICANN lock after a registration or transfer. */
export const TRANSFER_LOCK_DAYS = 60

/** Refuse anything expiring sooner. Renewal could fall due mid-sale, and who pays is unclear. */
export const MIN_EXPIRY_DAYS = 45

/** IANA bootstrap (RFC 7484). Cache daily, never hardcode a TLD list. */
export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/**
 * All base URLs for the domain, in bootstrap order, since the first is often slow
 * or down. Empty means no RDAP, so the name can be flexed but not escrowed (`.ai`
 * has been one). Longest suffix wins, `co.uk` over `uk` (RFC 7484 section 4).
 */
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

  // RFC 7484 section 4 base URLs end in a slash. Registries don't always publish it.
  return best.map((u) => (u.endsWith('/') ? u : `${u}/`))
}

export function rdapDomainUrl(baseUrl: string, domain: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}domain/${normaliseDomain(domain)}`
}

/** No RDAP, no escrow. */
export function tldHasRdap(bootstrap: unknown, domain: string): boolean {
  return rdapBaseUrls(bootstrap, domain).length > 0
}

/**
 * Fold a status or event action for comparison. RFC 8056 writes "client transfer
 * prohibited", EPP writes "clientTransferProhibited", and servers send both. A
 * missed lock could let an escrow fund against a name that can't move.
 */
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
  /** As echoed by the registry, normalised. Can differ from the query. */
  domain: string | undefined
  /** Folded. Compare against these, never the raw ones. */
  statuses: string[]
  /** Verbatim, for the evidence file. */
  rawStatuses: string[]
  events: RdapEvent[]
  registration: number | undefined
  expiration: number | undefined
  lastTransfer: number | undefined
  lastChanged: number | undefined
  /** Registrar, the destination fingerprint. */
  registrarName: string | undefined
  registrarIanaId: string | undefined
  /** Second fingerprint, for a same-registrar push. */
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

/** Takes parsed JSON. Tolerates any input. */
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
          ianaId = String(p.identifier)
        }
      }
    }
    return { name: vcardName(e.vcardArray), ianaId }
  }
  return {}
}

/**
 * Registrar `fn` from a jCard (RFC 7095), `["vcard", [["fn", {}, "text", "Name"], ...]]`.
 * A person reading a dispute file wants a name, not just the IANA id.
 */
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

/** Unsellable outright. */
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

/** Transfer in progress, the point of no return. */
export const PENDING_TRANSFER_STATUS = 'pendingtransfer'

export type FindingLevel = 'refuse' | 'warn'

export interface Finding {
  level: FindingLevel
  code: string
  message: string
}

export interface Eligibility {
  listable: boolean
  /** Lock off right now. Not enough on its own to fund. */
  unlocked: boolean
  pendingTransfer: boolean
  findings: Finding[]
  facts: RdapFacts
  daysUntilExpiry: number | undefined
  daysSinceRegistration: number | undefined
  daysSinceTransfer: number | undefined
}

/**
 * `listable` gates the marketplace, where zone control is enough. `unlocked` is the
 * lock state now. Neither gates money. The escrow funds only after lock on then off
 * (`registrantActed` in core/escrow/transfer.ts).
 *
 * Without `bootstrap` the TLD rule is skipped, not failed. Unchecked isn't "no RDAP".
 */
export function checkEligibility(params: {
  domain: string
  response: unknown
  now: number
  bootstrap?: unknown
}): Eligibility {
  const facts = parseRdapDomain(params.response)
  const findings: Finding[] = []
  const days = (from: number | undefined) => (from === undefined ? undefined : (params.now - from) / SECONDS_PER_DAY)

  const domain = tryNormaliseDomain(params.domain)
  if (domain.ok && facts.domain && facts.domain !== domain.domain) {
    // A bad redirect or someone else's response. Either way, not evidence about this name.
    findings.push({
      level: 'refuse',
      code: 'domain-mismatch',
      message: `the registry answered about ${facts.domain}, not ${domain.domain}`,
    })
  }

  if (params.bootstrap !== undefined && domain.ok && !tldHasRdap(params.bootstrap, domain.domain)) {
    findings.push({
      level: 'refuse',
      code: 'no-rdap',
      message: `.${tldOf(domain.domain)} publishes no RDAP service, so nothing about this name can be verified`,
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

  const pendingTransfer = facts.statuses.includes(PENDING_TRANSFER_STATUS)
  if (pendingTransfer) {
    findings.push({
      level: 'warn',
      code: 'pending-transfer',
      message: 'a transfer is already underway on this name',
    })
  }

  return {
    listable: !findings.some((f) => f.level === 'refuse'),
    unlocked: !facts.statuses.includes(TRANSFER_LOCK_STATUS),
    pendingTransfer,
    findings,
    facts,
    daysUntilExpiry,
    daysSinceRegistration,
    daysSinceTransfer,
  }
}

/**
 * Buyer commits to this at escrow open, and release is checked against it. A registrar
 * transfer changes `registrarIanaId`. A same-registrar push only moves the nameservers.
 */
export interface Fingerprint {
  registrarIanaId: string | undefined
  nameservers: string[]
}

export function fingerprintOf(facts: RdapFacts): Fingerprint {
  return { registrarIanaId: facts.registrarIanaId, nameservers: facts.nameservers.slice() }
}

export function fingerprintMatches(observed: Fingerprint, committed: Fingerprint): boolean {
  if (committed.registrarIanaId && observed.registrarIanaId === committed.registrarIanaId) return true
  if (committed.nameservers.length === 0) return false
  const set = new Set(observed.nameservers)
  return committed.nameservers.every((ns) => set.has(ns))
}

/**
 * sha256 of the response text as received, for each poll's snapshot. Never hash
 * re-serialised JSON, which won't match what the registry sent. Store the text,
 * publish the digest.
 */
export function snapshotHash(rawResponseText: string): string {
  return bytesToHex(sha256(utf8ToBytes(rawResponseText)))
}
