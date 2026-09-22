/**
 * Following a domain transfer through public RDAP observations, with no
 * registrar integration. The parties move the name themselves (the seller
 * unlocks it and sends the auth code, the buyer pulls it to their own
 * registrar), and this module only reads what the registry shows. Holding
 * registrar API keys or a reseller account instead would make the site the
 * domain's custodian. See spec/PROTOCOL.md.
 *
 * No fetch and no clock: every function takes the observations and the time
 * as arguments, so a verdict can be reproduced from its evidence months later,
 * in a dispute.
 *
 * What is watched for, in order:
 *
 *   lock on, then off  only the registrant can change it. Gates funding.
 *   pendingTransfer    the transfer is underway: the point of no return.
 *   fingerprint moved  the registry agrees the name is somewhere new.
 *
 * No state changes on one observation. RDAP is cached, registries lag by
 * hours, and a failed fetch is not evidence, so a change needs two agreeing
 * polls at least thirty minutes apart.
 */

import { fingerprintMatches, type Fingerprint, type RdapFacts } from '../oracle/rdap.js'
import { PENDING_TRANSFER_STATUS, TRANSFER_LOCK_STATUS } from '../oracle/rdap.js'

/**
 * How far apart two observations must be to count as independent. Any closer
 * and both are likely the same cached answer read twice.
 */
export const MIN_POLL_GAP_SECONDS = 1800

/** How many agreeing observations a state change needs. */
export const REQUIRED_AGREEING_POLLS = 2

/**
 * What the buyer commits to before any money moves.
 *
 * Post-GDPR, RDAP redacts the registrant almost everywhere: it shows that a
 * name moved and to which registrar, never to whom. So the buyer states in
 * advance where they will receive it, and "the transfer completed" means "the
 * registry now shows what the buyer committed to". Without this the release
 * condition could not be checked.
 *
 * Two fields, because either alone has a hole: a transfer between registrars
 * changes the IANA id, but a push inside one registrar does not change it at
 * all, and then only the nameservers move.
 */
export interface TransferCommitment extends Fingerprint {
  committedAt: number
}

/** One dated RDAP poll. The hash is what goes in the escrow event. */
export interface Observation {
  at: number
  /** sha256 of the raw response bytes, as received. */
  snapshotHash: string
  facts: RdapFacts
}

export type TransferState =
  /** `clientTransferProhibited` present. Only the registrant can clear it. */
  | 'locked'
  /**
   * No lock: the name can move. On its own this says nothing about who holds
   * it; many registrars never set the lock at all. See {@link registrantActed}.
   */
  | 'unlocked'
  /** `pendingTransfer` seen. The point of no return. */
  | 'pending'
  /** The registry shows what the buyer committed to. */
  | 'transferred'
  /** It was transferred, and then moved back. A registrar reversal. */
  | 'reverted'
  /** Not enough agreeing observations to say anything yet. */
  | 'unknown'

export interface TransferVerdict {
  state: TransferState
  /** True when REQUIRED_AGREEING_POLLS agreed, far enough apart. */
  confirmed: boolean
  /** When the earliest of the agreeing observations was taken. */
  since?: number
  /** The snapshot hashes that justify this verdict. The evidence file. */
  evidence: string[]
  /** Why the state is what it is, in words, for the UI and for a ruling. */
  reason: string
}

/** Which state one observation supports. */
function classify(observation: Observation, commitment: TransferCommitment): TransferState {
  const { facts } = observation

  // Checked first: a completed transfer is still "transferred" even if the
  // new registrar immediately re-locks the name, which most of them do.
  if (fingerprintMatches({ registrarIanaId: facts.registrarIanaId, nameservers: facts.nameservers }, commitment)) {
    return 'transferred'
  }
  if (facts.statuses.includes(PENDING_TRANSFER_STATUS)) return 'pending'
  if (facts.statuses.includes(TRANSFER_LOCK_STATUS)) return 'locked'
  return 'unlocked'
}

/**
 * The two-poll rule.
 *
 * Whether `state` is supported by REQUIRED_AGREEING_POLLS observations at
 * least MIN_POLL_GAP_SECONDS apart. Observations that disagree do not average
 * out: they confirm nothing, and the previous confirmed state stands.
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

  // Walk forward for the earliest pair far enough apart. Any later pair also
  // qualifies, so the earliest gives the most accurate `since`.
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
 * Where the transfer has got to, from the whole observation history.
 *
 * The whole history is required: `reverted` is only visible by comparing what
 * the registry shows now against what it showed before, and a reversal is the
 * case where one side can end up with both the money and the domain.
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

  // A reversal: confirmed transferred at some point, and the most recent
  // observations no longer match. This is the case the arbiter exists for.
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

  // Something was seen, but not twice far enough apart. Report what the last
  // poll suggests without acting on it.
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
 * Whether the registry allows a transfer right now: unlocked, or already
 * moving. Necessary for funding but not sufficient; see {@link fundable}.
 */
export function transferAllowed(verdict: TransferVerdict): boolean {
  return verdict.confirmed && (verdict.state === 'unlocked' || verdict.state === 'pending')
}

/**
 * Whether the registry has shown the registrant act, not just a state.
 *
 * A DNS TXT record proves control of the zone, which a hosting provider, an
 * agency or a former employee can have with no registrar access at all.
 * Registrar control is shown by an act only the account holder can perform,
 * observed in public: changing the transfer lock.
 *
 * "Unlocked" on its own is not that act. Many registrars never set the lock,
 * so a name can read unlocked whoever lists it. So the registry must be seen
 * locked (confirmed by the two-poll rule) and then unlocked (confirmed again,
 * by readings taken after the lock was confirmed), and the latest reading must
 * not show the lock back on. A seller whose domain is already unlocked has to
 * turn the lock on and off again.
 *
 * The four snapshot hashes that show it are returned, so a ruling can cite them.
 */
export function registrantActed(params: {
  observations: readonly Observation[]
  commitment: TransferCommitment
}): { acted: boolean; lockedAt?: number; unlockedAt?: number; evidence: string[]; reason: string } {
  const sorted = [...params.observations].sort((a, b) => a.at - b.at)
  const states = sorted.map((o) => classify(o, params.commitment))
  const open = (s: TransferState) => s === 'unlocked' || s === 'pending'

  // The earliest confirmed lock: two locked readings far enough apart.
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
 * Whether the escrow may be funded: only when the name is confirmed unlocked
 * and the registry has shown the registrant act ({@link registrantActed}).
 * Unlocked alone would let a seller who controls the zone but not the
 * registrar account (a DNS host, a former employee) take a buyer's money for a
 * domain they cannot hand over.
 *
 * A transfer already pending is not fundable either. The buyer starts the
 * transfer after paying, with the auth code the seller sends, so one in flight
 * before the money is in means somebody else is moving the name.
 */
export function fundable(params: {
  verdict: TransferVerdict
  observations: readonly Observation[]
  commitment: TransferCommitment
}): boolean {
  return params.verdict.confirmed && params.verdict.state === 'unlocked' && registrantActed(params).acted
}

/**
 * Whether the seller may be paid: only on a confirmed, un-reverted transfer to
 * the committed fingerprint. `pending` is not enough. A transfer in flight can
 * still fail, be rejected or be reversed, and paying on `pending` could pay
 * for a domain that never arrives.
 */
export function releasable(verdict: TransferVerdict): boolean {
  return verdict.confirmed && verdict.state === 'transferred'
}

/**
 * Build the commitment from an RDAP snapshot of the buyer's own domain, or
 * from values they type.
 *
 * At least one field must be present. With neither, the release condition
 * could never be satisfied and the escrow would be a trap, so an empty
 * commitment throws.
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
 * Whether an observation is usable at all. A failed fetch must never be
 * recorded as a negative observation: it would look like a vanished lock or a
 * reverted transfer.
 */
export function usable(observation: { facts?: RdapFacts; snapshotHash?: string }): boolean {
  return Boolean(observation.facts && observation.snapshotHash)
}
