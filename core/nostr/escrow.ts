// Escrow views: NIP-78 kind 30078, `d = "fmd:escrow:<id>"`.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js'
import { buildTree, type NetworkName } from '../escrow/tree.js'
import { settlementProblem, signersOf, type SignedSettlement } from '../escrow/settle.js'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'
import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'

export const ESCROW_KIND = 30078
export const ESCROW_D_PREFIX = 'fmd:escrow:'
export const RULING_D_PREFIX = 'fmd:ruling:'
export const ESCROW_TOPIC = 'flexmydomain'
export const ESCROW_VERSION = 5

/** Two proposals, a co-signature, and room to sign again at another fee. */
const MAX_SIGS = 8
const MAX_CLAIM_TIME = 0xffffffff
const MAX_REASON = 2000

export interface EscrowParams {
  /** 32 random bytes, hex. Keeps the id unguessable and the coordinate unique. */
  salt: string
  buyer: Uint8Array
  seller: Uint8Array
  arbiter: Uint8Array
  /** Relative timelock on the buyer's refund, in blocks after funding. */
  timeoutBlocks: number
  /** Blocks after funding the seller has to transfer the domain to the buyer. */
  deliverBlocks: number
  network: NetworkName
  amountSats: number
  domain: string
  listing?: string
  deadlines?: { fundBy?: number }
}

export interface EscrowClaims {
  sent?: { at: number }
  cancelled?: { at: number; reason: string }
  received?: { at: number }
  disputed?: { at: number; reason: string }
}

export type ViewRole = 'buyer' | 'seller' | 'arbiter'

export interface EscrowView {
  version: number
  id: string
  author: string
  role?: ViewRole
  salt: string
  buyer: string
  seller: string
  arbiter: string
  timeoutTo: 'buyer'
  timeoutBlocks: number
  deliverBlocks: number
  network: NetworkName
  address: string
  amountSats: number
  domain: string
  listing?: string
  deadlines: { fundBy?: number }
  claims: EscrowClaims
  sigs: SignedSettlement[]
  publishedAt: number
  event: NostrEvent
}

export function deriveEscrowId(params: EscrowParams): string {
  if (!/^[0-9a-f]{64}$/.test(params.salt)) throw new Error('deriveEscrowId: salt must be 64 lowercase hex characters')
  const preimage = concatBytes(
    utf8ToBytes('fmd:escrow:v5'),
    hexToBytes(params.salt),
    params.buyer,
    params.seller,
    params.arbiter,
    utf8ToBytes(
      `buyer:${params.timeoutBlocks}:${params.deliverBlocks}:${params.network}:` +
        `${params.amountSats}:${normaliseDomain(params.domain)}:`,
    ),
  )
  // All 32 bytes.
  return bytesToHex(sha256(preimage))
}

export function escrowAddress(params: EscrowParams): string {
  return escrowTree(params).addresses[params.network]
}

export function escrowTree(params: EscrowParams): ReturnType<typeof buildTree> {
  return buildTree({
    buyer: params.buyer,
    seller: params.seller,
    arbiter: params.arbiter,
    timeoutTo: 'buyer',
    timeoutBlocks: params.timeoutBlocks,
    binding: hexToBytes(deriveEscrowId(params)),
  })
}

function roleIn(pubkey: string, keys: { buyer: string; seller: string; arbiter: string }): ViewRole | undefined {
  return pubkey === keys.buyer ? 'buyer' : pubkey === keys.seller ? 'seller' : pubkey === keys.arbiter ? 'arbiter' : undefined
}

function checkProgress(
  role: ViewRole | undefined,
  claims: EscrowClaims,
  sigs: readonly unknown[],
): string | undefined {
  const stated = (Object.keys(claims) as (keyof EscrowClaims)[]).filter((k) => claims[k] !== undefined)
  if (role !== 'buyer' && role !== 'seller') {
    if (stated.length || sigs.length) return 'only the buyer and the seller state progress in a view'
    return undefined
  }
  const allowed: (keyof EscrowClaims)[] = role === 'seller' ? ['sent', 'cancelled', 'disputed'] : ['received', 'disputed']
  const wrong = stated.find((k) => !allowed.includes(k))
  if (wrong) return `the ${role} can't claim "${wrong}"`
  for (const claim of stated.map((k) => claims[k]) as { at?: unknown; reason?: unknown }[]) {
    // Unix seconds a date can show. A larger one would only break whoever displays it.
    if (!Number.isSafeInteger(claim.at) || (claim.at as number) < 0) return 'a claim has no time'
    if ((claim.at as number) > MAX_CLAIM_TIME) return "a claim's time is out of range"
    if ('reason' in claim && (typeof claim.reason !== 'string' || claim.reason.length > MAX_REASON)) {
      return `a reason is text of at most ${MAX_REASON} characters`
    }
  }
  if (sigs.length > MAX_SIGS) return `a view carries at most ${MAX_SIGS} signatures`
  for (const sig of sigs) {
    const problem = settlementProblem(sig)
    if (problem) return `signature: ${problem}`
    if (!signersOf((sig as SignedSettlement).leaf).includes(role)) {
      return `the ${role} can't sign leaf ${(sig as SignedSettlement).leaf}`
    }
  }
  return undefined
}

export function buildEscrowEvent(
  params: EscrowParams & {
    pubkey: string
    createdAt: number
    claims?: EscrowClaims
    sigs?: SignedSettlement[]
  },
): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildEscrowEvent: pubkey must be 64 lowercase hex characters')
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error('buildEscrowEvent: amountSats must be a positive integer')
  }
  if (!Number.isInteger(params.deliverBlocks) || params.deliverBlocks < 1 || params.deliverBlocks > 65535) {
    throw new Error('buildEscrowEvent: deliverBlocks must be 1..65535')
  }
  const domain = normaliseDomain(params.domain)
  const id = deriveEscrowId(params)
  const address = escrowAddress(params)
  const keys = { buyer: bytesToHex(params.buyer), seller: bytesToHex(params.seller), arbiter: bytesToHex(params.arbiter) }
  const role = roleIn(params.pubkey, keys)
  const claims = params.claims ?? {}
  const sigs = params.sigs ?? []
  const problem = checkProgress(role, claims, sigs)
  if (problem) throw new Error(`buildEscrowEvent: ${problem}`)

  const tags: NostrTag[] = [
    ['d', ESCROW_D_PREFIX + id],
    ['t', ESCROW_TOPIC],
    ['fmd_domain', domain],
    ['p', keys.buyer],
    ['p', keys.seller],
    ['p', keys.arbiter],
  ]
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
      buyer_x: keys.buyer,
      seller_x: keys.seller,
      arbiter_x: keys.arbiter,
      timeout_to: 'buyer',
      timeout_blocks: params.timeoutBlocks,
      deliver_blocks: params.deliverBlocks,
      network: params.network,
      address,
      amount_sats: params.amountSats,
      domain,
      ...(params.listing ? { listing: params.listing } : {}),
      ...(params.deadlines?.fundBy !== undefined ? { deadlines: { fund_by: params.deadlines.fundBy } } : {}),
      ...(claims.sent ? { sent: { at: claims.sent.at } } : {}),
      ...(claims.cancelled ? { cancelled: { at: claims.cancelled.at, reason: claims.cancelled.reason } } : {}),
      ...(claims.received ? { received: { at: claims.received.at } } : {}),
      ...(claims.disputed ? { disputed: { at: claims.disputed.at, reason: claims.disputed.reason } } : {}),
      ...(sigs.length ? { sigs: sigs.map(({ kind, leaf, outpoint, dest, fee, sig }) => ({ kind, leaf, outpoint, dest, fee, sig })) } : {}),
    }),
  }
}

/** Parse one view. Refused unless its params produce the stated address and `d` tag. */
export function parseEscrowEvent(event: NostrEvent): { ok: true; view: EscrowView } | { ok: false; reason: string } {
  if (event.kind !== ESCROW_KIND) return { ok: false, reason: `kind ${event.kind} is not ${ESCROW_KIND}` }

  if (event.tags.filter((t) => t[0] === 'd').length !== 1) return { ok: false, reason: 'a view must have exactly one d tag' }
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
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'content is not an object' }
  if (body.v === 1 || body.v === 2 || body.v === 3 || body.v === 4) {
    return {
      ok: false,
      reason: body.v === 4
        ? 'this escrow was opened with the earlier flow, where the arbiter held the domain, and this page no longer runs it'
        : `this view uses the version ${body.v} format, from an earlier version of the escrow; open a new escrow`,
    }
  }
  if (body.v !== ESCROW_VERSION) return { ok: false, reason: `unsupported view version ${JSON.stringify(body.v ?? null)}` }

  const str = (k: string): string | undefined => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
  const num = (k: string): number | undefined =>
    typeof body[k] === 'number' && Number.isSafeInteger(body[k]) ? (body[k] as number) : undefined
  const blocks = (k: string): number | undefined => {
    const n = num(k)
    return n !== undefined && n >= 1 && n <= 65535 ? n : undefined
  }

  const salt = str('salt')
  const buyer = str('buyer_x')
  const seller = str('seller_x')
  const arbiter = str('arbiter_x')
  const timeoutBlocks = blocks('timeout_blocks')
  const deliverBlocks = blocks('deliver_blocks')
  const network = str('network') as NetworkName | undefined
  const address = str('address')
  const amountSats = num('amount_sats')
  const domain = tryNormaliseDomain(body.domain)

  if (!salt || !/^[0-9a-f]{64}$/.test(salt)) return { ok: false, reason: 'no salt' }
  if (!isHex32(buyer) || !isHex32(seller)) return { ok: false, reason: 'buyer or seller key is malformed' }
  if (!isHex32(arbiter)) return { ok: false, reason: 'no arbiter key, and this escrow needs one' }
  if (body.timeout_to !== 'buyer') return { ok: false, reason: 'the timeout must refund the buyer' }
  if (timeoutBlocks === undefined) return { ok: false, reason: 'timeout_blocks is out of range' }
  if (deliverBlocks === undefined) return { ok: false, reason: 'the transfer window is out of range' }
  if (!network || !['mainnet', 'testnet', 'signet', 'regtest'].includes(network)) {
    return { ok: false, reason: `unknown network ${JSON.stringify(network ?? null)}` }
  }
  if (!address) return { ok: false, reason: 'no address' }
  if (amountSats === undefined || amountSats <= 0) return { ok: false, reason: 'no amount' }
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }
  // A field this version doesn't define is refused, not ignored: it would be a term nobody agreed to.
  for (const gone of ['registrar', 'custody_account', 'deliver_to', 'return_to', 'deliver_to_enc', 'return_to_enc', 'forward_blocks']) {
    if (body[gone] !== undefined) return { ok: false, reason: `"${gone}" is not part of a version ${ESCROW_VERSION} escrow` }
  }

  // Explicit type. Some narrowings above don't survive into an inferred literal.
  const params: EscrowParams = {
    salt,
    buyer: hexToBytes(buyer),
    seller: hexToBytes(seller),
    arbiter: hexToBytes(arbiter),
    timeoutBlocks,
    deliverBlocks,
    network,
    amountSats,
    domain: domain.domain,
  }

  const id = deriveEscrowId(params)
  if (d !== ESCROW_D_PREFIX + id) {
    return { ok: false, reason: `the d tag does not match the id these parameters derive (${id})` }
  }

  let derived: string
  try {
    derived = escrowAddress(params)
  } catch (err) {
    return { ok: false, reason: `the parameters do not produce a valid output: ${(err as Error).message}` }
  }
  if (derived !== address) {
    const unbound = buildTree({
      buyer: params.buyer, seller: params.seller, arbiter: params.arbiter, timeoutTo: 'buyer', timeoutBlocks,
    }).addresses[network]
    return {
      ok: false,
      reason: unbound === address
        ? 'this escrow was opened by an older version of the page, before addresses were bound to the escrow id, ' +
          'and this page no longer reads it; do not fund it. If it is funded, the buyer takes the timeout refund with recover.html'
        : `the stated address is not the one these terms produce (derived ${derived}); do not fund it`,
    }
  }

  const role = roleIn(event.pubkey, { buyer, seller, arbiter })
  const claims: EscrowClaims = {}
  for (const name of ['sent', 'cancelled', 'received', 'disputed'] as const) {
    const value = body[name]
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: `${name} is not an object` }
    const { at, reason } = value as { at?: unknown; reason?: unknown }
    claims[name] = (name === 'cancelled' || name === 'disputed' ? { at, reason: reason ?? '' } : { at }) as never
  }
  for (const old of ['pushed', 'dispute']) {
    if (body[old] !== undefined) return { ok: false, reason: `"${old}" is not a claim in this version` }
  }
  const sigs = body.sigs === undefined ? [] : body.sigs
  if (!Array.isArray(sigs)) return { ok: false, reason: 'sigs is not a list' }
  const problem = checkProgress(role, claims, sigs)
  if (problem) return { ok: false, reason: problem }

  const deadlines = (body.deadlines ?? {}) as { fund_by?: unknown }
  const fundBy = Number.isSafeInteger(deadlines.fund_by) ? (deadlines.fund_by as number) : undefined

  return {
    ok: true,
    view: {
      version: ESCROW_VERSION,
      id,
      author: event.pubkey,
      role,
      salt,
      buyer,
      seller,
      arbiter,
      timeoutTo: 'buyer',
      timeoutBlocks,
      deliverBlocks,
      network,
      address,
      amountSats,
      domain: domain.domain,
      listing: str('listing'),
      deadlines: { fundBy },
      claims,
      sigs: (sigs as SignedSettlement[]).map(({ kind, leaf, outpoint, dest, fee, sig }) => ({ kind, leaf, outpoint, dest, fee, sig })),
      publishedAt: event.created_at,
      event,
    },
  }
}

export interface Disagreement {
  field: string
  values: { author: string; value: string }[]
}

export function compareViews(views: readonly EscrowView[], id: string): {
  agreed: boolean
  disagreements: Disagreement[]
  participants: EscrowView[]
  strangers: EscrowView[]
  buyerView?: EscrowView
  sellerView?: EscrowView
} {
  const participants = views.filter((v) => v.id === id && (v.role === 'buyer' || v.role === 'seller'))
  const strangers = views.filter((v) => !participants.includes(v))

  // Newest view per author. A tie keeps the lower event id, as NIP-01 replaces.
  const latest = new Map<string, EscrowView>()
  for (const view of participants) {
    const current = latest.get(view.author)
    if (
      !current ||
      view.publishedAt > current.publishedAt ||
      (view.publishedAt === current.publishedAt && view.event.id < current.event.id)
    ) {
      latest.set(view.author, view)
    }
  }
  const current = [...latest.values()]

  // The id covers every one of these, so views of one id can't differ on them.
  const fields: [string, (v: EscrowView) => string][] = [
    ['address', (v) => v.address],
    ['amount', (v) => String(v.amountSats)],
    ['domain', (v) => v.domain],
    ['buyer key', (v) => v.buyer],
    ['seller key', (v) => v.seller],
    ['arbiter key', (v) => v.arbiter],
    ['timelock', (v) => String(v.timeoutBlocks)],
    ['transfer window', (v) => String(v.deliverBlocks)],
    ['network', (v) => v.network],
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
    buyerView: current.find((v) => v.role === 'buyer'),
    sellerView: current.find((v) => v.role === 'seller'),
  }
}

export interface Ruling {
  id: string
  author: string
  decision: 'release' | 'refund'
  reason: string
  settlement?: SignedSettlement
  txid?: string
  publishedAt: number
  event: NostrEvent
}

export function buildRuling(params: {
  id: string
  decision: 'release' | 'refund'
  reason: string
  settlement?: SignedSettlement
  txid?: string
  parties: readonly string[]
  pubkey: string
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildRuling: pubkey must be 64 lowercase hex characters')
  const problem = rulingProblem(params)
  if (problem) throw new Error(`buildRuling: ${problem}`)
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: ESCROW_KIND,
    tags: [
      ['d', RULING_D_PREFIX + params.id],
      ['t', ESCROW_TOPIC],
      ['fmd_escrow', params.id],
      ...params.parties.filter(isHex32).map((p) => ['p', p]),
    ],
    content: JSON.stringify({
      v: 1,
      escrow: params.id,
      decision: params.decision,
      reason: params.reason,
      ...(params.settlement ? { settlement: params.settlement } : {}),
      ...(params.txid ? { txid: params.txid } : {}),
    }),
  }
}

function rulingProblem(r: { id?: unknown; decision?: unknown; reason?: unknown; settlement?: unknown; txid?: unknown }): string | undefined {
  if (!isHex32(r.id)) return 'the escrow id is malformed'
  if (r.decision !== 'release' && r.decision !== 'refund') return 'the decision is neither release nor refund'
  if (typeof r.reason !== 'string' || r.reason.trim() === '' || r.reason.length > MAX_REASON) {
    return `a ruling gives its reason, in at most ${MAX_REASON} characters`
  }
  if (r.settlement !== undefined) {
    const problem = settlementProblem(r.settlement)
    if (problem) return `settlement: ${problem}`
    const s = r.settlement as SignedSettlement
    const leaf = r.decision === 'release' ? 'B' : 'C'
    if (s.kind !== r.decision || s.leaf !== leaf) return `a ${r.decision} ruling co-signs leaf ${leaf}`
  }
  if (r.txid !== undefined && !isHex32(r.txid)) return 'the txid is malformed'
  return undefined
}

export function parseRuling(event: NostrEvent): { ok: true; ruling: Ruling } | { ok: false; reason: string } {
  if (event.kind !== ESCROW_KIND) return { ok: false, reason: `kind ${event.kind} is not ${ESCROW_KIND}` }
  if (event.tags.filter((t) => t[0] === 'd').length !== 1) return { ok: false, reason: 'a ruling must have exactly one d tag' }
  const d = tagValue(event, 'd')
  if (!d?.startsWith(RULING_D_PREFIX)) return { ok: false, reason: 'not a ruling' }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.content) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'content is not JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'content is not an object' }
  if (body.v !== 1) return { ok: false, reason: `unsupported ruling version ${JSON.stringify(body.v ?? null)}` }
  const ruling = { id: body.escrow, decision: body.decision, reason: body.reason, settlement: body.settlement, txid: body.txid }
  const problem = rulingProblem(ruling)
  if (problem) return { ok: false, reason: problem }
  if (d !== RULING_D_PREFIX + ruling.id) return { ok: false, reason: 'the d tag names another escrow' }
  const s = ruling.settlement as SignedSettlement | undefined
  return {
    ok: true,
    ruling: {
      id: ruling.id as string,
      author: event.pubkey,
      decision: ruling.decision as 'release' | 'refund',
      reason: ruling.reason as string,
      ...(s ? { settlement: { kind: s.kind, leaf: s.leaf, outpoint: s.outpoint, dest: s.dest, fee: s.fee, sig: s.sig } } : {}),
      ...(ruling.txid ? { txid: ruling.txid as string } : {}),
      publishedAt: event.created_at,
      event,
    },
  }
}

export function escrowFilters(id: string, authors: readonly string[] = []): Record<string, unknown>[] {
  const base = {
    kinds: [ESCROW_KIND],
    '#d': [ESCROW_D_PREFIX + id, RULING_D_PREFIX + id],
  }
  const known = authors.filter(isHex32)
  return known.length ? [base, { ...base, authors: [...new Set(known)] }] : [base]
}

export function escrowsForFilter(pubkeys: readonly string[]): Record<string, unknown> {
  return { kinds: [ESCROW_KIND], '#p': [...pubkeys] }
}
