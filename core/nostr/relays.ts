/**
 * NIP-65 relay lists and the outbox model.
 *
 * Pure: no sockets. net/outbox.ts does the fetching.
 *
 * Without NIP-65 the site would decide where every user's listings live: a
 * seller's inventory would be reachable only through relays the site picked,
 * and if those relays dropped it the market would go dark for everyone. With
 * it, a seller says where their events go and readers follow them there.
 *
 * The outbox rule:
 *
 *   publishing mine   -> my write relays
 *   reading theirs    -> their write relays   (not mine, not the defaults)
 *   mentioning them   -> their read relays
 *
 * The third is how a reply reaches someone.
 */

import { isHex32, tagValue, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'

/** NIP-65. Replaceable, so one list per key and it updates in place. */
export const RELAY_LIST_KIND = 10002

/** One entry. Both false means nothing; NIP-65 reads an unmarked `r` as both. */
export interface RelayEntry {
  url: string
  read: boolean
  write: boolean
}

/**
 * Canonical form for a relay URL.
 *
 * Relay URLs are compared constantly: deduplicating a pool, matching a hint
 * against a list, counting how many relays accepted an event.
 * `wss://Relay.Example/` and `wss://relay.example` are one relay, and treating
 * them as two opens twice the sockets and miscounts acceptances.
 *
 * Normalising lowercases the scheme and host, and drops a default port, a
 * trailing slash and any fragment. The path is kept with its case: some
 * relays route on it, and lowercasing it would point at a different endpoint.
 */
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

/** Build a kind 10002 event. An entry that is both read and write emits no marker. */
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
    if (!entry.read && !entry.write) continue // an entry that is neither says nothing
    if (entry.read && entry.write) tags.push(['r', url])
    else tags.push(['r', url, entry.write ? 'write' : 'read'])
  }

  // NIP-65 asks for a short list. Its length is not capped here, but a key
  // that writes to thirty relays makes every reader open thirty sockets to
  // find one event, the cost the outbox model exists to avoid.
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: RELAY_LIST_KIND, tags, content: '' }
}

/** Read a kind 10002 event. Unknown markers are ignored, not fatal. */
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
    // A list naming one relay twice, once read and once write, means both.
    byUrl.set(url, existing ? { url, read: existing.read || entry.read, write: existing.write || entry.write } : entry)
  }
  return [...byUrl.values()]
}

/**
 * How many relays to contact.
 *
 * Four for reading: enough that one dead relay does not lose an event, few
 * enough that a page with thirty listings on screen does not open two hundred
 * sockets. Publishing uses five, because durability matters more than latency
 * there.
 */
export const READ_FANOUT = 4
export const WRITE_FANOUT = 5

/**
 * A published list replaces the fallback; the defaults are not appended
 * behind it.
 *
 * Appending them would look harmless, but a user who chose one relay, a paid
 * relay or a relay inside their own network would still have their events
 * pushed to five public relays they did not pick. The fallback applies only
 * when the user's list names no relay for the purpose at hand.
 */
function preferOwn(own: readonly string[], fallback: readonly string[], max: number): string[] {
  const mine = dedupe(own.map(normaliseRelayUrl).filter(isUrl))
  if (mine.length > 0) return mine.slice(0, max)
  return dedupe(fallback.map(normaliseRelayUrl).filter(isUrl)).slice(0, max)
}

/** Where to publish my own events: my write relays, or the fallback if I have none. */
export function writeRelaysFor(list: readonly RelayEntry[], fallback: readonly string[], max = WRITE_FANOUT): string[] {
  return preferOwn(list.filter((r) => r.write).map((r) => r.url), fallback, max)
}

/**
 * Where to find an author's events: their write relays.
 *
 * This is the rule people get backwards. To read Alice's listings, go where
 * Alice writes, not where Alice reads and not where you read. Getting it wrong
 * produces a marketplace that shows only the sellers who happen to use the
 * reader's relays.
 */
export function readRelaysFor(list: readonly RelayEntry[], fallback: readonly string[], max = READ_FANOUT): string[] {
  return preferOwn(list.filter((r) => r.write).map((r) => r.url), fallback, max)
}

/** Where to reach someone who should see an event: their read relays. */
export function inboxRelaysFor(list: readonly RelayEntry[], fallback: readonly string[], max = READ_FANOUT): string[] {
  return preferOwn(list.filter((r) => r.read).map((r) => r.url), fallback, max)
}

/**
 * Merge several authors' relays into one query plan.
 *
 * Querying each author on their own relays separately is correct and slow: ten
 * authors on four relays each is forty round trips, most of them to the same
 * handful of popular relays. Grouping by relay turns that into one filter per
 * relay carrying the authors that relay actually serves.
 *
 * Returns relay -> the authors to ask it about.
 */
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

/** The filter that fetches relay lists for a set of keys, in one query. */
export function relayListFilter(pubkeys: readonly string[]): Record<string, unknown> {
  return { kinds: [RELAY_LIST_KIND], authors: [...pubkeys] }
}

/** True when this event is the author's own relay list. */
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
