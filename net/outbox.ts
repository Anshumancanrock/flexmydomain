/**
 * The outbox model (NIP-65): routing queries and publishes over the relay
 * pool.
 *
 * Isomorphic. core/nostr/relays.ts holds the routing rules and net/relay.ts
 * does the sockets; this module joins them and decides which relays a query or
 * a publish touches.
 *
 * A seller publishes to the relays they chose and a reader finds them there,
 * so neither side depends on a relay list this project picked. The cost is one
 * extra round trip the first time a key is seen, to fetch its kind 10002 list,
 * which is then cached for the session. A key with no list (most keys, today)
 * uses the fallback relays.
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
 * A session-lived cache of who writes where.
 *
 * Not persisted on purpose: a relay list is a live statement, and a user who
 * moves relays should be found on the new ones at their next visit.
 */
export class RelayDirectory {
  private lists = new Map<string, RelayEntry[]>()
  private pending = new Map<string, Promise<RelayEntry[]>>()

  constructor(
    /** Where relay lists are looked up, and the relays for a key that has none. */
    readonly fallback: readonly string[] = DEFAULT_RELAYS,
  ) {}

  /** The cached list for a key, without a network request. */
  known(pubkey: string): RelayEntry[] | undefined {
    return this.lists.get(pubkey)
  }

  /** Seed the cache from relay-list events already in hand, with no round trip. */
  absorb(events: readonly NostrEvent[]): void {
    for (const event of newestPerAddress(events)) {
      const entries = parseRelayList(event)
      if (entries.length > 0) this.lists.set(event.pubkey, entries)
    }
  }

  /**
   * Fetch relay lists for these keys, once each.
   *
   * Concurrent callers asking about the same key share one request; a market
   * page rendering thirty listings would otherwise ask thirty times about the
   * same seller.
   */
  async resolve(pubkeys: readonly string[], options: QueryOptions = {}): Promise<Map<string, RelayEntry[]>> {
    const missing = [...new Set(pubkeys)].filter((p) => !this.lists.has(p) && !this.pending.has(p))

    if (missing.length > 0) {
      const request = queryRelays(this.fallback, [relayListFilter(missing)], { timeoutMs: 4000, ...options })
        .then((events) => {
          this.absorb(events)
          // Remember the misses too, as an empty list. Otherwise every render
          // re-asks the network about every key that has no kind 10002, which
          // today is most of them.
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

  /** Where this key's own events should be published. */
  writeRelays(pubkey: string): string[] {
    return writeRelaysFor(this.lists.get(pubkey) ?? [], this.fallback)
  }

  /** Where this key's events are found. Their write relays, not ours. */
  readRelays(pubkey: string): string[] {
    return readRelaysFor(this.lists.get(pubkey) ?? [], this.fallback)
  }
}

/**
 * Publish an event to its author's own write relays.
 *
 * The author is the event's pubkey, never the connected user: republishing
 * somebody else's event should still go where that somebody writes.
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
 * Query several authors, each on the relays they write to.
 *
 * One filter per relay, carrying only the authors that relay serves: ten
 * authors on four relays each becomes a few requests rather than forty.
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
 * A discovery query with no author list, such as "every listing".
 *
 * With no author to route by, the outbox model does not apply, so this sweeps
 * the relays the caller names. The UI should say that the result covers those
 * relays, not the whole network.
 */
export async function queryDiscovery(
  relays: readonly string[],
  filters: Filter[],
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  return queryRelays(relays, filters, options)
}
