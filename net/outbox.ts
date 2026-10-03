// NIP-65 outbox routing. Rules live in core/nostr/relays.ts, sockets in net/relay.ts.

import {
  RELAY_LIST_KIND,
  normaliseRelayUrl,
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

const RETRY_UNSURE_MS = 30_000

/** One canonical spelling per relay, so one relay is never asked or counted twice. */
function canonical(urls: readonly string[]): string[] {
  return [...new Set(urls.map((u) => normaliseRelayUrl(u) ?? u))]
}

export class RelayDirectory {
  private lists = new Map<string, RelayEntry[]>()
  private pending = new Map<string, Promise<RelayEntry[]>>()
  private unsure = new Map<string, number>()

  constructor(
    readonly fallback: readonly string[] = DEFAULT_RELAYS,
    /** Relays that must finish before "no list" counts as an answer: a majority, at most three. */
    readonly quorum = Math.min(3, Math.ceil(fallback.length / 2)),
  ) {}

  /** Cache only, no network. */
  known(pubkey: string): RelayEntry[] | undefined {
    return this.lists.get(pubkey)
  }

  certain(pubkey: string): boolean {
    return this.lists.has(pubkey) && !this.unsure.has(pubkey)
  }

  absorb(events: readonly NostrEvent[]): void {
    for (const event of newestPerAddress(events)) {
      const entries = parseRelayList(event)
      if (entries.length > 0) {
        this.lists.set(event.pubkey, entries)
        this.unsure.delete(event.pubkey)
      }
    }
  }

  async resolve(
    pubkeys: readonly string[],
    options: { timeoutMs?: number; retryUnsure?: boolean } = {},
  ): Promise<Map<string, RelayEntry[]>> {
    const stale = (p: string): boolean => {
      const at = this.unsure.get(p)
      return at !== undefined && (options.retryUnsure === true || Date.now() - at > RETRY_UNSURE_MS)
    }
    const missing = [...new Set(pubkeys)].filter((p) => (!this.lists.has(p) || stale(p)) && !this.pending.has(p))

    if (missing.length > 0) {
      let finished = 0
      // Only the timeout passes through: a caller's limit or callback would cut the lookup short.
      const request = queryRelays(this.fallback, [relayListFilter(missing)], {
        timeoutMs: options.timeoutMs ?? 4000,
        onRelayDone: (_relay, _count, _error, complete) => { if (complete) finished++ },
      })
        .catch(() => [] as NostrEvent[])
        .then((events) => {
          this.absorb(events)
          // Cache misses as []. Otherwise every render re-asks about each key with no kind 10002, which today is most keys.
          const sure = finished >= this.quorum
          for (const pubkey of missing) {
            if ((this.lists.get(pubkey)?.length ?? 0) > 0 && !this.unsure.has(pubkey)) continue
            this.lists.set(pubkey, [])
            if (sure) this.unsure.delete(pubkey)
            else this.unsure.set(pubkey, Date.now())
          }
          return events
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

  readRelays(pubkey: string): string[] {
    return readRelaysFor(this.lists.get(pubkey) ?? [], this.fallback)
  }
}

export async function publishOutbox(
  directory: RelayDirectory,
  event: NostrEvent,
  options: { extraRelays?: readonly string[] } = {},
): Promise<PublishResult[]> {
  await directory.resolve([event.pubkey], { retryUnsure: true })
  const before = directory.writeRelays(event.pubkey)
  const named = event.kind === RELAY_LIST_KIND ? writeRelaysFor(parseRelayList(event), []) : []
  const relays = canonical([...before, ...named, ...(options.extraRelays ?? [])])
  const results = await publishToRelays(relays, event)
  // Later writes follow the new list, but only once some relay holds it.
  if (event.kind === RELAY_LIST_KIND && results.some((r) => r.ok)) directory.absorb([event])
  return results
}

export interface OwnRead {
  /** The user's own events only, whatever a relay sends. */
  events: NostrEvent[]
  complete: boolean
  answered: number
  unanswered: string[]
}

export async function readOwn(
  directory: RelayDirectory,
  pubkey: string,
  filters: Filter[],
  options: { extraRelays?: readonly string[]; timeoutMs?: number } = {},
): Promise<OwnRead> {
  await directory.resolve([pubkey], { retryUnsure: true }).catch(() => undefined)
  const own = (directory.known(pubkey) ?? []).filter((r) => r.write).map((r) => r.url)
  const asked = canonical([...(own.length ? own : directory.fallback), ...(options.extraRelays ?? [])])
  const finished = new Set<string>()
  const events = await queryRelays(asked, filters, {
    timeoutMs: options.timeoutMs ?? 6000,
    onRelayDone: (relay, _count, _error, complete) => { if (complete) finished.add(relay) },
  }).catch(() => [] as NostrEvent[])
  const unanswered = asked.filter((r) => !finished.has(r))
  return {
    events: events.filter((e) => e.pubkey === pubkey),
    complete: directory.certain(pubkey) && unanswered.length === 0,
    answered: finished.size,
    unanswered,
  }
}

export async function queryOutbox(
  directory: RelayDirectory,
  authors: readonly string[],
  filter: Filter,
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  const lists = await directory.resolve(authors, { timeoutMs: options.timeoutMs })
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

export async function queryDiscovery(
  relays: readonly string[],
  filters: Filter[],
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  return queryRelays(relays, filters, options)
}
