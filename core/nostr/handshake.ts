/**
 * Opening an escrow between two people: the invite and the reply.
 *
 * The escrow address and id depend on both parties' escrow keys, a salt and
 * the terms, so neither side can derive them alone. Two messages carry
 * everything that must match:
 *
 *   invite  initiator -> joiner   salt, terms, the initiator's escrow key
 *   reply   joiner -> initiator   the joiner's escrow key
 *
 * After both, the two sides hold identical inputs and derive the same tree,
 * address and id. The salt must come from the invite: it is part of the id,
 * so if each side minted its own, the two would publish to different
 * coordinates and never see each other's views. The buyer's transfer
 * commitment travels in whichever message the buyer sends, because only the
 * buyer knows where they will receive the domain.
 *
 * Nothing here is secret. Escrow public keys end up in the output script on
 * chain, and the salt and terms are in the published escrow event, so these
 * strings can be pasted in a chat or sent as a link. The private key never
 * leaves the page that generated it and is in neither message.
 */

import { base64urlnopad } from '@scure/base'
import { normaliseDomain, tryNormaliseDomain } from '../oracle/domain.js'
import type { NetworkName, TimeoutTo } from '../escrow/tree.js'

export const INVITE_PREFIX = 'fmdinv1'
export const REPLY_PREFIX = 'fmdrep1'

type Role = 'buyer' | 'seller'

export interface Commitment {
  registrarIanaId?: string
  nameservers: string[]
}

export interface Invite {
  salt: string
  domain: string
  amountSats: number
  network: NetworkName
  timeoutBlocks: number
  timeoutTo: TimeoutTo
  /** x-only hex, or undefined for the two-leaf no-arbiter tree. */
  arbiter?: string
  /** The initiator's side of the trade. The joiner takes the other. */
  initiatorRole: Role
  /** The initiator's escrow public key, x-only hex. */
  initiatorKey: string
  /** Present when the initiator is the buyer. */
  commitment?: Commitment
}

export interface Reply {
  /** The joiner's escrow public key, x-only hex. */
  joinerKey: string
  /** Present when the joiner is the buyer. */
  commitment?: Commitment
  /**
   * The salt of the invite this answers. Echoed so a reply pasted into the
   * wrong escrow is refused rather than silently producing a third address.
   */
  salt: string
}

const HEX32 = /^[0-9a-f]{64}$/
const NETWORKS: readonly NetworkName[] = ['mainnet', 'testnet', 'signet', 'regtest']

function encode(prefix: string, value: unknown): string {
  return prefix + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)))
}

function decode(prefix: string, text: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not a string' }
  const trimmed = text.trim().replace(/\s+/g, '')
  if (!trimmed.startsWith(prefix)) {
    return { ok: false, reason: `this should start with "${prefix}"` }
  }
  try {
    const json = new TextDecoder().decode(base64urlnopad.decode(trimmed.slice(prefix.length)))
    const value = JSON.parse(json)
    if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false, reason: 'it did not decode: a character is missing or wrong' }
  }
}

function readCommitment(raw: unknown): Commitment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as { registrarIanaId?: unknown; nameservers?: unknown }
  const nameservers = Array.isArray(c.nameservers)
    ? c.nameservers.filter((n): n is string => typeof n === 'string').map((n) => n.trim().toLowerCase())
    : []
  const registrarIanaId = typeof c.registrarIanaId === 'string' && c.registrarIanaId.trim() !== ''
    ? c.registrarIanaId.trim()
    : undefined
  if (!registrarIanaId && nameservers.length === 0) return undefined
  return { registrarIanaId, nameservers }
}

/**
 * Build the invite. Everything is validated here, so a bad invite fails on
 * the sender's page rather than the receiver's.
 */
export function encodeInvite(invite: Invite): string {
  if (!HEX32.test(invite.salt)) throw new Error('encodeInvite: salt must be 64 lowercase hex characters')
  if (!HEX32.test(invite.initiatorKey)) throw new Error('encodeInvite: initiatorKey must be x-only hex')
  if (invite.arbiter !== undefined && !HEX32.test(invite.arbiter)) {
    throw new Error('encodeInvite: arbiter must be x-only hex')
  }
  if (!Number.isSafeInteger(invite.amountSats) || invite.amountSats <= 0) {
    throw new Error('encodeInvite: amountSats must be a positive integer')
  }
  if (invite.initiatorRole === 'buyer' && !invite.commitment) {
    // The buyer is the only party who knows where they will receive the
    // domain. An invite from a buyer without it would open an escrow whose
    // release condition can never be shown to have been met.
    throw new Error('encodeInvite: a buyer must commit to where they will receive the domain')
  }
  return encode(INVITE_PREFIX, {
    v: 1,
    salt: invite.salt,
    domain: normaliseDomain(invite.domain),
    amountSats: invite.amountSats,
    network: invite.network,
    timeoutBlocks: invite.timeoutBlocks,
    timeoutTo: invite.timeoutTo,
    ...(invite.arbiter ? { arbiter: invite.arbiter } : {}),
    initiatorRole: invite.initiatorRole,
    initiatorKey: invite.initiatorKey,
    ...(invite.commitment ? { commitment: invite.commitment } : {}),
  })
}

export function decodeInvite(text: unknown): { ok: true; invite: Invite } | { ok: false; reason: string } {
  const parsed = decode(INVITE_PREFIX, text)
  if (!parsed.ok) return parsed
  const v = parsed.value

  if (v.v !== 1) return { ok: false, reason: `unsupported invite version ${String(v.v)}` }
  if (typeof v.salt !== 'string' || !HEX32.test(v.salt)) return { ok: false, reason: 'the invite has no valid salt' }
  if (typeof v.initiatorKey !== 'string' || !HEX32.test(v.initiatorKey)) {
    return { ok: false, reason: "the invite has no valid escrow key" }
  }
  if (v.arbiter !== undefined && (typeof v.arbiter !== 'string' || !HEX32.test(v.arbiter))) {
    return { ok: false, reason: 'the arbiter key is malformed' }
  }
  const domain = tryNormaliseDomain(v.domain)
  if (!domain.ok) return { ok: false, reason: `domain: ${domain.reason}` }
  const amountSats = Number(v.amountSats)
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) return { ok: false, reason: 'the amount is invalid' }
  if (!NETWORKS.includes(v.network as NetworkName)) return { ok: false, reason: 'unknown network' }
  const timeoutBlocks = Number(v.timeoutBlocks)
  if (!Number.isInteger(timeoutBlocks) || timeoutBlocks < 1 || timeoutBlocks > 65535) {
    return { ok: false, reason: 'the timelock is out of range' }
  }
  if (v.timeoutTo !== 'buyer' && v.timeoutTo !== 'seller') return { ok: false, reason: 'no timeout polarity' }
  if (v.initiatorRole !== 'buyer' && v.initiatorRole !== 'seller') return { ok: false, reason: 'no role' }

  const commitment = readCommitment(v.commitment)
  if (v.initiatorRole === 'buyer' && !commitment) {
    return { ok: false, reason: 'the buyer did not say where they will receive the domain' }
  }

  return {
    ok: true,
    invite: {
      salt: v.salt,
      domain: domain.domain,
      amountSats,
      network: v.network as NetworkName,
      timeoutBlocks,
      timeoutTo: v.timeoutTo,
      arbiter: typeof v.arbiter === 'string' ? v.arbiter : undefined,
      initiatorRole: v.initiatorRole,
      initiatorKey: v.initiatorKey,
      commitment,
    },
  }
}

/** Build the reply to an invite. */
export function encodeReply(reply: Reply): string {
  if (!HEX32.test(reply.joinerKey)) throw new Error('encodeReply: joinerKey must be x-only hex')
  if (!HEX32.test(reply.salt)) throw new Error('encodeReply: salt must be 64 lowercase hex characters')
  return encode(REPLY_PREFIX, {
    v: 1,
    salt: reply.salt,
    joinerKey: reply.joinerKey,
    ...(reply.commitment ? { commitment: reply.commitment } : {}),
  })
}

/**
 * Read a reply and check it answers this invite.
 *
 * `invite` is required: a reply means nothing on its own, and the salt check
 * is what stops a reply for one escrow being pasted into another.
 */
export function decodeReply(text: unknown, invite: Invite): { ok: true; reply: Reply } | { ok: false; reason: string } {
  const parsed = decode(REPLY_PREFIX, text)
  if (!parsed.ok) return parsed
  const v = parsed.value

  if (v.v !== 1) return { ok: false, reason: `unsupported reply version ${String(v.v)}` }
  if (typeof v.joinerKey !== 'string' || !HEX32.test(v.joinerKey)) {
    return { ok: false, reason: 'the reply has no valid escrow key' }
  }
  if (v.salt !== invite.salt) {
    return { ok: false, reason: 'this reply answers a different escrow: the salts do not match' }
  }
  if (v.joinerKey === invite.initiatorKey) {
    return { ok: false, reason: 'the reply carries your own key back; ask them to join from the invite' }
  }
  if (invite.arbiter && v.joinerKey === invite.arbiter) {
    return { ok: false, reason: 'the reply carries the arbiter key, and each party needs its own' }
  }

  const commitment = readCommitment(v.commitment)
  const joinerIsBuyer = invite.initiatorRole === 'seller'
  if (joinerIsBuyer && !commitment) {
    return { ok: false, reason: 'the buyer did not say where they will receive the domain' }
  }

  return { ok: true, reply: { joinerKey: v.joinerKey, salt: v.salt as string, commitment } }
}

/**
 * Everything both sides need, in one place, once the handshake is done.
 *
 * Both parties call this with the same invite and reply and get identical
 * inputs, so the tree, the address and the id cannot differ between them.
 */
export function resolveHandshake(invite: Invite, reply: Reply): {
  salt: string
  domain: string
  amountSats: number
  network: NetworkName
  timeoutBlocks: number
  timeoutTo: TimeoutTo
  arbiter?: string
  buyerKey: string
  sellerKey: string
  commitment: Commitment
} {
  const buyerKey = invite.initiatorRole === 'buyer' ? invite.initiatorKey : reply.joinerKey
  const sellerKey = invite.initiatorRole === 'seller' ? invite.initiatorKey : reply.joinerKey
  const commitment = invite.initiatorRole === 'buyer' ? invite.commitment : reply.commitment
  if (!commitment) throw new Error('resolveHandshake: no transfer commitment from the buyer')
  return {
    salt: invite.salt,
    domain: invite.domain,
    amountSats: invite.amountSats,
    network: invite.network,
    timeoutBlocks: invite.timeoutBlocks,
    timeoutTo: invite.timeoutTo,
    arbiter: invite.arbiter,
    buyerKey,
    sellerKey,
    commitment,
  }
}
