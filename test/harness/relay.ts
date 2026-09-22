/**
 * A minimal in-memory Nostr relay, for tests.
 *
 * Implements enough of NIP-01 to exercise net/relay.ts over a real WebSocket:
 * REQ with filters, EVENT frames, EOSE, CLOSE, OK on publish, and NIP-45
 * COUNT. No dependencies and nothing on disk.
 *
 * Public relays would make the tests slow and flaky, and would publish test
 * events to infrastructure other people rely on. This is a fixture, not a
 * relay implementation: it stores what it is sent without verifying anything.
 */

import type { NostrEvent } from '../../core/nostr/event.js'

export interface RelayOptions {
  /** Refuse every publish with this message, to test the failure path. */
  refuseWith?: string
  /** Answer COUNT requests. Real relays often do not. */
  supportsCount?: boolean
  /** Never send EOSE, so the caller has to time out. */
  withholdEose?: boolean
  /** Drop the connection as soon as it opens. */
  dropOnOpen?: boolean
  /** Seed events. */
  events?: NostrEvent[]
}

export interface TestRelay {
  url: string
  /** Every event the relay currently holds. */
  events: NostrEvent[]
  /** Events received via EVENT frames, in order. */
  published: NostrEvent[]
  add(...events: NostrEvent[]): void
  close(): void
}

/** NIP-01 filter matching. Enough for the filters this project sends. */
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

/**
 * Start a relay on an ephemeral port.
 *
 * Replaceable and addressable kinds are collapsed as a real relay does, to one
 * event per (kind, pubkey, d). Several tests depend on the newest version
 * winning, and a fixture that returned every version would let them pass for
 * the wrong reason.
 */
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

  // Seeds go through the same replacement rules as published events.
  for (const seed of options.events ?? []) store(seed)

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined as unknown as Response
      return new Response('nostr relay fixture', { status: 200 })
    },
    websocket: {
      open(ws) {
        if (options.dropOnOpen) ws.close()
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

        if (type === 'EVENT') {
          const event = id as unknown as NostrEvent
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
          const filters = rest
          for (const event of events) {
            if (filters.some((f) => matches(event, f))) {
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
          // Nothing to tear down; the fixture holds no subscriptions.
        }
      },
    },
  })

  return {
    url: `ws://localhost:${server.port}`,
    events,
    published,
    add: (...more) => more.forEach(store),
    close: () => server.stop(true),
  }
}
