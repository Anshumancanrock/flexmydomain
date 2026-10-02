// NIP-65 relay lists and the outbox model. Pure, net/outbox.ts does the fetching.

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'

/** NIP-65. Replaceable, so one list per key. */
export const RELAY_LIST_KIND = 10002

/** NIP-65 reads an unmarked `r` as both. Both false means nothing. */
export interface RelayEntry {
  url: string
  read: boolean
  write: boolean
}

export function normaliseRelayUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }

  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'wss:' && protocol !== 'ws:') return undefined
  if (url.hostname === '') return undefined

  if ((protocol === 'wss:' && url.port === '443') || (protocol === 'ws:' && url.port === '80')) {
    url.port = ''
  }
  url.hash = ''
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  return `${protocol}//${url.host.toLowerCase()}${path}${url.search}`
}

export function buildRelayList(params: {
  pubkey: string
  relays: readonly RelayEntry[]
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildRelayList: pubkey must be 64 lowercase hex characters')

  const seen = new Set<string>()
  const tags: NostrTag[] = []
  for (const entry of params.relays) {
    const url = normaliseRelayUrl(entry.url)
    if (!url) throw new Error(`buildRelayList: ${JSON.stringify(entry.url)} is not a relay URL`)
    if (seen.has(url)) continue
    seen.add(url)
    if (!entry.read && !entry.write) continue
    if (entry.read && entry.write) tags.push(['r', url])
    else tags.push(['r', url, entry.write ? 'write' : 'read'])
  }

  // NIP-65 asks for a short list. Not capped here, but each relay costs every reader a socket.
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: RELAY_LIST_KIND, tags, content: '' }
}

export function parseRelayList(event: NostrEvent): RelayEntry[] {
  if (event.kind !== RELAY_LIST_KIND) return []
  const byUrl = new Map<string, RelayEntry>()

  for (const tag of event.tags) {
    if (tag[0] !== 'r') continue
    const url = normaliseRelayUrl(tag[1])
    if (!url) continue
    const marker = tag[2]?.toLowerCase()
    const entry: RelayEntry = {
      url,
      read: marker !== 'write',
      write: marker !== 'read',
    }
    const existing = byUrl.get(url)
    byUrl.set(url, existing ? { url, read: existing.read || entry.read, write: existing.write || entry.write } : entry)
  }
  return [...byUrl.values()]
}

export const READ_FANOUT = 4
export const WRITE_FANOUT = 5

/** A user's list replaces the fallback, never gets it appended. */
function preferOwn(own: readonly string[], fallback: readonly string[], max: number): string[] {
  const mine = dedupe(own.map(normaliseRelayUrl).filter(isUrl))
  if (mine.length > 0) return mine.slice(0, max)
  return dedupe(fallback.map(normaliseRelayUrl).filter(isUrl)).slice(0, max)
}

export function writeRelaysFor(list: readonly RelayEntry[], fallback: readonly string[], max = WRITE_FANOUT): string[] {
  return preferOwn(list.filter((r) => r.write).map((r) => r.url), fallback, max)
}

export function readRelaysFor(list: readonly RelayEntry[], fallback: readonly string[], max = READ_FANOUT): string[] {
  return preferOwn(list.filter((r) => r.write).map((r) => r.url), fallback, max)
}

export function inboxRelaysFor(list: readonly RelayEntry[], fallback: readonly string[], max = READ_FANOUT): string[] {
  return preferOwn(list.filter((r) => r.read).map((r) => r.url), fallback, max)
}

export function planAuthorQuery(
  lists: ReadonlyMap<string, readonly RelayEntry[]>,
  authors: readonly string[],
  fallback: readonly string[],
  max = READ_FANOUT,
): Map<string, string[]> {
  const plan = new Map<string, string[]>()
  for (const author of authors) {
    for (const relay of readRelaysFor(lists.get(author) ?? [], fallback, max)) {
      const group = plan.get(relay)
      if (group) group.push(author)
      else plan.set(relay, [author])
    }
  }
  return plan
}

export function relayListFilter(pubkeys: readonly string[]): Record<string, unknown> {
  return { kinds: [RELAY_LIST_KIND], authors: [...pubkeys] }
}

export function isOwnRelayList(event: NostrEvent, pubkey: string): boolean {
  return event.kind === RELAY_LIST_KIND && event.pubkey === pubkey && tagValue(event, 'd') === undefined
}

const isUrl = (u: string | undefined): u is string => typeof u === 'string'

function dedupe(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
