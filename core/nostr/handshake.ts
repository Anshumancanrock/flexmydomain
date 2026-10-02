import { base64urlnopad } from '@scure/base'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'
import { rulesProblem, type TradeRules } from '../escrow/trade.js'
import type { NetworkName } from '../escrow/tree.js'
import { checkEvent, isHex32, type NostrEvent, type UnsignedEvent } from './event.js'

/** Ephemeral range, so a relay that gets one by mistake doesn't keep it. */
export const HANDSHAKE_KIND = 20078
export const INVITE_PREFIX = 'fmdinv5'
export const REPLY_PREFIX = 'fmdrep5'

const INVITE_TOPIC = 'fmd-invite'
const REPLY_TOPIC = 'fmd-reply'
const VERSION = 5

type Role = 'buyer' | 'seller'

export interface Invite {
  salt: string
  domain: string
  amountSats: number
  network: NetworkName
  timeoutBlocks: number
  deliverBlocks: number
  /** x-only hex. Every escrow has one: it decides a dispute, and never holds the domain. */
  arbiter: string
  initiatorRole: Role
  /** Escrow pubkey, x-only hex. */
  initiatorKey: string
  to: string
}

export interface Reply {
  /** Escrow pubkey, x-only hex. */
  joinerKey: string
}

export interface SignedInvite {
  invite: Invite
  from: string
  id: string
}

const HEX32 = /^[0-9a-f]{64}$/
const NETWORKS: readonly NetworkName[] = ['mainnet', 'testnet', 'signet', 'regtest']

function encode(prefix: string, topic: string, event: NostrEvent): string {
  if (event.kind !== HANDSHAKE_KIND || !event.tags.some((t) => t[0] === 't' && t[1] === topic)) {
    throw new Error(`encode: that is not a signed ${topic}`)
  }
  return prefix + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(event)))
}

function decode(
  prefix: string,
  topic: string,
  text: unknown,
): { ok: true; event: NostrEvent; body: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not a string' }
  const trimmed = text.trim().replace(/\s+/g, '')
  if (/^fmd(inv|rep)[1234]/.test(trimmed)) {
    return { ok: false, reason: 'this comes from an older version of the escrow; ask for a new invite' }
  }
  if (!trimmed.startsWith(prefix)) {
    return { ok: false, reason: `this should start with "${prefix}"` }
  }

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(trimmed.slice(prefix.length))))
  } catch {
    return { ok: false, reason: 'it did not decode: a character is missing or wrong' }
  }
  const checked = checkEvent(value)
  if (!checked.ok) return { ok: false, reason: `its signature does not check out (${checked.reason})` }
  const event = checked.event
  if (event.kind !== HANDSHAKE_KIND || !event.tags.some((t) => t[0] === 't' && t[1] === topic)) {
    return { ok: false, reason: `this is not an escrow ${topic === INVITE_TOPIC ? 'invite' : 'reply'}` }
  }

  let body: unknown
  try {
    body = JSON.parse(event.content)
  } catch {
    return { ok: false, reason: 'its content is not JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'not an object' }
  return { ok: true, event, body: body as Record<string, unknown> }
}

function inviteProblem(v: Record<string, unknown>, sender: string): string | undefined {
  if (typeof v.salt !== 'string' || !HEX32.test(v.salt)) return 'the invite has no valid salt'
  if (typeof v.initiatorKey !== 'string' || !HEX32.test(v.initiatorKey)) return 'the invite has no valid escrow key'
  if (typeof v.arbiter !== 'string' || !HEX32.test(v.arbiter)) return 'the invite names no valid arbiter key'
  if (v.arbiter === v.initiatorKey) return "the invite's own escrow key is also its arbiter"
  if (typeof v.to !== 'string' || !HEX32.test(v.to)) return 'the invite does not say who it is for'
  if (v.to === sender) return 'the invite is addressed to its own sender'
  const domain = tryNormaliseDomain(v.domain)
  if (!domain.ok) return `domain: ${domain.reason}`
  if (!Number.isSafeInteger(v.amountSats) || (v.amountSats as number) <= 0) return 'the amount is not a positive whole number of sats'
  if (!NETWORKS.includes(v.network as NetworkName)) return 'unknown network'
  const rules = rulesProblem({ timeoutBlocks: v.timeoutBlocks as number, deliverBlocks: v.deliverBlocks as number })
  if (rules) return rules
  if (v.initiatorRole !== 'buyer' && v.initiatorRole !== 'seller') return 'no role'
  return undefined
}

export function buildInvite(invite: Invite, params: { pubkey: string; createdAt: number }): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildInvite: pubkey must be 64 lowercase hex characters')
  const problem = inviteProblem(invite as unknown as Record<string, unknown>, params.pubkey)
  if (problem) throw new Error(`buildInvite: ${problem}`)

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: HANDSHAKE_KIND,
    tags: [
      ['t', INVITE_TOPIC],
      ['p', invite.to],
    ],
    content: JSON.stringify({
      v: VERSION,
      salt: invite.salt,
      domain: normaliseDomain(invite.domain),
      amountSats: invite.amountSats,
      network: invite.network,
      timeoutBlocks: invite.timeoutBlocks,
      deliverBlocks: invite.deliverBlocks,
      arbiter: invite.arbiter,
      initiatorRole: invite.initiatorRole,
      initiatorKey: invite.initiatorKey,
      to: invite.to,
    }),
  }
}

export function encodeInvite(event: NostrEvent): string {
  return encode(INVITE_PREFIX, INVITE_TOPIC, event)
}

export function decodeInvite(text: unknown): ({ ok: true } & SignedInvite) | { ok: false; reason: string } {
  const parsed = decode(INVITE_PREFIX, INVITE_TOPIC, text)
  if (!parsed.ok) return parsed
  const v = parsed.body

  if (v.v !== VERSION) return { ok: false, reason: `unsupported invite version ${String(v.v)}` }
  const problem = inviteProblem(v, parsed.event.pubkey)
  if (problem) return { ok: false, reason: problem }

  return {
    ok: true,
    from: parsed.event.pubkey,
    id: parsed.event.id,
    invite: {
      salt: v.salt as string,
      domain: normaliseDomain(v.domain as string),
      amountSats: v.amountSats as number,
      network: v.network as NetworkName,
      timeoutBlocks: v.timeoutBlocks as number,
      deliverBlocks: v.deliverBlocks as number,
      arbiter: v.arbiter as string,
      initiatorRole: v.initiatorRole as Role,
      initiatorKey: v.initiatorKey as string,
      to: v.to as string,
    },
  }
}

export function buildReply(reply: Reply, params: { pubkey: string; createdAt: number; invite: SignedInvite }): UnsignedEvent {
  const { invite } = params.invite
  if (params.pubkey !== invite.to) throw new Error('buildReply: this invite is for a different key')
  const problem = replyProblem(reply, invite)
  if (problem) throw new Error(`buildReply: ${problem}`)

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: HANDSHAKE_KIND,
    tags: [
      ['t', REPLY_TOPIC],
      ['e', params.invite.id],
      ['p', params.invite.from],
    ],
    content: JSON.stringify({
      v: VERSION,
      invite: params.invite.id,
      joinerKey: reply.joinerKey,
    }),
  }
}

export function encodeReply(event: NostrEvent): string {
  return encode(REPLY_PREFIX, REPLY_TOPIC, event)
}

function replyProblem(reply: Reply, invite: Invite): string | undefined {
  if (typeof reply.joinerKey !== 'string' || !HEX32.test(reply.joinerKey)) return 'the reply has no valid escrow key'
  if (reply.joinerKey === invite.initiatorKey) return 'the reply carries your own key back; ask them to join from the invite'
  if (reply.joinerKey === invite.arbiter) return 'the reply carries the arbiter key, and each party needs its own'
  return undefined
}

/** A reply counts only from the key the invite was addressed to, and only for that exact invite. */
export function decodeReply(text: unknown, signed: SignedInvite): { ok: true; reply: Reply; from: string } | { ok: false; reason: string } {
  const parsed = decode(REPLY_PREFIX, REPLY_TOPIC, text)
  if (!parsed.ok) return parsed
  const v = parsed.body

  if (v.v !== VERSION) return { ok: false, reason: `unsupported reply version ${String(v.v)}` }
  if (v.invite !== signed.id) {
    return { ok: false, reason: 'this reply answers a different invite; send them the current link' }
  }
  if (parsed.event.pubkey !== signed.invite.to) {
    return { ok: false, reason: 'this reply is signed by someone other than the person the invite is for' }
  }

  const reply: Reply = { joinerKey: typeof v.joinerKey === 'string' ? v.joinerKey : '' }
  const problem = replyProblem(reply, signed.invite)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, reply, from: parsed.event.pubkey }
}

export function resolveHandshake(invite: Invite, reply: Reply): {
  salt: string
  domain: string
  amountSats: number
  network: NetworkName
  timeoutBlocks: number
  deliverBlocks: number
  arbiter: string
  buyerKey: string
  sellerKey: string
} {
  const buyerKey = invite.initiatorRole === 'buyer' ? invite.initiatorKey : reply.joinerKey
  const sellerKey = invite.initiatorRole === 'seller' ? invite.initiatorKey : reply.joinerKey
  return {
    salt: invite.salt,
    domain: invite.domain,
    amountSats: invite.amountSats,
    network: invite.network,
    timeoutBlocks: invite.timeoutBlocks,
    deliverBlocks: invite.deliverBlocks,
    arbiter: invite.arbiter,
    buyerKey,
    sellerKey,
  }
}

export function termsProblem(
  terms: { arbiter?: unknown; timeoutBlocks: number; deliverBlocks: number },
  rules: TradeRules,
): string | undefined {
  if (!isHex32(terms.arbiter)) return 'every escrow here has an arbiter, and these terms name none'
  if (terms.timeoutBlocks !== rules.timeoutBlocks) {
    return `the timelock is ${terms.timeoutBlocks} blocks, and this site uses ${rules.timeoutBlocks}`
  }
  if (terms.deliverBlocks !== rules.deliverBlocks) {
    return `the transfer window is ${terms.deliverBlocks} blocks, and this site uses ${rules.deliverBlocks}`
  }
  return undefined
}
