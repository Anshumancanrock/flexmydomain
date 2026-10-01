// What the registry's record says about moving a domain to the buyer now (core/escrow/registrar.ts).

import { test, expect, describe } from 'bun:test'
import {
  SPACESHIP_IANA_ID,
  TRANSFER_LOCK_DAYS,
  normaliseAccount,
  registrarFindings,
} from '../../core/escrow/index.ts'
import type { RdapFacts } from '../../core/oracle/rdap.ts'

const NOW = 1_789_430_400
const DAY = 86400

describe('an account name', () => {
  test('is trimmed and kept exactly otherwise, case included', () => {
    expect(normaliseAccount('  Buyer_77 ')).toBe('Buyer_77')
    expect(normaliseAccount('buyer+fmd@example.com')).toBe('buyer+fmd@example.com')
  })

  test('has to be 1 to 254 visible ASCII characters', () => {
    for (const bad of ['', '   ', 'has space', 'tab\tinside', 'x'.repeat(255), 'ünïcode', 42, null, undefined]) {
      expect(normaliseAccount(bad)).toBeUndefined()
    }
    expect(normaliseAccount('x'.repeat(254))).toBe('x'.repeat(254))
  })
})

describe('the registry rules for a direct transfer', () => {
  const facts = (over: Partial<RdapFacts> = {}): RdapFacts => ({
    domain: 'lumenary.com',
    statuses: ['clienttransferprohibited'],
    rawStatuses: ['client transfer prohibited'],
    events: [],
    registration: NOW - 400 * DAY,
    expiration: NOW + 300 * DAY,
    lastTransfer: undefined,
    lastChanged: undefined,
    registrarName: 'Spaceship, Inc.',
    registrarIanaId: SPACESHIP_IANA_ID,
    nameservers: ['launch1.spaceship.net', 'launch2.spaceship.net'],
    hasRedaction: true,
    ...over,
  })
  const codes = (f: RdapFacts, level: 'refuse' | 'warn') => registrarFindings(f, NOW).filter((x) => x.level === level).map((x) => x.code)

  test("Spaceship's IANA id is 3862", () => {
    expect(SPACESHIP_IANA_ID).toBe('3862')
  })

  test('any registrar will do, named or not', () => {
    for (const over of [
      {},
      { registrarIanaId: '1068', registrarName: 'NameCheap, Inc.' },
      { registrarIanaId: '146', registrarName: 'GoDaddy.com, LLC' },
      { registrarIanaId: undefined, registrarName: undefined },
    ]) expect(codes(facts(over), 'refuse')).toEqual([])
  })

  test('a name leaving, being deleted or restored is refused', () => {
    for (const status of ['pendingtransfer', 'pendingdelete', 'redemptionperiod', 'pendingrestore', 'pendingrenew']) {
      expect(codes(facts({ statuses: [status] }), 'refuse')).toContain(`status:${status}`)
    }
  })

  test('an expired or nearly expired name is refused, and one with no expiry on record is a warning', () => {
    expect(codes(facts({ expiration: NOW - DAY }), 'refuse')).toContain('expired')
    expect(codes(facts({ expiration: NOW + 10 * DAY }), 'refuse')).toContain('expiring')
    expect(codes(facts({ expiration: undefined }), 'warn')).toContain('no-expiry')
  })

  test('a transfer lock is a warning that names both ways of sending it', () => {
    for (const status of ['clienttransferprohibited', 'servertransferprohibited', 'transferprohibited']) {
      const f = registrarFindings(facts({ statuses: [status] }), NOW)
      expect(f.filter((x) => x.level === 'refuse')).toEqual([])
      const lock = f.find((x) => x.code === 'status:transferprohibited')
      expect(lock?.level).toBe('warn')
      expect(lock?.message).toContain('push')
      expect(lock?.message).toContain('unlock')
    }
    expect(codes(facts({ statuses: [] }), 'warn')).not.toContain('status:transferprohibited')
  })

  test('a registry lock and a hold are warnings, not refusals', () => {
    const f = registrarFindings(facts({ statuses: ['serverupdateprohibited', 'clienthold'] }), NOW)
    expect(f.filter((x) => x.level === 'refuse')).toEqual([])
    expect(f.map((x) => x.code)).toEqual(expect.arrayContaining(['status:serverupdateprohibited', 'status:clienthold']))
  })

  test(`a name registered or moved within ${TRANSFER_LOCK_DAYS} days is a warning: it can't leave its registrar yet`, () => {
    expect(TRANSFER_LOCK_DAYS).toBe(60)
    const young = registrarFindings(facts({ registration: NOW - 10 * DAY }), NOW).find((x) => x.code === 'recent-change')
    expect(young?.level).toBe('warn')
    expect(young?.message).toContain('10 days ago')
    expect(young?.message).toContain('same registrar still works')
    expect(codes(facts({ lastTransfer: NOW - 59 * DAY }), 'warn')).toContain('recent-change')
    expect(codes(facts({ lastTransfer: NOW - 61 * DAY }), 'warn')).not.toContain('recent-change')
    // A date in the future is the registry's error, not a recent move.
    expect(codes(facts({ lastTransfer: NOW + DAY }), 'warn')).not.toContain('recent-change')
  })

  test('a healthy name at any registrar has nothing to say beyond its lock', () => {
    expect(registrarFindings(facts(), NOW).map((x) => x.code)).toEqual(['status:transferprohibited'])
  })
})
