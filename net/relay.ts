// Minimal NIP-01 relay pool. No reconnects or caching: open, read to EOSE, close.

import { checkEvent, matchFilters, type NostrEvent } from '../core/nostr/event.js'

/** NIP-01 filter. Loosely typed, since relays accept more than we send. */
export type Filter = Record<string, unknown>

export interface QueryOptions {
  /** Per relay. A slow relay must not stall the page. */
  timeoutMs?: number
  limit?: number
  signal?: AbortSignal
  onRelayDone?: (relay: string, count: number, error?: string, complete?: boolean) => void
  /** Signs a NIP-42 AUTH for a relay that asks, or undefined to decline. */
  auth?: RelayAuth
}

/** Sign a kind 22242 for `relay` and its `challenge` (core/nostr/nip42.ts buildAuthEvent). */
export type RelayAuth = (relay: string, challenge: string) => Promise<NostrEvent | undefined>

export interface PublishResult {
  relay: string
  ok: boolean
  message?: string
}

const DEFAULT_TIMEOUT_MS = 6000

/* ---------- Warm connections ---------- */

let warmMs = 0
const warm = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>()

/** Keep sockets open `ms` after a clean read for the next one, or 0 to stop (closing those held). */
export function keepConnectionsWarm(ms: number): void {
  warmMs = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (warmMs === 0) {
    for (const [relay, held] of [...warm]) {
      warm.delete(relay)
      clearTimeout(held.timer)
      closeQuietly(held.socket)
    }
  }
}

function closeQuietly(socket: WebSocket): void {
  try {
    socket.close()
  } catch {
  }
}

function park(relay: string, socket: WebSocket): void {
  if (warmMs === 0 || socket.readyState !== WebSocket.OPEN || warm.has(relay)) {
    closeQuietly(socket)
    return
  }
  const drop = () => {
    if (warm.get(relay)?.socket !== socket) return
    clearTimeout(warm.get(relay)!.timer)
    warm.delete(relay)
  }
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = drop
  socket.onclose = drop
  const timer = setTimeout(() => {
    drop()
    closeQuietly(socket)
  }, warmMs)
  warm.set(relay, { socket, timer })
}

function takeWarm(relay: string): WebSocket | undefined {
  const held = warm.get(relay)
  if (!held) return undefined
  warm.delete(relay)
  clearTimeout(held.timer)
  if (held.socket.readyState !== WebSocket.OPEN) {
    closeQuietly(held.socket)
    return undefined
  }
  return held.socket
}

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

export async function queryRelay(relay: string, filters: Filter[], options: QueryOptions = {}): Promise<NostrEvent[]> {
  return (await queryRelayDetailed(relay, filters, options)).events
}

function queryRelayDetailed(
  relay: string,
  filters: Filter[],
  options: QueryOptions = {},
  fresh = false,
): Promise<{ events: NostrEvent[]; complete: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const subId = `fmd-${Math.random().toString(36).slice(2, 10)}`

  return new Promise((resolve, reject) => {
    // A read that may authenticate never shares a socket, in either direction.
    const reused = fresh || options.auth ? undefined : takeWarm(relay)
    let socket: WebSocket
    try {
      socket = reused ?? new WebSocket(relay)
    } catch (err) {
      reject(err)
      return
    }
    let heard = false

    const events: NostrEvent[] = []
    let settled = false
    // NIP-42: the relay's challenge, our answer, and whether it took it.
    let challenge: string | undefined
    let authId: string | undefined
    let authOk = false
    let closedForAuth = false
    let retried = false
    const request = () => socket.send(JSON.stringify(['REQ', subId, ...filters]))
    const authenticate = async () => {
      if (!options.auth || challenge === undefined || authId !== undefined) return
      let signed: NostrEvent | undefined
      try {
        signed = await options.auth(relay, challenge)
      } catch {
        signed = undefined
      }
      if (settled) return
      if (!signed) {
        // Declined: a query waiting on it can't go on.
        if (closedForAuth) finish()
        return
      }
      authId = signed.id
      socket.send(JSON.stringify(['AUTH', signed]))
    }

    const finish = (error?: Error, complete = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subId]))
        // Only a clean read with no AUTH in it hands its socket on.
        if (!error && complete && !options.auth) park(relay, socket)
        else socket.close()
      } catch {
      }
      if (error) reject(error)
      else resolve({ events, complete })
    }

    const retry = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      closeQuietly(socket)
      queryRelayDetailed(relay, filters, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) }, true).then(resolve, reject)
    }

    const onAbort = () => finish(new Error('aborted'))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // A timeout resolves with what we have. One hung relay must not blank the page.
    const timer = setTimeout(() => finish(), timeoutMs)

    socket.onerror = () => (reused && !heard ? retry() : finish(new Error(`${relay}: connection failed`)))
    socket.onclose = () => (reused && !heard ? retry() : finish())

    socket.onmessage = (message: MessageEvent) => {
      let frame: unknown
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : '')
      } catch {
        return
      }
      if (!Array.isArray(frame)) return

      const [type, id, payload] = frame as [string, string, unknown]
      if (type === 'AUTH' && typeof id === 'string') {
        challenge = id
        void authenticate()
        return
      }
      if (type === 'OK' && authId !== undefined && id === authId) {
        authOk = payload === true
        if (closedForAuth) {
          if (authOk && !retried) {
            retried = true
            closedForAuth = false
            request()
          } else {
            finish()
          }
        }
        return
      }
      if (id !== subId) return
      heard = true

      if (type === 'EVENT') {
        const checked = checkEvent(payload)
        if (checked.ok && matchFilters(filters, checked.event)) {
          events.push(checked.event)
          if (options.limit !== undefined && events.length >= options.limit) finish(undefined, true)
        }
        return
      }
      if (type === 'EOSE') finish(undefined, true)
      if (type === 'CLOSED') {
        // Once only: a relay that keeps refusing after accepting our AUTH has said no.
        if (typeof payload === 'string' && payload.startsWith('auth-required:') && options.auth && !retried) {
          if (authOk) {
            retried = true
            request()
          } else {
            closedForAuth = true
            void authenticate()
          }
          return
        }
        finish()
      }
    }

    if (reused) {
      try {
        request()
      } catch {
        retry()
      }
    } else {
      socket.onopen = request
    }
  })
}

export async function publishToRelays(
  relays: readonly string[],
  event: NostrEvent,
  options: { timeoutMs?: number; auth?: RelayAuth } = {},
): Promise<PublishResult[]> {
  const checked = checkEvent(event)
  if (!checked.ok) {
    throw new Error(`publishToRelays: this event does not verify: ${checked.reason}`)
  }
  return Promise.all(relays.map((relay) => publishToRelay(relay, checked.event, options)))
}

export function publishToRelay(
  relay: string,
  event: NostrEvent,
  options: { timeoutMs?: number; auth?: RelayAuth } = {},
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
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish({ relay, ok: false, message: 'timed out' }), timeoutMs)
    // NIP-42, as for queries: answer a challenge only when asked to, and send the event again once.
    let challenge: string | undefined
    let authId: string | undefined
    let refused: PublishResult | undefined
    const send = () => socket.send(JSON.stringify(['EVENT', event]))
    const authenticate = async () => {
      if (!options.auth || challenge === undefined || authId !== undefined) return
      const signed = await options.auth(relay, challenge).catch(() => undefined)
      if (settled) return
      if (!signed) {
        if (refused) finish(refused)
        return
      }
      authId = signed.id
      socket.send(JSON.stringify(['AUTH', signed]))
    }

    socket.onopen = send
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
      if (type === 'AUTH' && typeof id === 'string') {
        challenge = id
        if (refused) void authenticate()
        return
      }
      if (type === 'OK' && authId !== undefined && id === authId) {
        if (ok === true && refused) {
          refused = undefined
          send()
        } else if (refused) {
          finish(refused)
        }
        return
      }
      if (type !== 'OK' || id !== event.id) return
      const result = { relay, ok: ok === true, message: typeof reason === 'string' && reason !== '' ? reason : undefined }
      // Once only, and only when asked to authenticate.
      if (!result.ok && options.auth && authId === undefined && result.message?.startsWith('auth-required:')) {
        refused = result
        if (challenge !== undefined) void authenticate()
        return
      }
      finish(result)
    }
  })
}

/** NIP-45 COUNT. Support is patchy, and a relay without it sends NOTICE, an error or nothing. */
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

/** Newest event per (kind, pubkey, d), lowest id on a tie (NIP-01). */
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
