/**
 * NIP-57 zaps: the payments behind the featured board and the flex board.
 *
 * Pure: builds and checks zap events; net/lnurl.ts does the fetching.
 *
 * A seller who wants a featured spot zaps it from whatever wallet they already
 * have, and the site's lightning address receives it, so the site runs no
 * payment infrastructure and holds no customer funds. Each receipt is a public
 * event, so anyone can fetch the receipts, sum the sats and reproduce the
 * ranking.
 *
 * A kind 9735 receipt is written by the recipient's lightning provider, not
 * by the payer. It proves only that this provider says it was paid, and it
 * counts only if the provider's key is the one the recipient published in
 * their LNURL metadata. verifyZapReceipt requires that key.
 */

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { checkEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'

export const ZAP_REQUEST_KIND = 9734
export const ZAP_RECEIPT_KIND = 9735

/** The topic a flex-board zap carries, so it is distinguishable at a glance. */
export const FLEX_TOPIC = 'flexmydomain'

/** Millisats per sat. Zaps are denominated in millisats; the UI shows sats. */
export const MSATS_PER_SAT = 1000

/**
 * Build a kind 9734 zap request.
 *
 * This event is not published to relays. It goes in the `nostr` query
 * parameter of an LNURL-pay callback, and the provider embeds it in the
 * receipt. Publishing it separately achieves nothing and confuses counters.
 */
export function buildZapRequest(params: {
  pubkey: string
  /** Who is being paid. */
  recipient: string
  /** Millisats. Must equal the invoice amount, or the receipt is invalid. */
  amountMsats: number
  relays: readonly string[]
  /** The addressable coordinate being zapped: a listing, for a featured spot. */
  address?: string
  /**
   * A bare domain, for the flex board.
   *
   * The flex board takes any domain from anyone, with no proof, listing or
   * permission: the payment earns the entry, not ownership. With no coordinate
   * for an `a` tag, the domain travels in the zap request, which the receipt
   * embeds, so a reader recovers it from the receipt alone.
   */
  flexDomain?: string
  /** A specific event id, where that is what is being zapped. */
  eventId?: string
  lnurl?: string
  comment?: string
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildZapRequest: pubkey must be 64 lowercase hex characters')
  if (!isHex32(params.recipient)) throw new Error('buildZapRequest: recipient must be 64 lowercase hex characters')
  if (!Number.isSafeInteger(params.amountMsats) || params.amountMsats <= 0) {
    throw new Error(`buildZapRequest: amountMsats must be a positive integer, got ${params.amountMsats}`)
  }
  if (params.relays.length === 0) {
    // The provider publishes the receipt to these. With none, the payment
    // happens and the receipt reaches nobody, so the zap is invisible and the
    // featured spot silently does not appear.
    throw new Error('buildZapRequest: at least one relay is required, or the receipt reaches nobody')
  }

  const tags: NostrTag[] = [
    ['relays', ...params.relays],
    ['amount', String(params.amountMsats)],
    ['p', params.recipient],
  ]
  if (params.lnurl) tags.push(['lnurl', params.lnurl])
  if (params.address) tags.push(['a', params.address])
  if (params.eventId) tags.push(['e', params.eventId])
  if (params.flexDomain) {
    // Normalised here so that `Example.COM` and `example.com` are one entry on
    // the board rather than two rows competing with each other.
    tags.push(['fmd_flex', normaliseDomain(params.flexDomain)])
    tags.push(['t', FLEX_TOPIC])
  }

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: ZAP_REQUEST_KIND,
    tags,
    content: params.comment ?? '',
  }
}

/** What a verified receipt tells you. Amounts in sats, rounded down. */
export interface Zap {
  receipt: NostrEvent
  request: NostrEvent
  /** Who paid, when the request was signed by them. */
  sender: string
  recipient: string
  amountSats: number
  amountMsats: number
  /** The coordinate or event id that was zapped, if any. */
  address?: string
  eventId?: string
  /** The flex-board domain this payment was for, if any. */
  flexDomain?: string
  comment: string
  /** When the receipt was written. */
  at: number
}

/**
 * Verify a zap receipt end to end.
 *
 * Skipping any of these checks lets someone inflate a ranking for free:
 *
 *   1. the receipt's own signature verifies      (or anyone can write one)
 *   2. the embedded request parses and verifies  (or the sender is invented)
 *   3. the request names this recipient          (or a zap to someone else counts here)
 *   4. the invoice amount matches the request    (or claim a million, pay one)
 *   5. the receipt's author is the recipient's
 *      published zapper key, `expectedProvider`  (or it is a stranger's word)
 *
 * Step 5 cannot be done from the event alone: the caller must have fetched the
 * recipient's LNURL-pay metadata. The parameter is required because a receipt
 * that skips this check proves nothing.
 */
export function verifyZapReceipt(params: {
  receipt: NostrEvent
  recipient: string
  /** `nostrPubkey` from the recipient's LNURL-pay metadata. */
  expectedProvider: string
}): { ok: true; zap: Zap } | { ok: false; reason: string } {
  const { receipt } = params
  if (receipt.kind !== ZAP_RECEIPT_KIND) return { ok: false, reason: `kind ${receipt.kind} is not ${ZAP_RECEIPT_KIND}` }

  const checked = checkEvent(receipt)
  if (!checked.ok) return { ok: false, reason: `receipt: ${checked.reason}` }

  if (!isHex32(params.expectedProvider)) {
    return { ok: false, reason: 'no zapper pubkey was supplied for this recipient' }
  }
  if (receipt.pubkey !== params.expectedProvider) {
    return { ok: false, reason: 'the receipt was not written by this recipient’s published zapper key' }
  }

  const description = tagValue(receipt, 'description')
  if (!description) return { ok: false, reason: 'no description tag, so there is no zap request to check' }

  let request: NostrEvent
  try {
    request = JSON.parse(description) as NostrEvent
  } catch (err) {
    return { ok: false, reason: `description is not JSON: ${(err as Error).message}` }
  }
  if (request?.kind !== ZAP_REQUEST_KIND) return { ok: false, reason: 'the description is not a zap request' }

  const requestChecked = checkEvent(request)
  if (!requestChecked.ok) return { ok: false, reason: `zap request: ${requestChecked.reason}` }

  const recipient = tagValue(request, 'p')
  if (recipient !== params.recipient) {
    return { ok: false, reason: 'the zap request names a different recipient' }
  }

  const bolt11 = tagValue(receipt, 'bolt11')
  if (!bolt11) return { ok: false, reason: 'no bolt11 tag' }
  const invoiceMsats = bolt11AmountMsats(bolt11)
  if (invoiceMsats === undefined) return { ok: false, reason: 'the bolt11 invoice carries no amount' }

  const requested = Number(tagValue(request, 'amount') ?? NaN)
  if (Number.isSafeInteger(requested) && requested !== invoiceMsats) {
    // Claim a million, pay one. Without this check the ranking is free.
    return { ok: false, reason: `the invoice is for ${invoiceMsats} msats but the request claimed ${requested}` }
  }

  return {
    ok: true,
    zap: {
      receipt,
      request,
      sender: request.pubkey,
      recipient,
      amountMsats: invoiceMsats,
      amountSats: Math.floor(invoiceMsats / MSATS_PER_SAT),
      address: tagValue(request, 'a') ?? tagValue(receipt, 'a'),
      eventId: tagValue(request, 'e') ?? tagValue(receipt, 'e'),
      // Read from the request, which is signed by the payer. A provider does
      // not copy custom tags onto the receipt, and a tag added to the receipt
      // by anyone else is not something the payer said.
      flexDomain: flexDomainOf(request),
      comment: request.content,
      at: receipt.created_at,
    },
  }
}

/**
 * The amount encoded in a BOLT-11 invoice, in millisats.
 *
 * Only the human-readable part is read (`lnbc`, `lntb`, `lnbcrt`, then an
 * optional amount and multiplier). That is all a zap check needs, and it
 * keeps a full invoice decoder out of core/.
 *
 * The multipliers are fractions of one bitcoin, not multiples of a sat: `m`
 * is 10^-3 BTC, `u` 10^-6, `n` 10^-9, `p` 10^-12. Reading them the other way
 * round is a common bug and lands a thousandfold out.
 *
 * An invoice with no amount ("any amount") returns undefined, so its receipt
 * cannot be counted: nothing says what was paid.
 */
export function bolt11AmountMsats(invoice: string): number | undefined {
  const match = /^ln(bcrt|bc|tb|tbs|sb)(\d+)?([munp])?1/i.exec(invoice.trim().toLowerCase())
  if (!match) return undefined
  const digits = match[2]
  if (!digits) return undefined

  const value = Number(digits)
  if (!Number.isFinite(value)) return undefined

  const MSATS_PER_BTC = 100_000_000_000
  switch (match[3]) {
    case 'm': return Math.round((value * MSATS_PER_BTC) / 1e3)
    case 'u': return Math.round((value * MSATS_PER_BTC) / 1e6)
    case 'n': return Math.round((value * MSATS_PER_BTC) / 1e9)
    case 'p': return Math.round((value * MSATS_PER_BTC) / 1e12)
    case undefined: return value * MSATS_PER_BTC // a bare amount is whole bitcoin
    default: return undefined
  }
}

/** The normalised domain a zap request names, or undefined. */
function flexDomainOf(request: NostrEvent): string | undefined {
  const raw = tagValue(request, 'fmd_flex')
  if (raw === undefined) return undefined
  const domain = tryNormaliseDomain(raw)
  // A tag that does not normalise is dropped rather than shown, because
  // readers could each render it as a different name.
  return domain.ok ? domain.domain : undefined
}

/**
 * Rank domains by sats zapped inside a rolling window: the flex board on the
 * homepage.
 *
 * Anyone may pay to put any domain on the board, so a rank says only who paid
 * most for a name to sit at the top this week. It is not a claim of ownership
 * and must never be rendered as one.
 *
 * Duplicate receipts collapse by receipt id: relays hand back the same receipt
 * from several sources, and counting it twice would double a payment for free.
 */
export function rankFlexDomains(
  zaps: readonly Zap[],
  options: { now: number; windowSeconds?: number },
): { domain: string; sats: number; zaps: number; first: number; last: number; payers: string[] }[] {
  const window = options.windowSeconds ?? 7 * 86400
  const cutoff = options.now - window
  const seen = new Set<string>()
  const totals = new Map<string, { sats: number; zaps: number; first: number; last: number; payers: Set<string> }>()

  for (const zap of zaps) {
    if (!zap.flexDomain) continue
    if (zap.at < cutoff) continue
    if (seen.has(zap.receipt.id)) continue
    seen.add(zap.receipt.id)

    const current = totals.get(zap.flexDomain)
    if (current) {
      current.sats += zap.amountSats
      current.zaps += 1
      current.first = Math.min(current.first, zap.at)
      current.last = Math.max(current.last, zap.at)
      current.payers.add(zap.sender)
    } else {
      totals.set(zap.flexDomain, {
        sats: zap.amountSats,
        zaps: 1,
        first: zap.at,
        last: zap.at,
        payers: new Set([zap.sender]),
      })
    }
  }

  // Rank is the bid, and a tie keeps the earlier payment higher: paying the
  // same amount later should never displace somebody who was there first.
  return [...totals.entries()]
    .map(([domain, t]) => ({ domain, sats: t.sats, zaps: t.zaps, first: t.first, last: t.last, payers: [...t.payers] }))
    .sort((a, b) => b.sats - a.sats || a.first - b.first)
}

/**
 * Every zap receipt for one recipient: the filter the flex board uses.
 *
 * Flex zaps carry no coordinate, so they cannot be filtered by `#a`. They all
 * go to one recipient, though, and a receipt always tags that recipient, so
 * `#p` finds every one of them in a single query.
 */
export function flexZapFilter(recipient: string, since?: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [ZAP_RECEIPT_KIND], '#p': [recipient] }
  if (since !== undefined) filter.since = since
  return filter
}

/**
 * Rank listing addresses by sats zapped inside a rolling window: the featured
 * board.
 *
 * `windowSeconds` defaults to a week. Rank is the bid: the featured board sorts
 * on sats alone, and a tie keeps the earlier zap higher so that paying the same
 * amount later never displaces someone.
 *
 * Duplicate receipts are collapsed by receipt id. Relays return the same
 * receipt from several sources, and counting it twice would double a
 * sponsor's spend for free.
 */
export function rankByZaps(
  zaps: readonly Zap[],
  options: { now: number; windowSeconds?: number } = { now: 0 },
): { address: string; sats: number; zaps: number; first: number }[] {
  const window = options.windowSeconds ?? 7 * 86400
  const cutoff = options.now - window
  const seen = new Set<string>()
  const totals = new Map<string, { sats: number; zaps: number; first: number }>()

  for (const zap of zaps) {
    if (!zap.address) continue
    if (zap.at < cutoff) continue
    if (seen.has(zap.receipt.id)) continue
    seen.add(zap.receipt.id)

    const current = totals.get(zap.address)
    if (current) {
      current.sats += zap.amountSats
      current.zaps += 1
      current.first = Math.min(current.first, zap.at)
    } else {
      totals.set(zap.address, { sats: zap.amountSats, zaps: 1, first: zap.at })
    }
  }

  return [...totals.entries()]
    .map(([address, t]) => ({ address, ...t }))
    .sort((a, b) => b.sats - a.sats || a.first - b.first)
}

/** The filter that fetches receipts for a set of coordinates. */
export function zapReceiptFilter(params: { addresses?: readonly string[]; recipient?: string; since?: number }): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [ZAP_RECEIPT_KIND] }
  if (params.addresses?.length) filter['#a'] = [...params.addresses]
  if (params.recipient) filter['#p'] = [params.recipient]
  if (params.since !== undefined) filter.since = params.since
  return filter
}
