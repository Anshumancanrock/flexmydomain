import type { NetworkName } from './tree.js'

export interface TradeRules {
  /** The buyer's refund via the timeout leaf, in blocks after funding. */
  timeoutBlocks: number
  /** Blocks after funding the seller has to transfer the domain to the buyer. */
  deliverBlocks: number
}

export const SITE_RULES: Readonly<Record<NetworkName, Readonly<TradeRules>>> = Object.freeze({
  // About 30 days, a week of it to transfer: a move between registrars can take five days.
  mainnet: Object.freeze({ timeoutBlocks: 4320, deliverBlocks: 1008 }),
  // Test coins: a day, and about 2 hours to transfer, so a trade fits in an afternoon.
  testnet: Object.freeze({ timeoutBlocks: 144, deliverBlocks: 12 }),
  signet: Object.freeze({ timeoutBlocks: 144, deliverBlocks: 12 }),
  regtest: Object.freeze({ timeoutBlocks: 144, deliverBlocks: 12 }),
})

export const MIN_ARBITER_BLOCKS = 72

/** Why these rules can't make a fair escrow, or undefined. */
export function rulesProblem(rules: TradeRules): string | undefined {
  for (const [name, blocks] of Object.entries(rules)) {
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 65535) return `${name} must be 1..65535 blocks`
  }
  if (rules.timeoutBlocks - rules.deliverBlocks < MIN_ARBITER_BLOCKS) {
    return `the timeout leaves under ${MIN_ARBITER_BLOCKS} blocks after the transfer deadline, so a dispute could be outrun`
  }
  return undefined
}

export interface Deadlines {
  deliverBy: number
  timeoutAt: number
}

export function deadlines(fundingHeight: number, rules: TradeRules): Deadlines {
  return { deliverBy: fundingHeight + rules.deliverBlocks, timeoutAt: fundingHeight + rules.timeoutBlocks }
}

export type RuleAction = 'wait' | 'release' | 'refund' | 'decide'

export type Stage = 'awaiting-transfer' | 'transferred' | 'received' | 'cancelled' | 'disputed' | 'late'

export interface TradeFacts {
  rules: TradeRules
  fundingHeight: number
  tip: number
  seller: { sent?: boolean; cancelled?: boolean; disputed?: boolean }
  buyer: { received?: boolean; disputed?: boolean }
}

export interface RuleVerdict {
  action: RuleAction
  reason: string
  stage: Stage
  deadlines: Deadlines
  /** The buyer's lone refund can be mined in the next block, so anything else now races it. */
  timedOut: boolean
}

export function arbiterRule(facts: TradeFacts): RuleVerdict {
  const d = deadlines(facts.fundingHeight, facts.rules)
  const timedOut = facts.tip + 1 >= d.timeoutAt
  const { seller, buyer, tip } = facts
  const verdict = (action: RuleAction, stage: Stage, reason: string): RuleVerdict => ({ action, reason, stage, deadlines: d, timedOut })

  if (buyer.received) return verdict('release', 'received', 'the buyer confirmed the domain is in their account')
  if (seller.cancelled) return verdict('refund', 'cancelled', 'the seller cancelled the sale')
  if (buyer.disputed || seller.disputed) {
    const who = buyer.disputed && seller.disputed ? 'both sides' : buyer.disputed ? 'the buyer' : 'the seller'
    return verdict('decide', 'disputed', `${who} asked the arbiter to decide, on the registry's record and what each side shows`)
  }
  if (seller.sent) {
    return verdict('wait', 'transferred', 'the seller says the domain is on its way to the buyer, who confirms once it has arrived')
  }
  if (tip >= d.deliverBy) {
    return verdict('refund', 'late', `the seller did not say the domain was transferred before block ${d.deliverBy}`)
  }
  return verdict('wait', 'awaiting-transfer', `the seller transfers the domain to the buyer before block ${d.deliverBy}`)
}
