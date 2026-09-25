/**
 * NIP-65 outbox routing. Rules live in core/nostr/relays.ts, sockets in net/relay.ts.
 * Authors are read where they write, not on relays we picked. A new key costs one
 * round trip for its kind 10002 list. Keys without one (most, today) use the fallback.
 */

import {
  parseRelayList,
  planAuthorQuery,
  readRelaysFor,
  relayListFilter,
  writeRelaysFor,
  type RelayEntry,
} from '../core/nostr/relays.js'
import { DEFAULT_RELAYS } from '../core/nostr/index.js'
import { newestPerAddress, publishToRelays, queryRelays, type Filter, type PublishResult, type QueryOptions } from './relay.js'
import type { NostrEvent } from '../core/nostr/event.js'

/**
 * Session cache of who writes where. Not persisted. A user who moves relays
 * should be found on the new ones at their next visit.
 */
export class RelayDirectory {
  private lists = new Map<string, RelayEntry[]>()
  private pending = new Map<string, Promise<RelayEntry[]>>()

  constructor(
    /** Where lists are looked up, and the relays for a key without one. */
    readonly fallback: readonly string[] = DEFAULT_RELAYS,
  ) {}

  /** Cache only, no network. */
  known(pubkey: string): RelayEntry[] | undefined {
    return this.lists.get(pubkey)
  }

  /** Seed the cache from relay-list events we already have. */
  absorb(events: readonly NostrEvent[]): void {
    for (const event of newestPerAddress(events)) {
      const entries = parseRelayList(event)
      if (entries.length > 0) this.lists.set(event.pubkey, entries)
    }
  }

  /**
   * Fetch relay lists, once per key. Concurrent callers share the request, or a
   * page with thirty listings would ask about the same seller thirty times.
   */
  async resolve(pubkeys: readonly string[], options: QueryOptions = {}): Promise<Map<string, RelayEntry[]>> {
    const missing = [...new Set(pubkeys)].filter((p) => !this.lists.has(p) && !this.pending.has(p))

    if (missing.length > 0) {
      const request = queryRelays(this.fallback, [relayListFilter(missing)], { timeoutMs: 4000, ...options })
        .then((events) => {
          this.absorb(events)
          // Cache misses as []. Otherwise every render re-asks about each key
          // with no kind 10002, which today is most keys.
          for (const pubkey of missing) if (!this.lists.has(pubkey)) this.lists.set(pubkey, [])
          return events
        })
        .catch(() => {
          for (const pubkey of missing) if (!this.lists.has(pubkey)) this.lists.set(pubkey, [])
          return [] as NostrEvent[]
        })

      for (const pubkey of missing) {
        this.pending.set(
          pubkey,
          request.then(() => this.lists.get(pubkey) ?? []),
        )
      }
    }

    await Promise.all([...new Set(pubkeys)].map((p) => this.pending.get(p) ?? Promise.resolve()))
    for (const pubkey of pubkeys) this.pending.delete(pubkey)

    const out = new Map<string, RelayEntry[]>()
    for (const pubkey of new Set(pubkeys)) out.set(pubkey, this.lists.get(pubkey) ?? [])
    return out
  }

  writeRelays(pubkey: string): string[] {
    return writeRelaysFor(this.lists.get(pubkey) ?? [], this.fallback)
  }

  /** Where to find this key's events. Its write relays, not ours. */
  readRelays(pubkey: string): string[] {
    return readRelaysFor(this.lists.get(pubkey) ?? [], this.fallback)
  }
}

/**
 * Publish to the author's write relays. The author is event.pubkey, never the
 * connected user, so a republished event still goes where its author writes.
 */
export async function publishOutbox(
  directory: RelayDirectory,
  event: NostrEvent,
  options: { extraRelays?: readonly string[] } = {},
): Promise<PublishResult[]> {
  await directory.resolve([event.pubkey])
  const relays = [...new Set([...directory.writeRelays(event.pubkey), ...(options.extraRelays ?? [])])]
  return publishToRelays(relays, event)
}

/**
 * Query each author on the relays they write to. One filter per relay with only
 * the authors it serves, so 10 authors on 4 relays is a few requests, not 40.
 */
export async function queryOutbox(
  directory: RelayDirectory,
  authors: readonly string[],
  filter: Filter,
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  const lists = await directory.resolve(authors, options)
  const plan = planAuthorQuery(lists, authors, directory.fallback)

  const byId = new Map<string, NostrEvent>()
  await Promise.all(
    [...plan.entries()].map(async ([relay, group]) => {
      const events = await queryRelays([relay], [{ ...filter, authors: group }], options).catch(() => [])
      for (const event of events) byId.set(event.id, event)
    }),
  )
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at)
}

/**
 * Authorless query like "every listing". Nothing to route by, so this sweeps the
 * given relays. The UI should say results cover those relays, not the network.
 */
export async function queryDiscovery(
  relays: readonly string[],
  filters: Filter[],
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  return queryRelays(relays, filters, options)
}
