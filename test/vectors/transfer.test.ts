/**
 * Following a domain transfer (core/escrow/transfer.ts).
 *
 * These are the rules that decide whether money is released, derived from
 * public RDAP observations and nothing else. Each test below is a way a real
 * sale goes wrong: a registry that lags, a cached answer read twice, a
 * transfer that completes and is then reversed, a fetch that failed.
 *
 * The rule under test throughout: nothing moves on one observation.
 */

import { test, expect, describe } from 'bun:test'
import {
  MIN_POLL_GAP_SECONDS,
  buildCommitment,
  deriveTransferState,
  fundable,
  registrantActed,
  releasable,
  transferAllowed,
  usable,
} from '../../core/escrow/index.ts'
import { parseRdapDomain } from '../../core/oracle/index.ts'

const NOW = 1789430400
const HALF_HOUR = MIN_POLL_GAP_SECONDS

/** The buyer will receive the name at registrar 292, on their nameservers. */
const COMMITMENT = buildCommitment({
  registrarIanaId: '292',
  nameservers: ['ns1.buyer.example', 'ns2.buyer.example'],
  committedAt: NOW - 86400,
})

/** An RDAP response shaped like the real thing. */
function rdap(over: Record<string, unknown> = {}) {
  return parseRdapDomain({
    objectClassName: 'domain',
    ldhName: 'lumenary.com',
    status: [],
    events: [{ eventAction: 'registration', eventDate: '2015-04-02T10:00:00Z' }],
    entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '1910' }] }],
    nameservers: [{ ldhName: 'NS1.SELLER.EXAMPLE' }, { ldhName: 'NS2.SELLER.EXAMPLE' }],
    ...over,
  })
}

const LOCKED = () => rdap({ status: ['client transfer prohibited'] })
const UNLOCKED = () => rdap()
const PENDING = () => rdap({ status: ['pending transfer'] })
const MOVED = () =>
  rdap({
    entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '292' }] }],
    nameservers: [{ ldhName: 'ns1.buyer.example' }, { ldhName: 'ns2.buyer.example' }],
  })

let seq = 0
const obs = (facts: ReturnType<typeof rdap>, at: number) => ({
  at,
  snapshotHash: `hash-${(seq++).toString().padStart(4, '0')}`,
  facts,
})

const derive = (observations: ReturnType<typeof obs>[]) =>
  deriveTransferState({ observations, commitment: COMMITMENT, now: NOW })

// ---------------------------------------------------------------------------

describe('the two-poll rule', () => {
  test('one observation confirms nothing, however clear it looks', () => {
    const v = derive([obs(MOVED(), NOW - 60)])
    expect(v.confirmed).toBe(false)
    expect(v.state).toBe('unknown')
    expect(releasable(v)).toBe(false)
    // and it says what it saw, so a UI can show "probably, checking again"
    expect(v.reason).toContain('transferred')
  })

  test('two observations too close together are one cached answer', () => {
    const v = derive([obs(MOVED(), NOW - 600), obs(MOVED(), NOW - 300)])
    expect(v.confirmed).toBe(false)
    expect(releasable(v)).toBe(false)
  })

  test('two agreeing observations far enough apart confirm it', () => {
    const v = derive([obs(MOVED(), NOW - HALF_HOUR - 60), obs(MOVED(), NOW - 30)])
    expect(v.confirmed).toBe(true)
    expect(v.state).toBe('transferred')
    expect(releasable(v)).toBe(true)
    expect(v.evidence).toHaveLength(2)
  })

  test('disagreeing observations do not average out', () => {
    const v = derive([obs(MOVED(), NOW - 4000), obs(PENDING(), NOW - 2000), obs(UNLOCKED(), NOW - 60)])
    expect(v.confirmed).toBe(false)
    expect(releasable(v)).toBe(false)
  })

  test('the evidence is the snapshot hashes that justify the verdict', () => {
    const a = obs(MOVED(), NOW - 5000)
    const b = obs(MOVED(), NOW - 100)
    const v = derive([a, b])
    expect(v.evidence).toEqual([a.snapshotHash, b.snapshotHash])
    expect(v.since).toBe(a.at)
  })
})

describe('the states, in the order a sale goes through them', () => {
  test('locked: only the registrant can clear it, so no transfer yet', () => {
    const v = derive([obs(LOCKED(), NOW - 9000), obs(LOCKED(), NOW - 60)])
    expect(v.state).toBe('locked')
    expect(transferAllowed(v)).toBe(false)
  })

  test('unlocked: the name can move, which alone says nothing about who holds it', () => {
    const observations = [obs(UNLOCKED(), NOW - 9000), obs(UNLOCKED(), NOW - 60)]
    const v = derive(observations)
    expect(v.state).toBe('unlocked')
    expect(transferAllowed(v)).toBe(true)
    // Never seen locked, so nobody has shown registrar control: not fundable.
    expect(fundable({ verdict: v, observations, commitment: COMMITMENT })).toBe(false)
    expect(releasable(v)).toBe(false) // nothing has moved yet
  })

  test('pending: the point of no return, but not payable', () => {
    const v = derive([obs(PENDING(), NOW - 9000), obs(PENDING(), NOW - 60)])
    expect(v.state).toBe('pending')
    expect(transferAllowed(v)).toBe(true)
    // A transfer in flight can still fail, be rejected, or be reversed.
    expect(releasable(v)).toBe(false)
  })

  test('transferred: the registry agrees it is where the buyer committed', () => {
    const v = derive([obs(MOVED(), NOW - 9000), obs(MOVED(), NOW - 60)])
    expect(v.state).toBe('transferred')
    expect(releasable(v)).toBe(true)
  })

  test('a re-locked domain at the new registrar is still transferred', () => {
    // Most registrars lock a name the moment it lands. That is not a failure.
    const relocked = () =>
      parseRdapDomain({
        ldhName: 'lumenary.com',
        status: ['client transfer prohibited'],
        entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '292' }] }],
        nameservers: [{ ldhName: 'ns1.buyer.example' }],
      })
    const v = derive([obs(relocked(), NOW - 9000), obs(relocked(), NOW - 60)])
    expect(v.state).toBe('transferred')
    expect(releasable(v)).toBe(true)
  })
})

describe('reversal, the case the arbiter exists for', () => {
  test('transferred, then moved back, is reverted and not payable', () => {
    const v = derive([
      obs(MOVED(), NOW - 40000),
      obs(MOVED(), NOW - 36000),
      obs(UNLOCKED(), NOW - 8000),
      obs(UNLOCKED(), NOW - 60),
    ])
    expect(v.state).toBe('reverted')
    expect(releasable(v)).toBe(false)
    expect(v.reason).toContain('moved back')
  })

  test('one later poll disagreeing is not a reversal', () => {
    // A single stale or cached answer must not undo a confirmed transfer.
    const v = derive([obs(MOVED(), NOW - 40000), obs(MOVED(), NOW - 36000), obs(UNLOCKED(), NOW - 60)])
    expect(v.state).toBe('transferred')
    expect(releasable(v)).toBe(true)
  })

  test('two later polls too close together are not a reversal either', () => {
    const v = derive([
      obs(MOVED(), NOW - 40000),
      obs(MOVED(), NOW - 36000),
      obs(UNLOCKED(), NOW - 400),
      obs(UNLOCKED(), NOW - 60),
    ])
    expect(v.state).toBe('transferred')
  })
})

describe('the fingerprint commitment', () => {
  test('a registrar change alone satisfies it', () => {
    const registrarOnly = buildCommitment({ registrarIanaId: '292', committedAt: NOW })
    const v = deriveTransferState({
      observations: [obs(MOVED(), NOW - 9000), obs(MOVED(), NOW - 60)],
      commitment: registrarOnly,
      now: NOW,
    })
    expect(v.state).toBe('transferred')
  })

  test('a same-registrar push is caught by the nameservers instead', () => {
    // The registrar id never moves, so only the other fingerprint can show it.
    const pushed = () =>
      parseRdapDomain({
        ldhName: 'lumenary.com',
        status: [],
        entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '1910' }] }],
        nameservers: [{ ldhName: 'ns1.buyer.example' }, { ldhName: 'ns2.buyer.example' }],
      })
    const nsOnly = buildCommitment({ nameservers: ['ns1.buyer.example'], committedAt: NOW })
    const v = deriveTransferState({
      observations: [obs(pushed(), NOW - 9000), obs(pushed(), NOW - 60)],
      commitment: nsOnly,
      now: NOW,
    })
    expect(v.state).toBe('transferred')
  })

  test('an empty commitment is refused: it could never be satisfied', () => {
    expect(() => buildCommitment({ committedAt: NOW })).toThrow(/never be shown to have completed/)
    expect(() => buildCommitment({ nameservers: [], committedAt: NOW })).toThrow()
  })

  test('nameservers are normalised, so a trailing dot or capitals still match', () => {
    const c = buildCommitment({ nameservers: ['NS2.Buyer.Example.', 'ns1.buyer.example'], committedAt: NOW })
    expect(c.nameservers).toEqual(['ns1.buyer.example', 'ns2.buyer.example'])
  })
})

describe('failures are not observations', () => {
  test('no polls at all says so plainly', () => {
    const v = derive([])
    expect(v.state).toBe('unknown')
    expect(v.reason).toContain('not been polled')
    expect(transferAllowed(v)).toBe(false)
    expect(fundable({ verdict: v, observations: [], commitment: COMMITMENT })).toBe(false)
    expect(releasable(v)).toBe(false)
  })

  test('a failed fetch is refused as an observation', () => {
    // Recording one would look exactly like a vanished lock or a reversal.
    expect(usable({ facts: undefined, snapshotHash: 'x' })).toBe(false)
    expect(usable({ facts: rdap(), snapshotHash: undefined })).toBe(false)
    expect(usable({ facts: rdap(), snapshotHash: 'x' })).toBe(true)
  })

  test('observations arriving out of order are sorted, not trusted as given', () => {
    const late = obs(MOVED(), NOW - 60)
    const early = obs(MOVED(), NOW - 9000)
    const v = derive([late, early])
    expect(v.state).toBe('transferred')
    expect(v.since).toBe(early.at)
  })
})

// ---------------------------------------------------------------------------
// the registrant check: funding waits for the lock to be seen changing
// ---------------------------------------------------------------------------

describe('the registrant check: only a change to the lock shows who holds the account', () => {
  const acted = (observations: ReturnType<typeof obs>[]) => registrantActed({ observations, commitment: COMMITMENT })
  const gate = (observations: ReturnType<typeof obs>[]) =>
    fundable({ verdict: derive(observations), observations, commitment: COMMITMENT })
  const H = HALF_HOUR

  test('unlocked the whole time proves nothing: a DNS host could have listed it', () => {
    const o = [obs(UNLOCKED(), NOW - 4 * H), obs(UNLOCKED(), NOW - 2 * H), obs(UNLOCKED(), NOW)]
    expect(acted(o).acted).toBe(false)
    expect(acted(o).reason).toContain('not yet been seen with the transfer lock on')
    expect(gate(o)).toBe(false)
  })

  test('locked, then unlocked, each confirmed: the registrant acted, and funding may proceed', () => {
    const o = [obs(LOCKED(), NOW - 5 * H), obs(LOCKED(), NOW - 4 * H), obs(UNLOCKED(), NOW - 2 * H), obs(UNLOCKED(), NOW)]
    const a = acted(o)
    expect(a.acted).toBe(true)
    expect(a.lockedAt).toBe(NOW - 4 * H)
    expect(a.unlockedAt).toBe(NOW - 2 * H)
    expect(a.evidence).toEqual(o.map((x) => x.snapshotHash))
    expect(gate(o)).toBe(true)
  })

  test('the domain already locked when the escrow opened is the easy case: one turn off', () => {
    const o = [obs(LOCKED(), NOW - 3 * H), obs(LOCKED(), NOW - 2 * H), obs(UNLOCKED(), NOW - H), obs(UNLOCKED(), NOW)]
    expect(acted(o).acted).toBe(true)
    expect(gate(o)).toBe(true)
  })

  test('a transfer already in flight before funding is not fundable: someone else is moving it', () => {
    const o = [obs(LOCKED(), NOW - 3 * H), obs(LOCKED(), NOW - 2 * H), obs(PENDING(), NOW - H), obs(PENDING(), NOW)]
    expect(acted(o).acted).toBe(true) // the lock did change, and pending shows it off
    expect(transferAllowed(derive(o))).toBe(true) // the name is moving
    expect(gate(o)).toBe(false) // but not to anyone who has paid
  })

  test('one locked reading is not a confirmed lock: it could be a stale cache', () => {
    const o = [obs(LOCKED(), NOW - 4 * H), obs(UNLOCKED(), NOW - 2 * H), obs(UNLOCKED(), NOW)]
    expect(acted(o).acted).toBe(false)
    expect(gate(o)).toBe(false)
  })

  test('an unlock seen only before the lock does not count', () => {
    const o = [obs(UNLOCKED(), NOW - 6 * H), obs(UNLOCKED(), NOW - 5 * H), obs(LOCKED(), NOW - 2 * H), obs(LOCKED(), NOW)]
    expect(acted(o).acted).toBe(false)
    expect(acted(o).reason).toContain('lock on')
  })

  test('turned off and then back on: the latest reading is locked, so no', () => {
    const o = [
      obs(LOCKED(), NOW - 7 * H), obs(LOCKED(), NOW - 6 * H),
      obs(UNLOCKED(), NOW - 4 * H), obs(UNLOCKED(), NOW - 3 * H),
      obs(LOCKED(), NOW),
    ]
    expect(acted(o).acted).toBe(false)
    expect(gate(o)).toBe(false)
  })

  test('the unlock needs two readings far enough apart, like everything else', () => {
    const o = [obs(LOCKED(), NOW - 4 * H), obs(LOCKED(), NOW - 3 * H), obs(UNLOCKED(), NOW - 600), obs(UNLOCKED(), NOW)]
    expect(acted(o).acted).toBe(false)
    expect(acted(o).reason).toContain('not yet been seen off')
  })

  test('readings out of order are sorted first', () => {
    const o = [obs(UNLOCKED(), NOW), obs(LOCKED(), NOW - 4 * H), obs(UNLOCKED(), NOW - 2 * H), obs(LOCKED(), NOW - 5 * H)]
    expect(acted(o).acted).toBe(true)
  })
})
