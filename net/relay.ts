/**
 * A minimal Nostr relay pool: NIP-01 over WebSocket.
 *
 * Isomorphic: `WebSocket` only, which exists in a browser and in Bun. The pool
 * decides where a user's events go, so it is small enough to read in full
 * rather than a dependency. It does no reconnection, subscription
 * multiplexing or caching: a query opens sockets, collects until EOSE and
 * closes.
 *
 * Relays are untrusted, and an event from one is unverified until
 * `checkEvent` from core/nostr has run on it. The query functions here run it
 * on every event and drop the failures; any other code that reads from a
 * relay must do the same.
 */

import { checkEvent, type NostrEvent } from '../core/nostr/event.js'

/** A NIP-01 filter, loosely typed on purpose: relays accept more than we send. */
export type Filter = Record<string, unknown>

export interface QueryOptions {
  /** Give up on a relay after this long. A slow relay must not stall a page. */
  timeoutMs?: number
  /** Return early once this many verified events have arrived. */
  limit?: number
  signal?: AbortSignal
  /**
   * Called as each relay finishes, so a UI can show progress per relay.
   *
   * `complete` is true only when the relay sent EOSE or the limit was met. A
   * timeout or a dropped connection hands back whatever arrived, which may not
   * be everything, so a caller about to replace an event it rebuilt from what
   * it read must check this flag.
   */
  onRelayDone?: (relay: string, count: number, error?: string, complete?: boolean) => void
}

/** One relay's answer to one publish. */
export interface PublishResult {
  relay: string
  ok: boolean
  message?: string
}

const DEFAULT_TIMEOUT_MS = 6000

/**
 * Query several relays and merge the results.
 *
 * Every event is verified (id recomputed, signature checked) before it is
 * kept, because a relay can return anything. Events that fail are dropped
 * without an error, and `onRelayDone` reports how many each relay contributed.
 *
 * Duplicates across relays are collapsed by event id. For addressable kinds
 * the caller picks the version to show; `newestPerAddress` applies the NIP-01
 * replacement rule.
 */
export async function queryRelays(
  relays: readonly string[],
  filters: Filter[],
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  const byId = new Map<string, NostrEvent>()
  await Promise.all(
    relays.map(async (relay) => {
      try {
        const { events, complete } = await queryRelayDetailed(relay, filters, options)
        for (const event of events) byId.set(event.id, event)
        options.onRelayDone?.(relay, events.length, undefined, complete)
      } catch (err) {
        options.onRelayDone?.(relay, 0, (err as Error).message, false)
      }
    }),
  )
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at)
}

/** Query one relay. Resolves at EOSE, at the limit, or at the timeout. */
export async function queryRelay(relay: string, filters: Filter[], options: QueryOptions = {}): Promise<NostrEvent[]> {
  return (await queryRelayDetailed(relay, filters, options)).events
}

/** {@link queryRelay}, also saying whether the relay finished its answer. */
function queryRelayDetailed(
  relay: string,
  filters: Filter[],
  options: QueryOptions = {},
): Promise<{ events: NostrEvent[]; complete: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const subId = `fmd-${Math.random().toString(36).slice(2, 10)}`

  return new Promise((resolve, reject) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(relay)
    } catch (err) {
      reject(err)
      return
    }

    const events: NostrEvent[] = []
    let settled = false

    const finish = (error?: Error, complete = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subId]))
        socket.close()
      } catch {
        // already closed
      }
      if (error) reject(error)
      else resolve({ events, complete })
    }

    const onAbort = () => finish(new Error('aborted'))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // A timeout resolves with what arrived rather than rejecting: three good
    // relays and one hanging one should render three relays' worth of
    // listings, not an error page.
    const timer = setTimeout(() => finish(), timeoutMs)

    socket.onopen = () => socket.send(JSON.stringify(['REQ', subId, ...filters]))

    socket.onerror = () => finish(new Error(`${relay}: connection failed`))
    socket.onclose = () => finish()

    socket.onmessage = (message: MessageEvent) => {
      let frame: unknown
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : '')
      } catch {
        return
      }
      if (!Array.isArray(frame)) return

      const [type, id, payload] = frame as [string, string, unknown]
      if (id !== subId) return

      if (type === 'EVENT') {
        const checked = checkEvent(payload)
        if (checked.ok) {
          events.push(checked.event)
          if (options.limit !== undefined && events.length >= options.limit) finish(undefined, true)
        }
        return
      }
      if (type === 'EOSE') finish(undefined, true)
      if (type === 'CLOSED') finish()
    }
  })
}

/**
 * Publish one event to several relays.
 *
 * Returns every relay's answer, including refusals, and a UI should show them:
 * two acceptances out of five is not "published", and a refusal usually has a
 * reason the user can act on (a paid relay, a PoW requirement, a kind the
 * relay does not carry).
 */
export async function publishToRelays(
  relays: readonly string[],
  event: NostrEvent,
  options: { timeoutMs?: number } = {},
): Promise<PublishResult[]> {
  const checked = checkEvent(event)
  if (!checked.ok) {
    // Refuse locally instead of sending an event that cannot verify and getting
    // back a different error string from each relay.
    throw new Error(`publishToRelays: this event does not verify: ${checked.reason}`)
  }
  return Promise.all(relays.map((relay) => publishToRelay(relay, checked.event, options)))
}

/** Publish to one relay, resolving on its OK frame. */
export function publishToRelay(
  relay: string,
  event: NostrEvent,
  options: { timeoutMs?: number } = {},
): Promise<PublishResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(relay)
    } catch (err) {
      resolve({ relay, ok: false, message: (err as Error).message })
      return
    }

    let settled = false
    const finish = (result: PublishResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish({ relay, ok: false, message: 'timed out' }), timeoutMs)

    socket.onopen = () => socket.send(JSON.stringify(['EVENT', event]))
    socket.onerror = () => finish({ relay, ok: false, message: 'connection failed' })
    socket.onclose = () => finish({ relay, ok: false, message: 'closed before acknowledging' })

    socket.onmessage = (message: MessageEvent) => {
      let frame: unknown
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : '')
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      const [type, id, ok, reason] = frame as [string, string, boolean, string]
      if (type !== 'OK' || id !== event.id) return
      finish({ relay, ok: ok === true, message: typeof reason === 'string' && reason !== '' ? reason : undefined })
    }
  })
}

/**
 * NIP-45 COUNT: ask a relay how many events match, without fetching them.
 *
 * Useful for result totals, where the alternative is downloading every
 * matching event to count it.
 *
 * Support is optional and patchy. A relay that does not implement COUNT
 * answers with a NOTICE, an error or nothing at all, so the result is
 * `undefined` rather than 0. Render it as a missing value, not as "0": "could
 * not count" and "there are none" are different facts.
 */
export function countOnRelay(
  relay: string,
  filters: Filter[],
  options: { timeoutMs?: number } = {},
): Promise<number | undefined> {
  const timeoutMs = options.timeoutMs ?? 4000
  const subId = `fmd-count-${Math.random().toString(36).slice(2, 10)}`

  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(relay)
    } catch {
      resolve(undefined)
      return
    }

    let settled = false
    const finish = (value: number | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)

    socket.onopen = () => socket.send(JSON.stringify(['COUNT', subId, ...filters]))
    socket.onerror = () => finish(undefined)
    socket.onclose = () => finish(undefined)
    socket.onmessage = (message: MessageEvent) => {
      let frame: unknown
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : '')
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      const [type, id, payload] = frame as [string, string, { count?: number }]
      if (type === 'NOTICE' || type === 'CLOSED') finish(undefined)
      if (type !== 'COUNT' || id !== subId) return
      finish(typeof payload?.count === 'number' ? payload.count : undefined)
    }
  })
}

/**
 * The largest count any relay reports.
 *
 * Not a sum: relays hold overlapping sets, so adding the counts would count an
 * event once for every relay that holds it. The maximum is a lower bound on
 * the true total, and the best figure available without fetching the events.
 */
export async function countOnRelays(
  relays: readonly string[],
  filters: Filter[],
  options: { timeoutMs?: number } = {},
): Promise<number | undefined> {
  const counts = (await Promise.all(relays.map((r) => countOnRelay(r, filters, options)))).filter(
    (c): c is number => typeof c === 'number',
  )
  return counts.length === 0 ? undefined : Math.max(...counts)
}

/**
 * Fetch a relay's NIP-11 information document.
 *
 * Lets a page show, for each relay, whether it accepts kind 30402, what it
 * charges and what limits it imposes.
 */
export async function fetchRelayInfo(relay: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
  const url = relay.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  const response = await fetch(url, {
    headers: { accept: 'application/nostr+json' },
    signal: options.signal,
    credentials: 'omit',
  })
  if (!response.ok) throw new Error(`${relay}: HTTP ${response.status}`)
  return response.json()
}

/**
 * The newest event per addressable coordinate.
 *
 * Relays should hold one event per (kind, pubkey, d), but several also return
 * older versions, especially just after an update. Keeping the newest
 * `created_at`, and the lowest id on a tie as NIP-01 says, stops a stale price
 * from reappearing on the page.
 */
export function newestPerAddress(events: readonly NostrEvent[]): NostrEvent[] {
  const best = new Map<string, NostrEvent>()
  for (const event of events) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
    const address = `${event.kind}:${event.pubkey}:${d}`
    const current = best.get(address)
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      best.set(address, event)
    }
  }
  return [...best.values()]
}
