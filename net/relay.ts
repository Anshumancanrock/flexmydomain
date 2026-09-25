// Minimal NIP-01 relay pool. No reconnects or caching: open, read to EOSE, close.
// Relays are untrusted. Every event goes through checkEvent before we keep it.

import { checkEvent, type NostrEvent } from '../core/nostr/event.js'

/** NIP-01 filter. Loosely typed, since relays accept more than we send. */
export type Filter = Record<string, unknown>

export interface QueryOptions {
  /** Per relay. A slow relay must not stall the page. */
  timeoutMs?: number
  /** Stop reading a relay after this many verified events. */
  limit?: number
  signal?: AbortSignal
  /**
   * Called per relay. `complete` means EOSE or the limit was hit. After a
   * timeout or a drop the events may be partial, so check it before replacing
   * an event you rebuilt from them.
   */
  onRelayDone?: (relay: string, count: number, error?: string, complete?: boolean) => void
}

export interface PublishResult {
  relay: string
  ok: boolean
  message?: string
}

const DEFAULT_TIMEOUT_MS = 6000

/**
 * Query relays in parallel and dedupe by id. Invalid events drop silently.
 * For addressable kinds, pick the version with newestPerAddress.
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

/** One relay. Resolves at EOSE, the limit or the timeout. */
export async function queryRelay(relay: string, filters: Filter[], options: QueryOptions = {}): Promise<NostrEvent[]> {
  return (await queryRelayDetailed(relay, filters, options)).events
}

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
        // Already closed.
      }
      if (error) reject(error)
      else resolve({ events, complete })
    }

    const onAbort = () => finish(new Error('aborted'))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // A timeout resolves with what we have. One hung relay must not blank the page.
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
 * Returns every relay's answer, refusals included, and the UI should show them.
 * Two of five accepting is not "published". Refusals usually give a reason the
 * user can fix.
 */
export async function publishToRelays(
  relays: readonly string[],
  event: NostrEvent,
  options: { timeoutMs?: number } = {},
): Promise<PublishResult[]> {
  const checked = checkEvent(event)
  if (!checked.ok) {
    // Fail here once, not with a different error from each relay.
    throw new Error(`publishToRelays: this event does not verify: ${checked.reason}`)
  }
  return Promise.all(relays.map((relay) => publishToRelay(relay, checked.event, options)))
}

/** One relay. Resolves on its OK frame. */
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
        // Already closed.
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
 * NIP-45 COUNT. Support is patchy, and a relay without it sends NOTICE, an
 * error or nothing. That gives undefined, never 0. Render it as unknown.
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
        // Already closed.
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
 * Max of the relay counts, not the sum. Relays overlap, so a sum counts an
 * event once per relay holding it. The max is a lower bound on the true total.
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

/** NIP-11 info document. Tells us if a relay takes kind 30402, its fees and limits. */
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
 * Newest event per (kind, pubkey, d), lowest id on a tie (NIP-01). Some relays
 * also return older versions, which would bring back a stale price.
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
