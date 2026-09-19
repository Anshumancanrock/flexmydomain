/**
 * RDAP, the registry oracle: parsing a domain response, and the eligibility
 * rules.
 *
 * Pure: this module parses a response fetched elsewhere (net/rdap.ts) and
 * decides eligibility from it. Every function that needs the time takes `now`
 * as a parameter, so an eligibility verdict can be reproduced from the
 * snapshot alone months later, in a dispute.
 *
 * Where RDAP is used:
 *
 *   at listing      is this name sellable at all (age, expiry, holds, TLD)
 *   before funding  the transfer lock seen on, then off: registrant control
 *   at transfer     pendingTransfer appearing is the point of no return
 *   at release      registrar IANA id or nameservers match what the buyer
 *                   committed to when the escrow opened
 *   in a dispute    the snapshot history is the evidence file
 *
 * RDAP does not identify the registrant. Since GDPR that is redacted almost
 * everywhere, so a snapshot shows that a name moved and to which registrar,
 * never to whom. That is why the buyer commits to a fingerprint up front.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { normaliseDomain, tldOf, tryNormaliseDomain } from './domain.js'

export const SECONDS_PER_DAY = 86400

/** ICANN's transfer lock after a registration or a transfer, in days. */
export const TRANSFER_LOCK_DAYS = 60

/**
 * Refuse a name that expires sooner than this many days: the renewal could
 * fall due mid-sale, and it is unclear who pays it.
 */
export const MIN_EXPIRY_DAYS = 45

/** The IANA bootstrap file. Cache it daily; never hardcode a TLD list. */
export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

// ---------------------------------------------------------------------------
// bootstrap (RFC 7484)
// ---------------------------------------------------------------------------

/**
 * Find the RDAP base URLs for a domain in the IANA bootstrap file.
 *
 * Returns every URL the registry publishes, in the order given, because the
 * first is often slow or down and a second attempt costs little. An empty
 * array means the TLD has no RDAP service. That is an answer, not an error:
 * such a name can be flexed but not escrowed, and `.ai` has historically been
 * one.
 *
 * Matching is longest-suffix over the service's label lists, per RFC 7484
 * section 4: a registry may publish an entry for `co.uk` as well as for `uk`,
 * and the more specific one wins.
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

  // RFC 7484 section 4: a base URL ends with a slash, and the query path is
  // appended to it. Registries are inconsistent about publishing the slash.
  return best.map((u) => (u.endsWith('/') ? u : `${u}/`))
}

/** The full query URL for one domain against one base. */
export function rdapDomainUrl(baseUrl: string, domain: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}domain/${normaliseDomain(domain)}`
}

/** True when the TLD has an RDAP service. Without one, a name cannot be escrowed. */
export function tldHasRdap(bootstrap: unknown, domain: string): boolean {
  return rdapBaseUrls(bootstrap, domain).length > 0
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * Normalise an RDAP status or event action for comparison.
 *
 * RFC 8056 registers these values in lowercase with spaces ("client transfer
 * prohibited"), EPP and most of the industry write camelCase
 * ("clientTransferProhibited"), and real servers return both. Comparing raw
 * strings would read a lock that is present as absent, which here would let an
 * escrow fund against a domain that cannot move. Both forms fold to one:
 * lowercase, with no spaces, hyphens or underscores.
 */
export function foldStatus(value: string): string {
  return value.toLowerCase().replace(/[\s\-_]/g, '')
}

/** One RDAP event, with its date already resolved to unix seconds. */
export interface RdapEvent {
  action: string
  date: string
  unix: number | undefined
}

/** Everything downstream reads out of a domain response. */
export interface RdapFacts {
  /** The name the registry echoed, normalised. May differ from the name queried. */
  domain: string | undefined
  /** Folded status values. Compare against these, never against the raw ones. */
  statuses: string[]
  /** Raw status values, kept verbatim for the evidence file. */
  rawStatuses: string[]
  events: RdapEvent[]
  registration: number | undefined
  expiration: number | undefined
  lastTransfer: number | undefined
  lastChanged: number | undefined
  /** The destination fingerprint: who holds the name. */
  registrarName: string | undefined
  registrarIanaId: string | undefined
  /** The other destination fingerprint, for a same-registrar push. */
  nameservers: string[]
  /** RFC 9537: the registry says it withheld or redacted something. */
  hasRedaction: boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[Tt]/

function parseDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return undefined
  const ms = Date.parse(value)
  // Date.parse is the one host facility in core/. It only reads a timestamp
  // the registry wrote, never the current time.
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

/** Pull the facts out of a parsed RDAP domain response. Tolerates any input. */
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
 * The registrar's display name out of a jCard (RFC 7095).
 *
 * jCard is `["vcard", [["fn", {}, "text", "Example Registrar, Inc."], ...]]`,
 * three levels of array for one string. The IANA id is the machine
 * fingerprint, but a person reading a dispute file wants to see a name.
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

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------

/** The statuses that make a name unsellable outright. */
export const REFUSING_STATUSES = [
  'pendingdelete',
  'redemptionperiod',
  'servertransferprohibited',
  'pendingrenew',
  'pendingrestore',
] as const

/** Statuses that are not fatal but that a buyer must be shown. */
export const WARNING_STATUSES = ['clienthold', 'serverhold', 'inactive', 'pendingupdate'] as const

/**
 * The transfer lock. Before funding it must be seen on and then off, a change
 * only the registrant can make.
 */
export const TRANSFER_LOCK_STATUS = 'clienttransferprohibited'

/** The status of a transfer in progress: the point of no return. */
export const PENDING_TRANSFER_STATUS = 'pendingtransfer'

export type FindingLevel = 'refuse' | 'warn'

export interface Finding {
  level: FindingLevel
  code: string
  message: string
}

export interface Eligibility {
  /** May this name be listed at all? */
  listable: boolean
  /** Is the transfer lock off right now? Not enough on its own to fund. */
  unlocked: boolean
  /** Has a transfer already started? */
  pendingTransfer: boolean
  findings: Finding[]
  facts: RdapFacts
  daysUntilExpiry: number | undefined
  daysSinceRegistration: number | undefined
  daysSinceTransfer: number | undefined
}

/**
 * Decide whether a domain can be listed, and whether it can move right now.
 *
 * The two answers are separate because listing and funding need different
 * evidence: zone control is enough to list, and selling needs registrant
 * control. `listable` gates the marketplace. `unlocked` says whether the name
 * can move right now. Neither gates money: the escrow funds only once the
 * registry has been seen with the lock on and then off, a change only the
 * registrant can make (`registrantActed` in core/escrow/transfer.ts). A locked
 * domain is listable; so is an unlocked one.
 *
 * `bootstrap` is optional: pass the IANA file to apply the TLD rule, or omit it
 * to check everything else. "Could not check" is not the same as "the TLD has
 * no RDAP", so without the file the rule is skipped, not failed.
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
    // A registry answering about a different name than we asked about is
    // either a redirect we followed wrongly or a response for somebody else's
    // domain. Neither is evidence about this one.
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

  // The 60-day lock is a refusal, not a warning: the sale cannot complete, and
  // without the check the parties would find out after an escrow is funded.
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
 * The fingerprint a buyer commits to when the escrow opens, and that release
 * is checked against.
 *
 * Two values, because either alone has a gap: a transfer between registrars
 * changes `registrarIanaId`, but a same-registrar push does not change it at
 * all, and then the nameservers are what move.
 */
export interface Fingerprint {
  registrarIanaId: string | undefined
  nameservers: string[]
}

export function fingerprintOf(facts: RdapFacts): Fingerprint {
  return { registrarIanaId: facts.registrarIanaId, nameservers: facts.nameservers.slice() }
}

/** Did the name actually move to what the buyer committed to? */
export function fingerprintMatches(observed: Fingerprint, committed: Fingerprint): boolean {
  if (committed.registrarIanaId && observed.registrarIanaId === committed.registrarIanaId) return true
  if (committed.nameservers.length === 0) return false
  const set = new Set(observed.nameservers)
  return committed.nameservers.every((ns) => set.has(ns))
}

/**
 * sha256 of the raw response text, for the snapshot taken at every poll.
 *
 * Hash the bytes as received, never a re-serialised object: `JSON.parse` then
 * `JSON.stringify` normalises whitespace, number formatting and escapes, and
 * the digest would then prove nothing about what the registry sent. Store the
 * text, publish the digest.
 */
export function snapshotHash(rawResponseText: string): string {
  return bytesToHex(sha256(utf8ToBytes(rawResponseText)))
}
