// In-memory NIP-01 relay (plus NIP-45 COUNT) on a real WebSocket. Stores what it gets, verifies nothing.

import { checkEvent, type NostrEvent } from '../../core/nostr/event.js'

export interface RelayOptions {
  refuseWith?: string
  /** Answer COUNT. Many real relays don't. */
  supportsCount?: boolean
  withholdEose?: boolean
  dropOnOpen?: boolean
  /** Send everything held on every REQ, like a lying relay. */
  ignoreFilters?: boolean
  events?: NostrEvent[]
  /** NIP-42 as relay.damus.io does it: challenge on connect, gift wraps only to the authed key they name. */
  requireAuth?: boolean
  requireAuthToWrite?: boolean
  /** Close the socket on its second REQ without answering, like a relay dropping an idle connection. */
  dropSecondReq?: boolean
}

export interface TestRelay {
  url: string
  /** What the relay holds now, after replacement. */
  events: NostrEvent[]
  /** Every EVENT received, in order. */
  published: NostrEvent[]
  add(...events: NostrEvent[]): void
  /** Connections opened so far. */
  readonly connections: number
  readonly openNow: number
  /** Close every open connection, like a relay restart. */
  kick(): void
  close(): void
}

/** NIP-01 filter match, enough for the filters the client sends. */
export function matches(event: NostrEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false
  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false

  for (const [key, want] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(want)) continue
    const name = key.slice(1)
    const have = event.tags.filter((t) => t[0] === name).map((t) => t[1])
    if (!have.some((v) => want.includes(v))) return false
  }
  return true
}

/** Replaceable and addressable kinds keep only the newest event per (kind, pubkey, d), like a real relay. */
export function startRelay(options: RelayOptions = {}): TestRelay {
  const events: NostrEvent[] = []
  const published: NostrEvent[] = []

  const addressOf = (e: NostrEvent) =>
    `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`

  const replaceable = (kind: number) =>
    kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)

  function store(event: NostrEvent): void {
    if (replaceable(event.kind)) {
      const key = addressOf(event)
      const existing = events.findIndex((e) => addressOf(e) === key && e.kind === event.kind)
      if (existing !== -1) {
        if (events[existing].created_at > event.created_at) return
        events.splice(existing, 1)
      }
    } else if (events.some((e) => e.id === event.id)) {
      return
    }
    events.push(event)
  }

  for (const seed of options.events ?? []) store(seed)

  const sessions = new WeakMap<object, { challenge: string; authed?: string }>()
  const sockets = new Set<{ close(): void }>()
  const reqs = new WeakMap<object, number>()
  let connections = 0
  const giftWrapKind = 1059
  const wantsWraps = (filters: Record<string, unknown>[]) =>
    filters.some((f) => !Array.isArray(f.kinds) || (f.kinds as unknown[]).includes(giftWrapKind))

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined as unknown as Response
      return new Response('nostr relay fixture', { status: 200 })
    },
    websocket: {
      open(ws) {
        connections++
        sockets.add(ws)
        if (options.dropOnOpen) {
          ws.close()
          return
        }
        if (options.requireAuth || options.requireAuthToWrite) {
          const challenge = `challenge-${Math.random().toString(36).slice(2)}`
          sessions.set(ws, { challenge })
          ws.send(JSON.stringify(['AUTH', challenge]))
        }
      },
      message(ws, raw) {
        let frame: unknown
        try {
          frame = JSON.parse(String(raw))
        } catch {
          return
        }
        if (!Array.isArray(frame)) return
        const [type, id, ...rest] = frame as [string, string, ...Record<string, unknown>[]]

        if (type === 'AUTH') {
          const session = sessions.get(ws)
          const checked = checkEvent(id)
          const event = id as unknown as NostrEvent
          const challenge = checked.ok ? event.tags.find((t) => t[0] === 'challenge')?.[1] : undefined
          const ok = !!session && checked.ok && event.kind === 22242 && challenge === session.challenge &&
            event.tags.some((t) => t[0] === 'relay')
          if (ok) session!.authed = event.pubkey
          ws.send(JSON.stringify(['OK', (id as unknown as { id?: string })?.id, ok, ok ? '' : 'auth-required: bad auth event']))
          return
        }

        if (type === 'EVENT') {
          const event = id as unknown as NostrEvent
          if (options.requireAuthToWrite && !sessions.get(ws)?.authed) {
            ws.send(JSON.stringify(['OK', event.id, false, 'auth-required: authenticate first']))
            return
          }
          if (options.refuseWith) {
            ws.send(JSON.stringify(['OK', event.id, false, options.refuseWith]))
            return
          }
          published.push(event)
          store(event)
          ws.send(JSON.stringify(['OK', event.id, true, '']))
          return
        }

        if (type === 'REQ') {
          const asked = (reqs.get(ws) ?? 0) + 1
          reqs.set(ws, asked)
          if (options.dropSecondReq && asked === 2) {
            ws.close()
            return
          }
          const filters = rest
          const authed = sessions.get(ws)?.authed
          if (options.requireAuth && wantsWraps(filters) && !authed) {
            ws.send(JSON.stringify(['CLOSED', id, 'auth-required: gift wraps go only to the key they name']))
            return
          }
          for (const event of events) {
            // A gift wrap goes only to the key its p tag names, as NIP-17 asks of relays.
            if (options.requireAuth && event.kind === giftWrapKind && !event.tags.some((t) => t[0] === 'p' && t[1] === authed)) continue
            if (options.ignoreFilters || filters.some((f) => matches(event, f))) {
              ws.send(JSON.stringify(['EVENT', id, event]))
            }
          }
          if (!options.withholdEose) ws.send(JSON.stringify(['EOSE', id]))
          return
        }

        if (type === 'COUNT') {
          if (!options.supportsCount) {
            ws.send(JSON.stringify(['NOTICE', 'COUNT is not supported by this relay']))
            return
          }
          const filters = rest
          const count = events.filter((e) => filters.some((f) => matches(e, f))).length
          ws.send(JSON.stringify(['COUNT', id, { count }]))
          return
        }

        if (type === 'CLOSE') {
          // No subscriptions are kept, so nothing to tear down.
        }
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })

  return {
    url: `ws://localhost:${server.port}`,
    events,
    published,
    add: (...more) => more.forEach(store),
    get connections() {
      return connections
    },
    get openNow() {
      return sockets.size
    },
    kick: () => {
      for (const ws of [...sockets]) ws.close()
    },
    close: () => server.stop(true),
  }
}
