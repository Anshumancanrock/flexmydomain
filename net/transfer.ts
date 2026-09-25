/**
 * Transfer polling. Turns an RDAP fetch into a dated, hashed Observation for core/escrow.
 * A failed fetch must never become an observation. It would read as a vanished lock
 * or a reversed transfer, and the two-poll rule would eventually confirm it.
 */

import { snapshotHash } from '../core/oracle/rdap.js'
import type { Observation } from '../core/escrow/transfer.js'
import { fetchRdapDomain } from './rdap.js'
import { parseRdapDomain } from '../core/oracle/rdap.js'

/**
 * One poll. No observation when the registry didn't answer. A 404 means the
 * name isn't registered, so there is no transfer and the caller should stop polling.
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
      // Hash the bytes as received, not a re-serialised object.
      snapshotHash: snapshot.hash ?? snapshotHash(snapshot.raw),
      facts: parseRdapDomain(snapshot.response),
    },
  }
}

/**
 * Append a poll, keeping the history sorted and bounded. Trimming never drops
 * the oldest, since a confirmed state's `since` points at the earliest agreeing
 * poll. Two readings in the same second count as one.
 */
export function record(
  history: readonly Observation[],
  observation: Observation,
  max = 200,
): Observation[] {
  if (history.some((o) => o.at === observation.at)) return [...history]
  const next = [...history, observation].sort((a, b) => a.at - b.at)
  // Over max, keep the oldest half and the newest half.
  if (next.length <= max) return next
  const keepHead = Math.floor(max / 2)
  return [...next.slice(0, keepHead), ...next.slice(next.length - (max - keepHead))]
}
