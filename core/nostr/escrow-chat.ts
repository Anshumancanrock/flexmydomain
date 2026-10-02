import { isHex32, type NostrTag } from './event.js'
import { buildRumor, CHAT_KIND, type Rumor } from './nip17.js'

/** Inside the rumor only. Names the escrow the message belongs to. */
export const ESCROW_CHAT_TAG = 'fmd_escrow'

/** Inside the rumor only. A card's fields, as JSON. */
export const CHAT_CARD_TAG = 'fmd_card'

export const MAX_CHAT_LENGTH = 2000

export type ChatRole = 'buyer' | 'seller' | 'arbiter'

/** The escrow id and its three keys, x-only hex, as its views name them. */
export interface EscrowParties {
  id: string
  buyer: string
  seller: string
  arbiter: string
}

export type ChatCard =
  | { kind: 'transfer-to'; registrar: string; account: string; email: string }
  | { kind: 'transfer-sent'; method: 'push' | 'code'; code: string; note: string }

export interface ChatMessage {
  id: string
  from: ChatRole
  to: ChatRole
  author: string
  /** The author's clock. Shown, never trusted. */
  at: number
  text: string
  card?: ChatCard
}

const CARD_LIMITS = { registrar: 100, account: 200, email: 254, code: 500, note: 1000 } as const

const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/

export function chatRoleOf(parties: EscrowParties, pubkey: string): ChatRole | undefined {
  return pubkey === parties.buyer ? 'buyer' : pubkey === parties.seller ? 'seller' : pubkey === parties.arbiter ? 'arbiter' : undefined
}

export function keyOfRole(parties: EscrowParties, role: ChatRole): string {
  return role === 'buyer' ? parties.buyer : role === 'seller' ? parties.seller : parties.arbiter
}

function partiesProblem(p: EscrowParties): string | undefined {
  if (!isHex32(p.id)) return 'the escrow id is malformed'
  for (const key of [p.buyer, p.seller, p.arbiter]) if (!isHex32(key)) return "a party's key is malformed"
  if (new Set([p.buyer, p.seller, p.arbiter]).size !== 3) return 'the three keys must differ'
  return undefined
}

export function chatPartners(role: ChatRole): [ChatRole, ChatRole] {
  return role === 'buyer' ? ['seller', 'arbiter'] : role === 'seller' ? ['buyer', 'arbiter'] : ['buyer', 'seller']
}

/** Why a card can't go from `from` to `to`, or undefined. The same check reads one back. */
export function cardProblem(card: unknown, from: ChatRole, to: ChatRole): string | undefined {
  if (typeof card !== 'object' || card === null || Array.isArray(card)) return 'a card is an object'
  const c = card as Record<string, unknown>
  const text = (k: keyof typeof CARD_LIMITS, required: boolean): string | undefined => {
    const v = c[k]
    if (typeof v !== 'string') return `${k} is text`
    if (required && v.trim() === '') return `${k} is empty`
    if (v.length > CARD_LIMITS[k]) return `${k} is at most ${CARD_LIMITS[k]} characters`
    if (HIDDEN.test(v) || (k !== 'note' && /[\t\n]/.test(v))) return `${k} has hidden characters`
    return undefined
  }
  if (c.kind === 'transfer-to') {
    if (from !== 'buyer' || to !== 'seller') return 'only the buyer tells the seller where to transfer the domain'
    return text('registrar', false) ?? text('account', true) ?? text('email', false)
  }
  if (c.kind === 'transfer-sent') {
    if (from !== 'seller' || to !== 'buyer') return 'only the seller tells the buyer how the domain was sent'
    if (c.method !== 'push' && c.method !== 'code') return 'the method is push or code'
    return text('code', c.method === 'code') ?? text('note', false)
  }
  return 'unknown card'
}

const cardOf = (c: ChatCard): ChatCard => c.kind === 'transfer-to'
  ? { kind: c.kind, registrar: c.registrar.trim(), account: c.account.trim(), email: c.email.trim() }
  : { kind: c.kind, method: c.method, code: c.code.trim(), note: c.note.trim() }

export function buildEscrowMessage(params: {
  parties: EscrowParties
  sender: string
  recipient: string
  content: string
  createdAt: number
  card?: ChatCard
}): Rumor {
  const problem = partiesProblem(params.parties)
  if (problem) throw new Error(`buildEscrowMessage: ${problem}`)
  const from = chatRoleOf(params.parties, params.sender)
  const to = chatRoleOf(params.parties, params.recipient)
  if (!from) throw new Error("buildEscrowMessage: only the escrow's own keys write in its chats")
  if (!to || to === from) throw new Error('buildEscrowMessage: a message goes to one of the other two keys')
  const text = typeof params.content === 'string' ? params.content.trim() : ''
  if (text === '') throw new Error('buildEscrowMessage: the message is empty')
  if (text.length > MAX_CHAT_LENGTH) throw new Error(`buildEscrowMessage: a message is at most ${MAX_CHAT_LENGTH} characters`)
  const tags: NostrTag[] = [[ESCROW_CHAT_TAG, params.parties.id]]
  if (params.card) {
    const bad = cardProblem(params.card, from, to)
    if (bad) throw new Error(`buildEscrowMessage: ${bad}`)
    tags.push([CHAT_CARD_TAG, JSON.stringify(cardOf(params.card))])
  }
  return buildRumor({
    pubkey: params.sender,
    recipient: params.recipient,
    content: text,
    createdAt: params.createdAt,
    subject: `flexmydomain escrow ${params.parties.id.slice(0, 12)}`,
    tags,
  })
}

export function escrowChats(
  found: readonly { rumor: Rumor; sender: string }[],
  parties: EscrowParties,
  reader: string,
): Map<ChatRole, ChatMessage[]> {
  const me = chatRoleOf(parties, reader)
  const chats = new Map<ChatRole, Map<string, ChatMessage>>()
  if (partiesProblem(parties) || !me) return new Map()
  for (const partner of chatPartners(me)) chats.set(partner, new Map())
  for (const { rumor, sender } of found) {
    const from = chatRoleOf(parties, sender)
    if (!from || rumor.pubkey !== sender || rumor.kind !== CHAT_KIND) continue
    if (typeof rumor.content !== 'string' || rumor.content.trim() === '' || rumor.content.length > MAX_CHAT_LENGTH) continue
    if (!Number.isSafeInteger(rumor.created_at) || rumor.created_at < 0) continue
    const named = rumor.tags.filter((t) => t[0] === ESCROW_CHAT_TAG)
    if (named.length !== 1 || named[0][1] !== parties.id) continue
    const ps = rumor.tags.filter((t) => t[0] === 'p')
    if (ps.length !== 1) continue
    const to = chatRoleOf(parties, ps[0][1])
    if (!to || to === from || (from !== me && to !== me)) continue
    const partner = from === me ? to : from
    let card: ChatCard | undefined
    const cards = rumor.tags.filter((t) => t[0] === CHAT_CARD_TAG)
    if (cards.length === 1) {
      try {
        const parsed = JSON.parse(cards[0][1]) as unknown
        if (!cardProblem(parsed, from, to)) card = cardOf(parsed as ChatCard)
      } catch {
      }
    }
    chats.get(partner)!.set(rumor.id, {
      id: rumor.id, from, to, author: sender, at: rumor.created_at, text: rumor.content.trim(), ...(card ? { card } : {}),
    })
  }
  const sorted = new Map<ChatRole, ChatMessage[]>()
  for (const [partner, messages] of chats) {
    sorted.set(partner, [...messages.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)))
  }
  return sorted
}

/** The newest card of one kind in a chat, or undefined. */
export function latestCard<K extends ChatCard['kind']>(messages: readonly ChatMessage[], kind: K): Extract<ChatCard, { kind: K }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const card = messages[i].card
    if (card?.kind === kind) return card as Extract<ChatCard, { kind: K }>
  }
  return undefined
}
