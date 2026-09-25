/**
 * Follows a domain transfer through public RDAP, with no registrar integration.
 * The parties move the name themselves and we only read what the registry
 * shows. Holding registrar API keys would make the site the domain's custodian.
 * See spec/PROTOCOL.md.
 *
 * No fetch and no clock. Observations and time are arguments, so a verdict can
 * be reproduced from its evidence months later in a dispute.
 *
 * Watched for, in order:
 *
 *   lock on, then off  only the registrant can change it. Gates funding.
 *   pendingTransfer    the transfer is underway: the point of no return.
 *   fingerprint moved  the registry agrees the name is somewhere new.
 *
 * Nothing changes on one observation. RDAP is cached, registries lag by hours
 * and a failed fetch is not evidence, so a change needs two agreeing polls at
 * least 30 minutes apart.
 */

import { fingerprintMatches, type Fingerprint, type RdapFacts } from '../oracle/rdap.js'
import { PENDING_TRANSFER_STATUS, TRANSFER_LOCK_STATUS } from '../oracle/rdap.js'

/** Closer polls are likely the same cached answer read twice. */
export const MIN_POLL_GAP_SECONDS = 1800

export const REQUIRED_AGREEING_POLLS = 2

/**
 * Where the buyer will receive the name, stated before any money moves. RDAP
 * redacts the registrant almost everywhere (GDPR) and shows only the registrar,
 * so "transferred" means "the registry shows what the buyer committed to".
 *
 * Two fields since either alone has a hole. A move between registrars changes
 * the IANA id, but a push inside one registrar only moves the nameservers.
 */
export interface TransferCommitment extends Fingerprint {
  committedAt: number
}

/** One dated RDAP poll. The hash is what goes in the escrow event. */
export interface Observation {
  at: number
  /** sha256 of the raw response bytes as received. */
  snapshotHash: string
  facts: RdapFacts
}

export type TransferState =
  /** `clientTransferProhibited` present. Only the registrant can clear it. */
  | 'locked'
  /**
   * No lock. Says nothing about who holds the name, many registrars never set
   * it. See {@link registrantActed}.
   */
  | 'unlocked'
  /** `pendingTransfer` seen. Point of no return. */
  | 'pending'
  /** Registry shows what the buyer committed to. */
  | 'transferred'
  /** Transferred, then moved back by a registrar reversal. */
  | 'reverted'
  /** Not enough agreeing observations yet. */
  | 'unknown'

export interface TransferVerdict {
  state: TransferState
  /** REQUIRED_AGREEING_POLLS agreed, far enough apart. */
  confirmed: boolean
  /** Time of the earliest agreeing observation. */
  since?: number
  /** Snapshot hashes backing this verdict. */
  evidence: string[]
  /** Plain words, for the UI and for a ruling. */
  reason: string
}

/** Which state one observation supports. */
function classify(observation: Observation, commitment: TransferCommitment): TransferState {
  const { facts } = observation

  // First, since most registrars re-lock right after a transfer and it still counts.
  if (fingerprintMatches({ registrarIanaId: facts.registrarIanaId, nameservers: facts.nameservers }, commitment)) {
    return 'transferred'
  }
  if (facts.statuses.includes(PENDING_TRANSFER_STATUS)) return 'pending'
  if (facts.statuses.includes(TRANSFER_LOCK_STATUS)) return 'locked'
  return 'unlocked'
}

/**
 * The two-poll rule. Is `state` backed by REQUIRED_AGREEING_POLLS observations
 * at least MIN_POLL_GAP_SECONDS apart? Disagreeing polls don't average out.
 * They confirm nothing, and the previous confirmed state stands.
 */
function confirm(
  observations: readonly Observation[],
  commitment: TransferCommitment,
  state: TransferState,
): { confirmed: boolean; since?: number; evidence: string[] } {
  const supporting = observations
    .filter((o) => classify(o, commitment) === state)
    .sort((a, b) => a.at - b.at)

  if (supporting.length < REQUIRED_AGREEING_POLLS) return { confirmed: false, evidence: [] }

  // Earliest qualifying pair, for the most accurate `since`.
  for (let i = 0; i < supporting.length; i++) {
    for (let j = i + 1; j < supporting.length; j++) {
      if (supporting[j].at - supporting[i].at >= MIN_POLL_GAP_SECONDS) {
        return {
          confirmed: true,
          since: supporting[i].at,
          evidence: [supporting[i].snapshotHash, supporting[j].snapshotHash],
        }
      }
    }
  }
  return { confirmed: false, evidence: [] }
}

/**
 * Transfer state from the whole observation history. `reverted` only shows
 * against what the registry showed before, and a reversal is how one side ends
 * up with both the money and the domain.
 */
export function deriveTransferState(params: {
  observations: readonly Observation[]
  commitment: TransferCommitment
  now: number
}): TransferVerdict {
  const observations = [...params.observations].sort((a, b) => a.at - b.at)

  if (observations.length === 0) {
    return { state: 'unknown', confirmed: false, evidence: [], reason: 'the registry has not been polled yet' }
  }

  const transferred = confirm(observations, params.commitment, 'transferred')

  // Reversal: confirmed transferred once, and the latest polls no longer match.
  // This is what the arbiter is for.
  if (transferred.confirmed) {
    const after = observations.filter((o) => o.at > (transferred.since as number))
    const latest = after.slice(-REQUIRED_AGREEING_POLLS)
    const movedBack =
      latest.length >= REQUIRED_AGREEING_POLLS &&
      latest.every((o) => classify(o, params.commitment) !== 'transferred') &&
      (latest[latest.length - 1].at - latest[0].at) >= MIN_POLL_GAP_SECONDS

    if (movedBack) {
      return {
        state: 'reverted',
        confirmed: true,
        since: latest[0].at,
        evidence: latest.map((o) => o.snapshotHash),
        reason:
          'the registry showed the transfer completed and now does not: the name moved back. ' +
          'This is a dispute, not a failure: the buyer may hold both the domain and a claim on the money.',
      }
    }

    return {
      state: 'transferred',
      confirmed: true,
      since: transferred.since,
      evidence: transferred.evidence,
      reason: 'the registry shows the name where the buyer committed to receive it',
    }
  }

  for (const [state, reason] of [
    ['pending', 'a transfer is underway; this is the point of no return'],
    ['unlocked', 'the transfer lock is off, so the name can be transferred'],
    ['locked', 'clientTransferProhibited is present, so the name cannot move yet'],
  ] as const) {
    const result = confirm(observations, params.commitment, state)
    if (result.confirmed) return { state, confirmed: true, since: result.since, evidence: result.evidence, reason }
  }

  // Seen, but not confirmed. Report the last poll without acting on it.
  const latest = classify(observations[observations.length - 1], params.commitment)
  return {
    state: 'unknown',
    confirmed: false,
    evidence: observations.map((o) => o.snapshotHash),
    reason:
      `the last poll suggests "${latest}", but ${REQUIRED_AGREEING_POLLS} agreeing polls at least ` +
      `${MIN_POLL_GAP_SECONDS / 60} minutes apart are required before anything moves on it`,
  }
}

/**
 * Registry allows a transfer now (unlocked or pending). Needed for funding but
 * not enough, see {@link fundable}.
 */
export function transferAllowed(verdict: TransferVerdict): boolean {
  return verdict.confirmed && (verdict.state === 'unlocked' || verdict.state === 'pending')
}

/**
 * Whether the registry has shown the registrant act, not just a state.
 *
 * A DNS TXT record only proves zone control, which a host, an agency or an
 * ex-employee can have without registrar access. Changing the transfer lock is
 * an act only the account holder can do, and it's public.
 *
 * "Unlocked" alone isn't that act, since many registrars never set the lock.
 * So we need a confirmed lock, then a confirmed unlock from readings after it,
 * and the latest reading not locked again. A seller whose name is already
 * unlocked has to lock and unlock it. Returns the four snapshot hashes for a
 * ruling to cite.
 */
export function registrantActed(params: {
  observations: readonly Observation[]
  commitment: TransferCommitment
}): { acted: boolean; lockedAt?: number; unlockedAt?: number; evidence: string[]; reason: string } {
  const sorted = [...params.observations].sort((a, b) => a.at - b.at)
  const states = sorted.map((o) => classify(o, params.commitment))
  const open = (s: TransferState) => s === 'unlocked' || s === 'pending'

  // Earliest confirmed lock.
  let lockedAt: number | undefined
  let lockEvidence: string[] = []
  search: for (let i = 0; i < sorted.length; i++) {
    if (states[i] !== 'locked') continue
    for (let j = i + 1; j < sorted.length; j++) {
      if (states[j] === 'locked' && sorted[j].at - sorted[i].at >= MIN_POLL_GAP_SECONDS) {
        lockedAt = sorted[j].at
        lockEvidence = [sorted[i].snapshotHash, sorted[j].snapshotHash]
        break search
      }
    }
  }
  if (lockedAt === undefined) {
    return {
      acted: false,
      evidence: [],
      reason:
        `the registry has not yet been seen with the transfer lock on ` +
        `(${REQUIRED_AGREEING_POLLS} readings at least ${MIN_POLL_GAP_SECONDS / 60} minutes apart)`,
    }
  }

  const latestLocked = states[states.length - 1] === 'locked'
  for (let k = 0; k < sorted.length && !latestLocked; k++) {
    if (sorted[k].at <= lockedAt || !open(states[k])) continue
    for (let l = k + 1; l < sorted.length; l++) {
      if (open(states[l]) && sorted[l].at - sorted[k].at >= MIN_POLL_GAP_SECONDS) {
        return {
          acted: true,
          lockedAt,
          unlockedAt: sorted[k].at,
          evidence: [...lockEvidence, sorted[k].snapshotHash, sorted[l].snapshotHash],
          reason: 'the registry showed the transfer lock on, then off: a change only the registrant can make',
        }
      }
    }
  }
  return {
    acted: false,
    lockedAt,
    evidence: lockEvidence,
    reason: latestLocked
      ? 'the registry shows the transfer lock on; it has to be seen off before anything is paid'
      : `the lock has been seen on; it has not yet been seen off in ${REQUIRED_AGREEING_POLLS} readings ` +
        `at least ${MIN_POLL_GAP_SECONDS / 60} minutes apart`,
  }
}

/**
 * Fundable only when confirmed unlocked and {@link registrantActed}. Unlocked
 * alone would let someone with the zone but not the registrar account (a DNS
 * host, an ex-employee) take a buyer's money for a domain they can't hand over.
 *
 * Not while pending either. The buyer starts the transfer after paying, so one
 * already in flight means somebody else is moving the name.
 */
export function fundable(params: {
  verdict: TransferVerdict
  observations: readonly Observation[]
  commitment: TransferCommitment
}): boolean {
  return params.verdict.confirmed && params.verdict.state === 'unlocked' && registrantActed(params).acted
}

/**
 * Release only on a confirmed, un-reverted transfer to the committed
 * fingerprint. `pending` isn't enough, since a transfer in flight can still
 * fail, be rejected or be reversed.
 */
export function releasable(verdict: TransferVerdict): boolean {
  return verdict.confirmed && verdict.state === 'transferred'
}

/**
 * Commitment from an RDAP snapshot of the buyer's own domain, or typed values.
 * Needs at least one field. With neither, release could never happen and the
 * escrow would be a trap.
 */
export function buildCommitment(params: {
  registrarIanaId?: string
  nameservers?: readonly string[]
  committedAt: number
}): TransferCommitment {
  const nameservers = [...(params.nameservers ?? [])]
    .map((n) => n.trim().toLowerCase().replace(/\.$/, ''))
    .filter((n) => n !== '')
    .sort()

  if (!params.registrarIanaId && nameservers.length === 0) {
    throw new Error(
      'buildCommitment: a commitment needs a registrar IANA id or at least one nameserver; ' +
        'without one the transfer could never be shown to have completed',
    )
  }
  return { registrarIanaId: params.registrarIanaId, nameservers, committedAt: params.committedAt }
}

/**
 * A failed fetch must never be recorded as a negative observation. It would
 * look like a vanished lock or a reverted transfer.
 */
export function usable(observation: { facts?: RdapFacts; snapshotHash?: string }): boolean {
  return Boolean(observation.facts && observation.snapshotHash)
}
