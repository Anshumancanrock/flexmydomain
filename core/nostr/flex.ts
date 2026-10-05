// On-chain flex payments. A plain Bitcoin payment carries no domain, so the payer first
// signs a claim naming the domain and an exact amount, then pays that amount to the
// site's address. The board pairs each payment with the earliest claim for its amount.
//
// Nothing in the payment points back at its claim, so a copycat who sees a payment can
// sign a backdated claim for the same amount and take the credit. That is fine for test
// coins; real money needs an address per claim, or Lightning zaps with their receipts.

import { isHex32, tagValue, type NostrEvent, type UnsignedEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'

export const FLEX_CLAIM_KIND = 30078
export const FLEX_CLAIM_D_PREFIX = 'fmd:flex:'
export const FLEX_CLAIM_TOPIC = 'fmd-flex'

/** The amount as a topic too, so the board asks only for claims matching what was paid. */
export const flexAmountTopic = (amountSats: number): string => `${FLEX_CLAIM_TOPIC}-${amountSats}`

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
 * Pairs payments to `address` with claims. A payment goes to the earliest unmatched claim for
 * the same address and exact amount made in the day before it (with `slack` seconds for
 * clocks), and each claim is used once. Payments nobody claimed don't count.
 */
export function matchFlexPayments(
  claims: readonly FlexClaim[],
  payments: readonly FlexPayment[],
  options: { address: string; now: number; slackSeconds?: number; maxAgeSeconds?: number },
): { claim: FlexClaim; payment: FlexPayment }[] {
  const slack = options.slackSeconds ?? 900
  // a day covers any wallet, and old claims can't sit waiting for every future payment
  const maxAge = options.maxAgeSeconds ?? 86400
  const open = claims
    .filter((c) => c.address === options.address)
    .sort((a, b) => a.at - b.at || (a.event.id < b.event.id ? -1 : 1))
  const used = new Set<string>()
  const seen = new Set<string>()
  const ordered = [...payments].sort((a, b) => (a.at ?? options.now) - (b.at ?? options.now))
  const out: { claim: FlexClaim; payment: FlexPayment }[] = []
  for (const payment of ordered) {
    const key = `${payment.txid}:${payment.vout}`
    if (seen.has(key)) continue
    seen.add(key)
    const when = payment.at ?? options.now
    const claim = open.find((c) => !used.has(c.event.id) && c.amountSats === payment.valueSats
      && c.at <= when + slack && c.at >= when - maxAge)
    if (!claim) continue
    used.add(claim.event.id)
    out.push({ claim, payment })
  }
  return out
}
