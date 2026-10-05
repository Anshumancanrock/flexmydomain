// On-chain flex payments. A plain Bitcoin payment carries no domain, so the payer first
// signs a claim naming the domain and the amount they mean to pay, then pays at least that
// much to the site's address. The board pairs each payment with a claim by its amount.
//
// Nothing in the payment points back at its claim, so a copycat who sees a payment can
// sign a backdated claim for the same amount and take the credit. That is fine for test
// coins; real money needs an address per claim, or Lightning zaps with their receipts.

import { isHex32, tagValue, type NostrEvent, type UnsignedEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'
import { MSATS_PER_SAT, type Zap } from './zap.js'

export const FLEX_CLAIM_KIND = 30078
export const FLEX_CLAIM_D_PREFIX = 'fmd:flex:'
export const FLEX_CLAIM_TOPIC = 'fmd-flex'

/** The amount as a topic too, so the board asks only for claims matching what was paid. */
export const flexAmountTopic = (amountSats: number): string => `${FLEX_CLAIM_TOPIC}-${amountSats}`

/** A payment this close above a claim's amount is taken as that claim's. Some wallets add a sat or two. */
export const FLEX_AMOUNT_SLACK_SATS = 10

/** Every amount a claim could have for these payments: each one, give or take the slack. */
export function flexNearAmounts(amounts: readonly number[], slack = FLEX_AMOUNT_SLACK_SATS): number[] {
  const near = new Set<number>()
  for (const amount of amounts) {
    for (let a = Math.max(1, amount - slack); a <= amount + slack; a++) near.add(a)
  }
  return [...near].sort((a, b) => a - b)
}

const CLAIM_ID = /^[0-9a-f]{16,64}$/
const ADDRESS = /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}$/

export interface FlexClaim {
  id: string
  author: string
  domain: string
  amountSats: number
  address: string
  /** The author's clock: when the claim was made. */
  at: number
  event: NostrEvent
}

export interface FlexPayment {
  txid: string
  vout: number
  valueSats: number
  /** Block time; undefined while in the mempool. */
  at?: number
  confirmed: boolean
}

export function buildFlexClaim(params: {
  pubkey: string
  claimId: string
  domain: string
  amountSats: number
  address: string
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildFlexClaim: pubkey must be 64 lowercase hex characters')
  if (!CLAIM_ID.test(params.claimId)) throw new Error('buildFlexClaim: the claim id is 16 to 64 hex characters')
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) throw new Error('buildFlexClaim: amount must be whole sats')
  if (!ADDRESS.test(params.address)) throw new Error('buildFlexClaim: not a segwit address')
  const domain = normaliseDomain(params.domain)
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: FLEX_CLAIM_KIND,
    tags: [
      ['d', FLEX_CLAIM_D_PREFIX + params.claimId],
      ['t', 'flexmydomain'],
      ['t', FLEX_CLAIM_TOPIC],
      ['t', flexAmountTopic(params.amountSats)],
      ['fmd_domain', domain],
      ['fmd_amount', String(params.amountSats)],
      ['fmd_address', params.address],
    ],
    content: '',
  }
}

export function parseFlexClaim(event: NostrEvent): { ok: true; claim: FlexClaim } | { ok: false; reason: string } {
  if (event.kind !== FLEX_CLAIM_KIND) return { ok: false, reason: 'not a flex claim' }
  const d = tagValue(event, 'd') ?? ''
  if (!d.startsWith(FLEX_CLAIM_D_PREFIX) || !CLAIM_ID.test(d.slice(FLEX_CLAIM_D_PREFIX.length))) return { ok: false, reason: 'bad claim id' }
  if (event.tags.filter((t) => t[0] === 'd').length !== 1) return { ok: false, reason: 'one d tag only' }
  const domain = tryNormaliseDomain(tagValue(event, 'fmd_domain'))
  if (!domain.ok || domain.domain !== tagValue(event, 'fmd_domain')) return { ok: false, reason: 'bad domain' }
  const amountText = tagValue(event, 'fmd_amount') ?? ''
  const amountSats = /^[1-9][0-9]{0,15}$/.test(amountText) ? Number(amountText) : NaN
  if (!Number.isSafeInteger(amountSats)) return { ok: false, reason: 'bad amount' }
  if (!event.tags.some((t) => t[0] === 't' && t[1] === flexAmountTopic(amountSats))) return { ok: false, reason: 'the amount topic is missing' }
  const address = tagValue(event, 'fmd_address') ?? ''
  if (!ADDRESS.test(address)) return { ok: false, reason: 'bad address' }
  if (event.content !== '') return { ok: false, reason: 'a claim has no content' }
  return {
    ok: true,
    claim: { id: d.slice(FLEX_CLAIM_D_PREFIX.length), author: event.pubkey, domain: domain.domain, amountSats, address, at: event.created_at, event },
  }
}

/** Flex claims for these amounts, or every flex claim when none are given. */
export function flexClaimFilter(options: { amounts?: readonly number[]; since?: number } = {}): Record<string, unknown> {
  const topics = options.amounts?.length ? [...new Set(options.amounts)].map(flexAmountTopic) : [FLEX_CLAIM_TOPIC]
  return { kinds: [FLEX_CLAIM_KIND], '#t': topics, limit: 500, ...(options.since ? { since: options.since } : {}) }
}

/**
 * Pairs payments to `address` with claims made in the day before them (with `slackSeconds`
 * for clocks). A claim's amount is a minimum: a payment counts in full for a claim at or below
 * it, and never for one above it. Payments within `amountSlackSats` above a claim are paired
 * first, since those odd sats name the claim; then larger payments take the closest open
 * claim below them. A claim made before the payment beats one made after it, then the closer
 * amount, then the earlier claim. Each claim is used once, and payments nobody claimed don't
 * count.
 */
export function matchFlexPayments(
  claims: readonly FlexClaim[],
  payments: readonly FlexPayment[],
  options: { address: string; now: number; slackSeconds?: number; maxAgeSeconds?: number; amountSlackSats?: number },
): { claim: FlexClaim; payment: FlexPayment }[] {
  const slack = options.slackSeconds ?? 900
  const near = options.amountSlackSats ?? FLEX_AMOUNT_SLACK_SATS
  // a day covers any wallet, and old claims can't sit waiting for every future payment
  const maxAge = options.maxAgeSeconds ?? 86400
  const open = claims
    .filter((c) => c.address === options.address)
    .sort((a, b) => a.at - b.at || (a.event.id < b.event.id ? -1 : 1))
  const seen = new Set<string>()
  const ordered = [...payments]
    .sort((a, b) => (a.at ?? options.now) - (b.at ?? options.now))
    .filter((p) => {
      const key = `${p.txid}:${p.vout}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  const used = new Set<string>()
  const paired = new Map<FlexPayment, FlexClaim>()
  const pick = (payment: FlexPayment, fits: (over: number) => boolean): FlexClaim | undefined => {
    const when = payment.at ?? options.now
    const over = (c: FlexClaim) => payment.valueSats - c.amountSats
    // the slack is for clocks, so a claim made after the payment never beats one made before it
    const better = (c: FlexClaim, than: FlexClaim) =>
      (c.at > when) !== (than.at > when) ? c.at <= when : over(c) < over(than)
    let best: FlexClaim | undefined
    for (const c of open) {
      if (used.has(c.event.id) || over(c) < 0 || !fits(over(c)) || c.at > when + slack || c.at < when - maxAge) continue
      // `open` is oldest first, so a later claim wins a tie only by being closer
      if (!best || better(c, best)) best = c
    }
    return best
  }
  for (const fits of [(over: number) => over <= near, () => true]) {
    for (const payment of ordered) {
      if (paired.has(payment)) continue
      const claim = pick(payment, fits)
      if (!claim) continue
      used.add(claim.event.id)
      paired.set(payment, claim)
    }
  }
  return ordered.flatMap((payment) => {
    const claim = paired.get(payment)
    return claim ? [{ claim, payment }] : []
  })
}

/** A paired payment in the shape the board ranks. The claim stands in for a zap's receipt. */
export function flexPaymentZap(claim: FlexClaim, payment: FlexPayment, now: number): Zap {
  return {
    receipt: claim.event,
    request: claim.event,
    sender: claim.author,
    recipient: '',
    amountSats: payment.valueSats,
    amountMsats: payment.valueSats * MSATS_PER_SAT,
    flexDomain: claim.domain,
    comment: '',
    at: payment.at ?? now,
  }
}
