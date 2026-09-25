/**
 * NIP-57 zaps for the featured and flex boards. Pure, net/lnurl.ts does the fetching.
 * The site holds no funds. Receipts are public, so anyone can recompute a ranking.
 * A kind 9735 receipt is only the provider's word. It counts only under the zapper key
 * the recipient published in LNURL metadata.
 */

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { checkEvent } from './event.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'

export const ZAP_REQUEST_KIND = 9734
export const ZAP_RECEIPT_KIND = 9735

/** `t` tag on flex-board zaps. */
export const FLEX_TOPIC = 'flexmydomain'

export const MSATS_PER_SAT = 1000

/**
 * Kind 9734 zap request. Never published to relays. It goes in the LNURL-pay
 * callback's `nostr` param and the provider embeds it in the receipt.
 */
export function buildZapRequest(params: {
  pubkey: string
  recipient: string
  /** Must equal the invoice amount or the receipt is invalid. */
  amountMsats: number
  relays: readonly string[]
  /** Listing coordinate, for a featured spot. */
  address?: string
  /**
   * Bare domain for the flex board. Needs no proof, so an entry never means ownership.
   * No coordinate for an `a` tag, so it rides in the request, which the receipt embeds.
   */
  flexDomain?: string
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
    // The provider publishes the receipt here. With none, the zap is paid but invisible.
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
    // Normalise so `Example.COM` and `example.com` are one board entry.
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

/** A verified zap. amountSats is rounded down. */
export interface Zap {
  receipt: NostrEvent
  request: NostrEvent
  /** The request's signer. */
  sender: string
  recipient: string
  amountSats: number
  amountMsats: number
  address?: string
  eventId?: string
  flexDomain?: string
  comment: string
  /** Receipt created_at. */
  at: number
}

/**
 * Verify a zap receipt. Skip any check and a ranking inflates for free:
 *
 *   1. receipt sig verifies                   (or anyone can write one)
 *   2. embedded request parses and verifies   (or the sender is invented)
 *   3. request names this recipient           (or a zap to someone else counts here)
 *   4. invoice amount matches the request's
 *      `amount` tag, when it has one         (or claim a million, pay one)
 *   5. receipt author is `expectedProvider`,
 *      the recipient's published zapper key   (or it is a stranger's word)
 *
 * Step 5 needs the recipient's LNURL-pay metadata, so the caller must supply it.
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
      // Payer-signed request only. Providers don't copy custom tags, and a
      // receipt tag is not the payer's word.
      flexDomain: flexDomainOf(request),
      comment: request.content,
      at: receipt.created_at,
    },
  }
}

/**
 * BOLT-11 invoice amount in msats. Reads only the human-readable prefix, no full decoder in core/.
 * Multipliers are fractions of 1 BTC (m 10^-3, u 10^-6, n 10^-9, p 10^-12), not sat multiples.
 * Reading them backwards is a common 1000x bug. No amount returns undefined, so it can't count.
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
    case undefined: return value * MSATS_PER_BTC // Bare amount is whole BTC.
    default: return undefined
  }
}

function flexDomainOf(request: NostrEvent): string | undefined {
  const raw = tagValue(request, 'fmd_flex')
  if (raw === undefined) return undefined
  const domain = tryNormaliseDomain(raw)
  // Drop a tag that doesn't normalise. Readers could each render it as a different name.
  return domain.ok ? domain.domain : undefined
}

/**
 * Flex board: sats per domain in a rolling window. A rank only says who paid most.
 * Never render it as ownership.
 * Receipts dedupe by id, since relays return the same one from several sources.
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

  // Ties go to the earlier payment. Matching a bid later never displaces it.
  return [...totals.entries()]
    .map(([domain, t]) => ({ domain, sats: t.sats, zaps: t.zaps, first: t.first, last: t.last, payers: [...t.payers] }))
    .sort((a, b) => b.sats - a.sats || a.first - b.first)
}

/** Flex board receipts. Flex zaps have no `#a` coordinate, but all tag one `#p` recipient. */
export function flexZapFilter(recipient: string, since?: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [ZAP_RECEIPT_KIND], '#p': [recipient] }
  if (since !== undefined) filter.since = since
  return filter
}

/** Featured board: sats per listing address. Same window, tie and dedupe rules as rankFlexDomains. */
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

export function zapReceiptFilter(params: { addresses?: readonly string[]; recipient?: string; since?: number }): Record<string, unknown> {
  const filter: Record<string, unknown> = { kinds: [ZAP_RECEIPT_KIND] }
  if (params.addresses?.length) filter['#a'] = [...params.addresses]
  if (params.recipient) filter['#p'] = [params.recipient]
  if (params.since !== undefined) filter.since = params.since
  return filter
}
