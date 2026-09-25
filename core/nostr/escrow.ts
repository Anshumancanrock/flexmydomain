/**
 * Escrow views: NIP-78 kind 30078, `d = "fmd:escrow:<id>"`. Each party signs its own view
 * with its key from the tree. None is authoritative, and disagreements stay public.
 * parseEscrowEvent re-derives the taproot address from the view's params and refuses a
 * mismatch. That stops a plausible escrow that pays an address only its author controls.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js'
import { buildTree, type NetworkName, type TimeoutTo } from '../escrow/tree.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'
import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'

export const ESCROW_KIND = 30078
export const ESCROW_D_PREFIX = 'fmd:escrow:'
export const ESCROW_TOPIC = 'flexmydomain'
export const ESCROW_VERSION = 1

/** Derived, never asserted by one party alone. */
export type EscrowState =
  | 'open'        // Published, not yet funded.
  | 'funded'      // A confirmed output pays the address.
  | 'transferring'// The registry shows a transfer underway.
  | 'settled'     // The output has been spent.
  | 'expired'     // Never funded, past its deadline.

export interface EscrowParams {
  /** 32 random bytes, hex. Keeps the id unguessable and the coordinate unique. */
  salt: string
  buyer: Uint8Array
  seller: Uint8Array
  arbiter?: Uint8Array
  timeoutTo: TimeoutTo
  timeoutBlocks: number
  network: NetworkName
  amountSats: number
  domain: string
  /** naddr of the listing, if the trade has one. */
  listing?: string
  /** Where the buyer commits to receiving the domain. */
  commitment?: { registrarIanaId?: string; nameservers?: string[] }
  deadlines?: { fundBy?: number; transferBy?: number; respondBy?: number }
}

export interface EscrowView {
  version: number
  id: string
  author: string
  salt: string
  buyer: string
  seller: string
  arbiter?: string
  timeoutTo: TimeoutTo
  timeoutBlocks: number
  network: NetworkName
  /** As stated, and already checked against the params by parseEscrowEvent. */
  address: string
  amountSats: number
  domain: string
  listing?: string
  funding?: { txid: string; vout: number; amountSats: number }
  commitment?: { registrarIanaId?: string; nameservers: string[] }
  deadlines: { fundBy?: number; transferBy?: number; respondBy?: number }
  rdapSnapshots: string[]
  settlementTxid?: string
  publishedAt: number
  event: NostrEvent
}

/**
 * sha256 over the output-defining params. Derived, not random, so every party lands on
 * the same `fmd:escrow:<id>` with no id message to tamper with.
 * The salt keeps otherwise identical escrows apart.
 */
export function deriveEscrowId(params: EscrowParams): string {
  const preimage = concatBytes(
    utf8ToBytes('fmd:escrow:v1'),
    hexToBytes(params.salt),
    params.buyer,
    params.seller,
    params.arbiter ?? new Uint8Array(32),
    utf8ToBytes(
      `${params.timeoutTo}:${params.timeoutBlocks}:${params.network}:${params.amountSats}:${normaliseDomain(params.domain)}`,
    ),
  )
  // 16 bytes is enough. The id only names a coordinate. The address is the commitment.
  return bytesToHex(sha256(preimage)).slice(0, 32)
}

/** Taproot address these params produce. */
export function escrowAddress(params: Pick<EscrowParams, 'buyer' | 'seller' | 'arbiter' | 'timeoutTo' | 'timeoutBlocks' | 'network'>): string {
  const tree = buildTree({
    buyer: params.buyer,
    seller: params.seller,
    arbiter: params.arbiter,
    timeoutTo: params.timeoutTo,
    timeoutBlocks: params.timeoutBlocks,
  })
  return tree.addresses[params.network]
}

/** One party's view, for that party to sign. */
export function buildEscrowEvent(params: EscrowParams & { pubkey: string; createdAt: number; funding?: { txid: string; vout: number; amountSats: number }; settlementTxid?: string; rdapSnapshots?: string[] }): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildEscrowEvent: pubkey must be 64 lowercase hex characters')
  if (!/^[0-9a-f]{64}$/.test(params.salt)) throw new Error('buildEscrowEvent: salt must be 64 lowercase hex characters')
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error('buildEscrowEvent: amountSats must be a positive integer')
  }
  const domain = normaliseDomain(params.domain)
  const id = deriveEscrowId(params)
  const address = escrowAddress(params)

  const tags: NostrTag[] = [
    ['d', ESCROW_D_PREFIX + id],
    ['t', ESCROW_TOPIC],
    ['fmd_domain', domain],
    // p-tag every party so one `#p` filter finds all views.
    ['p', bytesToHex(params.buyer)],
    ['p', bytesToHex(params.seller)],
  ]
  if (params.arbiter) tags.push(['p', bytesToHex(params.arbiter)])
  if (params.listing) tags.push(['a', params.listing])

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: ESCROW_KIND,
    tags,
    content: JSON.stringify({
      v: ESCROW_VERSION,
      id,
      salt: params.salt,
      buyer_x: bytesToHex(params.buyer),
      seller_x: bytesToHex(params.seller),
      arbiter_x: params.arbiter ? bytesToHex(params.arbiter) : null,
      timeout_to: params.timeoutTo,
      timeout_blocks: params.timeoutBlocks,
      network: params.network,
      address,
      amount_sats: params.amountSats,
      domain,
      ...(params.listing ? { listing: params.listing } : {}),
      ...(params.funding ? { funding: params.funding } : {}),
      ...(params.commitment ? { commitment: params.commitment } : {}),
      ...(params.deadlines ? { deadlines: params.deadlines } : {}),
      ...(params.rdapSnapshots?.length ? { rdap_snapshots: params.rdapSnapshots } : {}),
      ...(params.settlementTxid ? { settlement_txid: params.settlementTxid } : {}),
    }),
  }
}

/** Parse one view. Refused unless its params produce the stated address and `d` tag. */
export function parseEscrowEvent(event: NostrEvent): { ok: true; view: EscrowView } | { ok: false; reason: string } {
  if (event.kind !== ESCROW_KIND) return { ok: false, reason: `kind ${event.kind} is not ${ESCROW_KIND}` }

  const d = tagValue(event, 'd')
  if (!d || !d.startsWith(ESCROW_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${ESCROW_D_PREFIX}* identifier` }
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.content) as Record<string, unknown>
  } catch (err) {
    return { ok: false, reason: `content is not JSON: ${(err as Error).message}` }
  }

  const str = (k: string): string | undefined => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
  const num = (k: string): number | undefined =>
    typeof body[k] === 'number' && Number.isSafeInteger(body[k]) ? (body[k] as number) : undefined

  const salt = str('salt')
  const buyer = str('buyer_x')
  const seller = str('seller_x')
  const arbiter = str('arbiter_x') ?? undefined
  const timeoutTo = body.timeout_to === 'seller' ? 'seller' : body.timeout_to === 'buyer' ? 'buyer' : undefined
  const timeoutBlocks = num('timeout_blocks')
  const network = str('network') as NetworkName | undefined
  const address = str('address')
  const amountSats = num('amount_sats')
  const domain = tryNormaliseDomain(body.domain)

  if (!salt || !/^[0-9a-f]{64}$/.test(salt)) return { ok: false, reason: 'no salt' }
  if (!isHex32(buyer) || !isHex32(seller)) return { ok: false, reason: 'buyer or seller key is malformed' }
  if (arbiter !== undefined && !isHex32(arbiter)) return { ok: false, reason: 'arbiter key is malformed' }
  if (!timeoutTo) return { ok: false, reason: 'no timeout polarity' }
  if (timeoutBlocks === undefined || timeoutBlocks < 1 || timeoutBlocks > 65535) {
    return { ok: false, reason: 'timeout_blocks is out of range' }
  }
  if (!network || !['mainnet', 'testnet', 'signet', 'regtest'].includes(network)) {
    return { ok: false, reason: `unknown network ${JSON.stringify(network ?? null)}` }
  }
  if (!address) return { ok: false, reason: 'no address' }
  if (amountSats === undefined || amountSats <= 0) return { ok: false, reason: 'no amount' }
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }

  // Explicit type. Some narrowings above don't survive into an inferred literal.
  const params: EscrowParams = {
    salt,
    buyer: hexToBytes(buyer),
    seller: hexToBytes(seller),
    ...(arbiter ? { arbiter: hexToBytes(arbiter) } : {}),
    timeoutTo,
    timeoutBlocks,
    network,
    amountSats,
    domain: domain.domain,
  }

  let derived: string
  try {
    derived = escrowAddress(params)
  } catch (err) {
    return { ok: false, reason: `the parameters do not produce a valid output: ${(err as Error).message}` }
  }
  if (derived !== address) {
    return {
      ok: false,
      reason: `the stated address is not the one these keys produce (derived ${derived}); do not fund it`,
    }
  }

  const id = deriveEscrowId(params)
  if (d !== ESCROW_D_PREFIX + id) {
    return { ok: false, reason: `the d tag does not match the id these parameters derive (${id})` }
  }

  const funding = body.funding as { txid?: string; vout?: number; amount_sats?: number; amountSats?: number } | undefined
  const commitment = body.commitment as { registrarIanaId?: string; registrar_iana_id?: string; nameservers?: string[] } | undefined
  const deadlines = (body.deadlines ?? {}) as { fundBy?: number; fund_by?: number; transferBy?: number; transfer_by?: number; respondBy?: number; respond_by?: number }

  return {
    ok: true,
    view: {
      version: typeof body.v === 'number' ? body.v : 0,
      id,
      author: event.pubkey,
      salt,
      buyer,
      seller,
      arbiter,
      timeoutTo,
      timeoutBlocks,
      network,
      address,
      amountSats,
      domain: domain.domain,
      listing: str('listing'),
      funding:
        funding && typeof funding.txid === 'string' && /^[0-9a-f]{64}$/.test(funding.txid)
          ? {
              txid: funding.txid,
              vout: Number(funding.vout ?? 0),
              amountSats: Number(funding.amount_sats ?? funding.amountSats ?? 0),
            }
          : undefined,
      commitment: commitment
        ? {
            registrarIanaId: commitment.registrarIanaId ?? commitment.registrar_iana_id,
            nameservers: Array.isArray(commitment.nameservers) ? commitment.nameservers : [],
          }
        : undefined,
      deadlines: {
        fundBy: deadlines.fundBy ?? deadlines.fund_by,
        transferBy: deadlines.transferBy ?? deadlines.transfer_by,
        respondBy: deadlines.respondBy ?? deadlines.respond_by,
      },
      rdapSnapshots: Array.isArray(body.rdap_snapshots)
        ? (body.rdap_snapshots as unknown[]).filter((h): h is string => typeof h === 'string')
        : [],
      settlementTxid: str('settlement_txid'),
      publishedAt: event.created_at,
      event,
    },
  }
}

export interface Disagreement {
  field: string
  values: { author: string; value: string }[]
}

/**
 * Compare views of one escrow. Disagreements are returned, not resolved.
 * Only participants' views count, since anyone can publish with this `d` tag.
 * Strangers' views come back separately for the UI to flag.
 */
export function compareViews(views: readonly EscrowView[]): {
  agreed: boolean
  disagreements: Disagreement[]
  participants: EscrowView[]
  strangers: EscrowView[]
  newest?: EscrowView
} {
  if (views.length === 0) return { agreed: true, disagreements: [], participants: [], strangers: [] }

  const first = views[0]
  const members = new Set([first.buyer, first.seller, ...(first.arbiter ? [first.arbiter] : [])])
  const participants = views.filter((v) => members.has(v.author))
  const strangers = views.filter((v) => !members.has(v.author))

  // Newest view per author.
  const latest = new Map<string, EscrowView>()
  for (const view of participants) {
    const current = latest.get(view.author)
    if (!current || view.publishedAt > current.publishedAt) latest.set(view.author, view)
  }
  const current = [...latest.values()]

  const fields: [string, (v: EscrowView) => string][] = [
    ['address', (v) => v.address],
    ['amount', (v) => String(v.amountSats)],
    ['domain', (v) => v.domain],
    ['buyer key', (v) => v.buyer],
    ['seller key', (v) => v.seller],
    ['arbiter key', (v) => v.arbiter ?? 'none'],
    ['timeout polarity', (v) => v.timeoutTo],
    ['timelock', (v) => String(v.timeoutBlocks)],
    ['network', (v) => v.network],
    ['funding outpoint', (v) => (v.funding ? `${v.funding.txid}:${v.funding.vout}` : 'none')],
    ['settlement txid', (v) => v.settlementTxid ?? 'none'],
  ]

  const disagreements: Disagreement[] = []
  for (const [field, read] of fields) {
    const seen = new Map<string, string[]>()
    for (const view of current) {
      const value = read(view)
      const authors = seen.get(value)
      if (authors) authors.push(view.author)
      else seen.set(value, [view.author])
    }
    if (seen.size > 1) {
      disagreements.push({
        field,
        values: [...seen.entries()].flatMap(([value, authors]) => authors.map((author) => ({ author, value }))),
      })
    }
  }

  return {
    agreed: disagreements.length === 0,
    disagreements,
    participants: current,
    strangers,
    newest: current.sort((a, b) => b.publishedAt - a.publishedAt)[0],
  }
}

/** A view's `settlement_txid` is only a claim. Only a spend seen on chain means `settled`. */
export function deriveEscrowState(params: {
  view: EscrowView
  /** Chain: a confirmed output pays the address. */
  funded?: boolean
  /** Chain: that output is spent. */
  spent?: boolean
  /** From RDAP, via core/escrow/transfer.ts. */
  transferPending?: boolean
  now?: number
}): { state: EscrowState; reason: string } {
  if (params.spent) {
    return { state: 'settled', reason: 'the escrow output has been spent, so the trade is over one way or another' }
  }
  if (params.funded) {
    if (params.transferPending) {
      return { state: 'transferring', reason: 'the registry shows a transfer underway on this domain' }
    }
    return { state: 'funded', reason: 'a confirmed payment is sitting in the escrow output' }
  }

  const fundBy = params.view.deadlines.fundBy
  if (fundBy !== undefined && params.now !== undefined && params.now > fundBy) {
    return { state: 'expired', reason: 'the funding deadline passed and nothing was paid' }
  }
  return { state: 'open', reason: 'published, and waiting to be funded' }
}

export function escrowFilter(id: string): Record<string, unknown> {
  return { kinds: [ESCROW_KIND], '#d': [ESCROW_D_PREFIX + id] }
}

/** Every escrow these keys are party to. */
export function escrowsForFilter(pubkeys: readonly string[]): Record<string, unknown> {
  return { kinds: [ESCROW_KIND], '#p': [...pubkeys] }
}
