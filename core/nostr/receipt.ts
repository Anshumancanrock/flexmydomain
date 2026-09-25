/**
 * Trade receipts: NIP-32 labels, kind 1985. On settlement each party labels the other.
 * Two keys of one person can fake volume for mining fees. A registry transfer can't be
 * faked cheaply, so countsTowardReputation requires one. No score is published.
 */

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'

/** Regular, not replaceable, so nobody can quietly delete a receipt written about them. */
export const RECEIPT_KIND = 1985

/** NIP-32 `L` namespace. */
export const RECEIPT_NAMESPACE = 'fmd.trade'

export type TradeRole = 'buyer' | 'seller'
export type TradeOutcome = 'settled' | 'refunded' | 'disputed'

export interface ReceiptParams {
  pubkey: string
  role: TradeRole
  counterparty: string
  outcome: TradeOutcome
  domain: string
  /** Coordinate `30402:<seller>:fmd:listing:<domain>`. */
  listing?: string
  escrowId: string
  /** `<txid>:<vout>` of the escrow funding output. */
  funding: string
  /** Txid that spent the funding output. */
  settlement: string
  amountSats: number
  /** sha256 of the RDAP snapshot showing the transfer. */
  transferSnapshot?: string
  createdAt: number
  comment?: string
}

export interface Receipt {
  event: NostrEvent
  author: string
  role: TradeRole
  counterparty: string
  outcome: TradeOutcome
  domain: string
  listing?: string
  escrowId: string
  funding: string
  settlement: string
  amountSats: number
  transferSnapshot?: string
  at: number
  comment: string
}

const TXID_RE = /^[0-9a-f]{64}$/
const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/

export function buildReceipt(params: ReceiptParams): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildReceipt: pubkey must be 64 lowercase hex characters')
  if (!isHex32(params.counterparty)) throw new Error('buildReceipt: counterparty must be 64 lowercase hex characters')
  if (params.pubkey === params.counterparty) {
    // A receipt about yourself is only a claim.
    throw new Error('buildReceipt: a receipt is written about the counterparty, never about yourself')
  }
  if (!OUTPOINT_RE.test(params.funding)) throw new Error('buildReceipt: funding must be <txid>:<vout>')
  if (!TXID_RE.test(params.settlement)) throw new Error('buildReceipt: settlement must be a 64-character txid')
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error('buildReceipt: amountSats must be a positive integer')
  }
  const domain = normaliseDomain(params.domain)

  const tags: NostrTag[] = [
    ['L', RECEIPT_NAMESPACE],
    ['l', params.outcome, RECEIPT_NAMESPACE],
    ['p', params.counterparty],
    ['fmd_escrow', params.escrowId],
    ['fmd_funding', params.funding],
    ['fmd_settle', params.settlement],
    ['fmd_amount', String(params.amountSats)],
    ['fmd_domain', domain],
    ['fmd_role', params.role],
  ]
  if (params.listing) tags.splice(3, 0, ['a', params.listing])
  if (params.transferSnapshot) tags.push(['fmd_transfer', params.transferSnapshot])

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: RECEIPT_KIND,
    tags,
    content: params.comment ?? '',
  }
}

/** Structure only. Chain and registry checks happen elsewhere. */
export function parseReceipt(event: NostrEvent): { ok: true; receipt: Receipt } | { ok: false; reason: string } {
  if (event.kind !== RECEIPT_KIND) return { ok: false, reason: `kind ${event.kind} is not ${RECEIPT_KIND}` }
  if (tagValue(event, 'L') !== RECEIPT_NAMESPACE) {
    return { ok: false, reason: 'not an fmd.trade label' }
  }

  const label = event.tags.find((t) => t[0] === 'l' && t[2] === RECEIPT_NAMESPACE)
  const outcome = label?.[1]
  if (outcome !== 'settled' && outcome !== 'refunded' && outcome !== 'disputed') {
    return { ok: false, reason: `unknown outcome ${JSON.stringify(outcome ?? null)}` }
  }

  const counterparty = tagValue(event, 'p')
  if (!isHex32(counterparty)) return { ok: false, reason: 'no counterparty' }
  if (counterparty === event.pubkey) return { ok: false, reason: 'a receipt about its own author is not evidence' }

  const role = tagValue(event, 'fmd_role')
  if (role !== 'buyer' && role !== 'seller') return { ok: false, reason: 'no role' }

  const domain = tryNormaliseDomain(tagValue(event, 'fmd_domain'))
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }

  const funding = tagValue(event, 'fmd_funding')
  const settlement = tagValue(event, 'fmd_settle')
  if (!funding || !OUTPOINT_RE.test(funding)) return { ok: false, reason: 'no funding outpoint' }
  if (!settlement || !TXID_RE.test(settlement)) return { ok: false, reason: 'no settlement txid' }

  const amountSats = Number(tagValue(event, 'fmd_amount') ?? NaN)
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) return { ok: false, reason: 'no amount' }

  const escrowId = tagValue(event, 'fmd_escrow')
  if (!escrowId) return { ok: false, reason: 'no escrow id' }

  return {
    ok: true,
    receipt: {
      event,
      author: event.pubkey,
      role,
      counterparty,
      outcome,
      domain: domain.domain,
      listing: tagValue(event, 'a'),
      escrowId,
      funding,
      settlement,
      amountSats,
      transferSnapshot: tagValue(event, 'fmd_transfer'),
      at: event.created_at,
      comment: event.content,
    },
  }
}

export interface Trade {
  escrowId: string
  domain: string
  amountSats: number
  settlement: string
  funding: string
  buyer?: string
  seller?: string
  /** Both receipts present and agreeing. */
  mutual: boolean
  conflicts: string[]
  hasTransfer: boolean
  at: number
  receipts: Receipt[]
}

/**
 * Anyone can label anyone, so only a pair where each side names the other is evidence.
 * Disagreements are recorded, not resolved.
 */
export function pairReceipts(receipts: readonly Receipt[]): Trade[] {
  const byEscrow = new Map<string, Receipt[]>()
  for (const receipt of receipts) {
    const group = byEscrow.get(receipt.escrowId)
    if (group) group.push(receipt)
    else byEscrow.set(receipt.escrowId, [receipt])
  }

  const trades: Trade[] = []
  for (const [escrowId, group] of byEscrow) {
    // Newest receipt per author wins. Older ones stay on relays since kind 1985 is regular.
    const latest = new Map<string, Receipt>()
    for (const receipt of group) {
      const current = latest.get(receipt.author)
      if (!current || receipt.at > current.at) latest.set(receipt.author, receipt)
    }
    const members = [...latest.values()]

    const buyerSide = members.find((r) => r.role === 'buyer')
    const sellerSide = members.find((r) => r.role === 'seller')
    const conflicts: string[] = []

    if (buyerSide && sellerSide) {
      // Each must name the other, or they're unrelated claims sharing an escrow id.
      if (buyerSide.counterparty !== sellerSide.author) conflicts.push('the buyer names a different seller')
      if (sellerSide.counterparty !== buyerSide.author) conflicts.push('the seller names a different buyer')
      if (buyerSide.settlement !== sellerSide.settlement) conflicts.push('the two receipts name different settlement transactions')
      if (buyerSide.funding !== sellerSide.funding) conflicts.push('the two receipts name different funding outpoints')
      if (buyerSide.amountSats !== sellerSide.amountSats) conflicts.push('the two receipts disagree about the amount')
      if (buyerSide.domain !== sellerSide.domain) conflicts.push('the two receipts name different domains')
      if (buyerSide.outcome !== sellerSide.outcome) conflicts.push('the two receipts disagree about the outcome')
    }

    const primary = buyerSide ?? sellerSide ?? members[0]
    trades.push({
      escrowId,
      domain: primary.domain,
      amountSats: primary.amountSats,
      settlement: primary.settlement,
      funding: primary.funding,
      buyer: buyerSide?.author ?? sellerSide?.counterparty,
      seller: sellerSide?.author ?? buyerSide?.counterparty,
      mutual: Boolean(buyerSide && sellerSide) && conflicts.length === 0,
      conflicts,
      hasTransfer: members.some((r) => Boolean(r.transferSnapshot)),
      at: Math.max(...members.map((r) => r.at)),
      receipts: members,
    })
  }

  return trades.sort((a, b) => b.at - a.at)
}

/**
 * Mutual, settled and backed by an observed registry transfer. Wash volume costs about
 * 2,000 sats in fees. A transfer costs about $10 and locks the name 60 days.
 * Failing trades still show at zero weight, so wash trading stays visible.
 */
export function countsTowardReputation(trade: Trade): boolean {
  return trade.mutual && trade.receipts[0]?.outcome === 'settled' && trade.hasTransfer
}

/** Counts only, never a rating or an average. */
export interface TradeRecord {
  verified: number
  counterparties: number
  satsSettled: number
  firstTradeAt?: number
  /** Shown at zero weight, failing countsTowardReputation. */
  unweighted: number
  /** Receipts disagree. Show them anyway. */
  conflicted: number
}

/**
 * Counts distinct counterparties too, since ten trades with one partner is one relationship.
 * Partners come back so a profile can show the graph instead of a score.
 */
export function summariseTrades(trades: readonly Trade[], pubkey: string): TradeRecord & { partners: string[] } {
  const partners = new Set<string>()
  let verified = 0
  let satsSettled = 0
  let unweighted = 0
  let conflicted = 0
  let firstTradeAt: number | undefined

  for (const trade of trades) {
    const involved = trade.buyer === pubkey || trade.seller === pubkey
    if (!involved) continue
    if (trade.conflicts.length > 0) {
      conflicted += 1
      continue
    }
    if (!countsTowardReputation(trade)) {
      unweighted += 1
      continue
    }
    verified += 1
    satsSettled += trade.amountSats
    const other = trade.buyer === pubkey ? trade.seller : trade.buyer
    if (other) partners.add(other)
    firstTradeAt = firstTradeAt === undefined ? trade.at : Math.min(firstTradeAt, trade.at)
  }

  return {
    verified,
    counterparties: partners.size,
    satsSettled,
    firstTradeAt,
    unweighted,
    conflicted,
    partners: [...partners],
  }
}

export function receiptFilter(pubkeys: readonly string[]): Record<string, unknown>[] {
  return [
    { kinds: [RECEIPT_KIND], authors: [...pubkeys] },
    { kinds: [RECEIPT_KIND], '#p': [...pubkeys] },
  ]
}
