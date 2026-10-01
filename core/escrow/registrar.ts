import { MIN_EXPIRY_DAYS, SECONDS_PER_DAY, type Finding, type RdapFacts } from '../oracle/rdap.js'

export const SPACESHIP_IANA_ID = '3862'

export const TRANSFER_LOCK_DAYS = 60

/** States in which the name is leaving, being deleted, or can't change hands. */
const BLOCKING_STATUSES = ['pendingtransfer', 'pendingdelete', 'redemptionperiod', 'pendingrestore', 'pendingrenew'] as const

export function normaliseAccount(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const account = raw.trim()
  return /^[\x21-\x7e]{1,254}$/.test(account) ? account : undefined
}

export function registrarFindings(facts: RdapFacts, now: number): Finding[] {
  const findings: Finding[] = []

  for (const status of BLOCKING_STATUSES) {
    if (facts.statuses.includes(status)) {
      findings.push({ level: 'refuse', code: `status:${status}`, message: `the registry shows status ${status}` })
    }
  }
  if (facts.statuses.includes('serverupdateprohibited')) {
    findings.push({
      level: 'warn',
      code: 'status:serverupdateprohibited',
      message: 'the registry has the name update-locked, which can stop it changing hands; the seller should check with the registrar first',
    })
  }
  if (['clienttransferprohibited', 'servertransferprohibited', 'transferprohibited'].some((s) => facts.statuses.includes(s))) {
    findings.push({
      level: 'warn',
      code: 'status:transferprohibited',
      message: 'the domain is transfer-locked: a push to another account at the same registrar usually works anyway, and a move to another registrar needs the seller to unlock it first',
    })
  }
  for (const status of ['clienthold', 'serverhold']) {
    if (facts.statuses.includes(status)) {
      findings.push({ level: 'warn', code: `status:${status}`, message: `the registry shows status ${status}, so the domain does not resolve` })
    }
  }

  const since = (t: number | undefined) => (t === undefined ? undefined : (now - t) / SECONDS_PER_DAY)
  const young = [since(facts.registration), since(facts.lastTransfer)].filter((d): d is number => d !== undefined && d >= 0 && d < TRANSFER_LOCK_DAYS)
  if (young.length) {
    findings.push({
      level: 'warn',
      code: 'recent-change',
      message: `the domain was registered or moved between registrars ${Math.floor(Math.min(...young))} days ago, so for ${TRANSFER_LOCK_DAYS} days it can't move to another registrar: a push to the buyer's account at the same registrar still works`,
    })
  }

  if (facts.expiration === undefined) {
    findings.push({ level: 'warn', code: 'no-expiry', message: 'the registry published no expiration date' })
  } else {
    const days = (facts.expiration - now) / SECONDS_PER_DAY
    if (days < 0) {
      findings.push({ level: 'refuse', code: 'expired', message: `the domain expired ${Math.floor(-days)} days ago` })
    } else if (days < MIN_EXPIRY_DAYS) {
      findings.push({
        level: 'refuse',
        code: 'expiring',
        message: `the domain expires in ${Math.floor(days)} days; renew it before selling, so the buyer doesn't inherit the deadline`,
      })
    }
  }

  return findings
}
