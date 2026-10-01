// The arbiter's trade rules (core/escrow/trade.ts), a pure function of heights and claims.

import { test, expect, describe } from 'bun:test'
import {
  MIN_ARBITER_BLOCKS,
  SITE_RULES,
  arbiterRule,
  deadlines,
  rulesProblem,
  type RuleVerdict,
  type Stage,
  type TradeFacts,
  type TradeRules,
} from '../../core/escrow/index.ts'

const RULES: TradeRules = { timeoutBlocks: 144, deliverBlocks: 12 }
const F = 1000 // funding block
const DELIVER_BY = F + 12
const TIMEOUT_AT = F + 144

const facts = (over: Partial<TradeFacts> = {}): TradeFacts => ({
  rules: RULES,
  fundingHeight: F,
  tip: F,
  seller: {},
  buyer: {},
  ...over,
})
const rule = (over: Partial<TradeFacts> = {}) => arbiterRule(facts(over))

describe("the site's rules", () => {
  test('are a month with a week to transfer on mainnet, and a day with two hours on the test networks', () => {
    expect(SITE_RULES).toEqual({
      mainnet: { timeoutBlocks: 4320, deliverBlocks: 1008 },
      testnet: { timeoutBlocks: 144, deliverBlocks: 12 },
      signet: { timeoutBlocks: 144, deliverBlocks: 12 },
      regtest: { timeoutBlocks: 144, deliverBlocks: 12 },
    })
  })

  test('are frozen, so no page can loosen them while it runs', () => {
    expect(Object.isFrozen(SITE_RULES)).toBe(true)
    for (const rules of Object.values(SITE_RULES)) expect(Object.isFrozen(rules)).toBe(true)
    expect(() => { (SITE_RULES.mainnet as TradeRules).deliverBlocks = 4000 }).toThrow()
    expect(SITE_RULES.mainnet.deliverBlocks).toBe(1008)
  })

  test('leave the arbiter its room after the transfer deadline on every network', () => {
    expect(MIN_ARBITER_BLOCKS).toBe(72)
    for (const rules of Object.values(SITE_RULES)) {
      expect(rulesProblem(rules)).toBeUndefined()
      expect(rules.timeoutBlocks - rules.deliverBlocks).toBeGreaterThanOrEqual(MIN_ARBITER_BLOCKS)
    }
  })
})

describe('rulesProblem', () => {
  test('accepts a window that leaves exactly MIN_ARBITER_BLOCKS before the timeout, and refuses one block more', () => {
    expect(rulesProblem({ timeoutBlocks: 144, deliverBlocks: 144 - MIN_ARBITER_BLOCKS })).toBeUndefined()
    const problem = rulesProblem({ timeoutBlocks: 144, deliverBlocks: 144 - MIN_ARBITER_BLOCKS + 1 })
    expect(problem).toMatch(/outrun/)
    expect(problem).toContain(String(MIN_ARBITER_BLOCKS))
  })

  test('a transfer window as long as the timelock, or longer, is refused', () => {
    for (const deliverBlocks of [144, 145, 1000]) expect(rulesProblem({ timeoutBlocks: 144, deliverBlocks })).toMatch(/outrun/)
  })

  test('each count is a whole number of blocks in the BIP-68 range', () => {
    for (const bad of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12', undefined, null]) {
      expect(rulesProblem({ timeoutBlocks: 144, deliverBlocks: bad as number })).toBe('deliverBlocks must be 1..65535 blocks')
      expect(rulesProblem({ timeoutBlocks: bad as number, deliverBlocks: 12 })).toBe('timeoutBlocks must be 1..65535 blocks')
    }
    expect(rulesProblem({ timeoutBlocks: 65535, deliverBlocks: 1 })).toBeUndefined()
    expect(rulesProblem({ timeoutBlocks: 65535, deliverBlocks: 65535 - MIN_ARBITER_BLOCKS })).toBeUndefined()
  })
})

describe('deadlines', () => {
  test('count blocks from the funding block', () => {
    expect(deadlines(F, RULES)).toEqual({ deliverBy: DELIVER_BY, timeoutAt: TIMEOUT_AT })
    expect(deadlines(850_000, SITE_RULES.mainnet)).toEqual({ deliverBy: 851_008, timeoutAt: 854_320 })
    expect(deadlines(0, SITE_RULES.signet)).toEqual({ deliverBy: 12, timeoutAt: 144 })
  })

  test('every verdict carries them, whatever its stage', () => {
    const verdicts = [
      rule(),
      rule({ tip: DELIVER_BY }),
      rule({ seller: { sent: true } }),
      rule({ seller: { cancelled: true } }),
      rule({ buyer: { disputed: true } }),
      rule({ buyer: { received: true } }),
    ]
    for (const v of verdicts) expect(v.deadlines).toEqual({ deliverBy: DELIVER_BY, timeoutAt: TIMEOUT_AT })
    expect(new Set(verdicts.map((v) => v.stage)).size).toBe(verdicts.length)
  })
})

describe('before the seller says anything', () => {
  test('wait for the transfer, up to the block before the deadline', () => {
    for (const tip of [F, F + 1, DELIVER_BY - 1]) {
      const v = rule({ tip })
      expect(v).toMatchObject({ action: 'wait', stage: 'awaiting-transfer', timedOut: false })
      expect(v.reason).toContain(`block ${DELIVER_BY}`)
    }
  })

  test('from the deadline block on, refund the buyer', () => {
    for (const tip of [DELIVER_BY, DELIVER_BY + 1, TIMEOUT_AT, F + 5000]) {
      const v = rule({ tip })
      expect(v).toMatchObject({ action: 'refund', stage: 'late' })
      expect(v.reason).toContain(`block ${DELIVER_BY}`)
    }
  })

  test('a tip below the funding block, as a stale node gives, still waits', () => {
    expect(rule({ tip: F - 10 })).toMatchObject({ action: 'wait', stage: 'awaiting-transfer', timedOut: false })
  })
})

describe("the seller's word", () => {
  test('"sent" waits for the buyer to confirm, past the transfer deadline too', () => {
    for (const tip of [F, DELIVER_BY - 1, DELIVER_BY, TIMEOUT_AT - 2, F + 5000]) {
      const v = rule({ tip, seller: { sent: true } })
      expect(v).toMatchObject({ action: 'wait', stage: 'transferred' })
      expect(v.reason).toMatch(/confirms/)
    }
  })

  test('"cancelled" refunds at once, whatever else either side has said', () => {
    for (const seller of [{ cancelled: true }, { cancelled: true, sent: true }, { cancelled: true, disputed: true }]) {
      for (const buyer of [{}, { disputed: true }]) {
        for (const tip of [F, DELIVER_BY, F + 5000]) {
          expect(rule({ tip, seller, buyer })).toMatchObject({ action: 'refund', stage: 'cancelled' })
        }
      }
    }
  })
})

describe("the buyer's word", () => {
  test('"received" releases to the seller, whatever the seller said and whenever it comes', () => {
    const sellers = [{}, { sent: true }, { cancelled: true }, { disputed: true }, { sent: true, cancelled: true, disputed: true }]
    for (const seller of sellers) {
      for (const buyer of [{ received: true }, { received: true, disputed: true }]) {
        for (const tip of [F, DELIVER_BY, TIMEOUT_AT, F + 5000]) {
          const v = rule({ tip, seller, buyer })
          expect(v).toMatchObject({ action: 'release', stage: 'received' })
          expect(v.reason).toMatch(/buyer confirmed/)
        }
      }
    }
  })
})

describe('a dispute', () => {
  test("goes to the arbiter to decide, and the reason says whose it is", () => {
    expect(rule({ buyer: { disputed: true } })).toMatchObject({ action: 'decide', stage: 'disputed' })
    expect(rule({ buyer: { disputed: true } }).reason).toMatch(/^the buyer asked the arbiter to decide/)
    expect(rule({ seller: { disputed: true } }).reason).toMatch(/^the seller asked the arbiter to decide/)
    expect(rule({ buyer: { disputed: true }, seller: { disputed: true } }).reason).toMatch(/^both sides asked the arbiter to decide/)
  })

  test('outranks the seller\'s "sent" and the transfer deadline', () => {
    for (const tip of [F, DELIVER_BY, F + 5000]) {
      for (const over of [
        { buyer: { disputed: true } },
        { seller: { disputed: true } },
        { seller: { sent: true }, buyer: { disputed: true } },
        { seller: { sent: true, disputed: true } },
      ]) {
        expect(rule({ tip, ...over })).toMatchObject({ action: 'decide', stage: 'disputed' })
      }
    }
  })
})

describe('precedence', () => {
  test('received, then cancelled, then disputed, then sent, then the deadline', () => {
    const ladder: [Partial<TradeFacts>, RuleVerdict['action'], Stage][] = [
      [{ tip: DELIVER_BY }, 'refund', 'late'],
      [{ tip: DELIVER_BY, seller: { sent: true } }, 'wait', 'transferred'],
      [{ tip: DELIVER_BY, seller: { sent: true }, buyer: { disputed: true } }, 'decide', 'disputed'],
      [{ tip: DELIVER_BY, seller: { sent: true, cancelled: true }, buyer: { disputed: true } }, 'refund', 'cancelled'],
      [{ tip: DELIVER_BY, seller: { sent: true, cancelled: true }, buyer: { disputed: true, received: true } }, 'release', 'received'],
    ]
    for (const [over, action, stage] of ladder) expect(rule(over)).toMatchObject({ action, stage })
  })
})

describe('the timelock', () => {
  test('is flagged once the next block can carry the lone refund', () => {
    expect(rule({ tip: TIMEOUT_AT - 2 }).timedOut).toBe(false)
    expect(rule({ tip: TIMEOUT_AT - 1 }).timedOut).toBe(true)
    expect(rule({ tip: TIMEOUT_AT }).timedOut).toBe(true)
  })

  test('is flagged the same at every stage, and changes no action', () => {
    const overs: Partial<TradeFacts>[] = [
      {},
      { seller: { sent: true } },
      { seller: { cancelled: true } },
      { buyer: { disputed: true } },
      { buyer: { received: true } },
    ]
    for (const over of overs) {
      const before = rule({ ...over, tip: TIMEOUT_AT - 2 })
      const after = rule({ ...over, tip: TIMEOUT_AT - 1 })
      expect([before.timedOut, after.timedOut]).toEqual([false, true])
      expect(after.action).toBe(before.action)
      expect(after.stage).toBe(before.stage)
    }
  })

  test("on mainnet's month too", () => {
    const fundingHeight = 850_000
    const at = (tip: number) => arbiterRule({ ...facts({ rules: SITE_RULES.mainnet, fundingHeight, tip }) })
    expect(at(fundingHeight + 1007)).toMatchObject({ stage: 'awaiting-transfer', timedOut: false })
    expect(at(fundingHeight + 1008)).toMatchObject({ stage: 'late', timedOut: false })
    expect(at(fundingHeight + 4318).timedOut).toBe(false)
    expect(at(fundingHeight + 4319).timedOut).toBe(true)
  })
})

test('the same facts give the same verdict, and the facts are left as they were', () => {
  const frozen = facts({ tip: DELIVER_BY, seller: Object.freeze({ sent: true }), buyer: Object.freeze({ disputed: true }) })
  Object.freeze(frozen)
  const first = arbiterRule(frozen)
  expect(arbiterRule(frozen)).toEqual(first)
  expect(frozen).toEqual(facts({ tip: DELIVER_BY, seller: { sent: true }, buyer: { disputed: true } }))
})

test('every combination of claims and times gives exactly one action, with a reason', () => {
  const tips = [F - 1, F, DELIVER_BY - 1, DELIVER_BY, TIMEOUT_AT - 2, TIMEOUT_AT - 1, TIMEOUT_AT, F + 5000]
  const flags = [false, true]
  const stageOf: Record<Stage, RuleVerdict['action']> = {
    'awaiting-transfer': 'wait',
    transferred: 'wait',
    received: 'release',
    cancelled: 'refund',
    late: 'refund',
    disputed: 'decide',
  }
  let seen = 0
  for (const tip of tips) for (const sent of flags) for (const cancelled of flags) for (const sellerDisputed of flags)
  for (const received of flags) for (const buyerDisputed of flags) {
    const v = rule({ tip, seller: { sent, cancelled, disputed: sellerDisputed }, buyer: { received, disputed: buyerDisputed } })
    seen++
    expect(stageOf[v.stage]).toBe(v.action)
    expect(v.reason.length).toBeGreaterThan(10)
    expect(v.timedOut).toBe(tip + 1 >= TIMEOUT_AT)
    const disputed = sellerDisputed || buyerDisputed
    // The seller is paid only on the buyer's own word that the domain arrived.
    expect(v.action === 'release').toBe(received)
    // The buyer is refunded only on the seller's cancellation, or its silence past the deadline.
    expect(v.action === 'refund').toBe(!received && (cancelled || (!disputed && !sent && tip >= DELIVER_BY)))
    // A dispute nobody has settled by their own word goes to the arbiter.
    expect(v.action === 'decide').toBe(!received && !cancelled && disputed)
  }
  expect(seen).toBe(tips.length * 32)
})
