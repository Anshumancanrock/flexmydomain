/**
 * Polling a domain transfer: the fetching half of core/escrow/transfer.ts.
 *
 * Isomorphic. Turns an RDAP fetch into a dated, hashed Observation; the rules
 * that read observations are pure and live in core/escrow.
 *
 * A failed fetch must never be recorded as an observation. It would look like
 * a vanished lock or a reversed transfer, and the two-poll rule would
 * eventually confirm it. `observe` returns no observation in that case rather
 * than a negative reading.
 */

import { snapshotHash } from '../core/oracle/rdap.js'
import type { Observation } from '../core/escrow/transfer.js'
import { fetchRdapDomain } from './rdap.js'
import { parseRdapDomain } from '../core/oracle/rdap.js'

/**
 * One poll.
 *
 * The observation is undefined when the registry did not answer, which says
 * nothing about the domain and must not be recorded. A 404 is an answer, but
 * not one this function can use: a name that is not registered has no
 * transfer to watch, and the caller should stop polling.
 */
export async function observe(params: {
  domain: string
  now: number
  bootstrap?: unknown
  signal?: AbortSignal
}): Promise<{ observation?: Observation; raw?: string; reason?: string }> {
  const snapshot = await fetchRdapDomain(params.domain, {
    bootstrap: params.bootstrap,
    signal: params.signal,
    now: params.now,
  })

  if (!snapshot.supported) {
    return { reason: 'this TLD publishes no RDAP service, so a transfer cannot be verified here' }
  }
  if (!snapshot.ok || snapshot.raw === undefined) {
    return { reason: snapshot.error ?? `the registry did not answer (HTTP ${snapshot.status ?? 'none'})` }
  }

  return {
    raw: snapshot.raw,
    observation: {
      at: params.now,
      // Hash the bytes as received: a digest of a re-serialised object proves
      // nothing about what the registry sent.
      snapshotHash: snapshot.hash ?? snapshotHash(snapshot.raw),
      facts: parseRdapDomain(snapshot.response),
    },
  }
}

/**
 * Append a fresh poll to a history, keeping it ordered and bounded.
 *
 * Observations are evidence, so trimming never drops the oldest: `since` on a
 * confirmed state points at the earliest agreeing poll, and trimming from the
 * front would move it. Duplicate timestamps are dropped, since two readings of
 * the same second are one reading.
 */
export function record(
  history: readonly Observation[],
  observation: Observation,
  max = 200,
): Observation[] {
  if (history.some((o) => o.at === observation.at)) return [...history]
  const next = [...history, observation].sort((a, b) => a.at - b.at)
  // Over the limit, keep the earliest half and the most recent half, so a
  // long-running escrow keeps both its start and its current state.
  if (next.length <= max) return next
  const keepHead = Math.floor(max / 2)
  return [...next.slice(0, keepHead), ...next.slice(next.length - (max - keepHead))]
}
