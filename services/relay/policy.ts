/**
 * What a flexmydomain relay stores: the rules behind its strfry write policy.
 *
 * Pure: an event in, a decision out, with no clock, network or state. The rate
 * limiter lives in write-policy.ts, the process strfry talks to.
 *
 * The relay stores what this project publishes, in the shape it publishes it,
 * and refuses the rest. An open relay draws spam and fills its disk with
 * things that have nothing to do with selling domains, and this one is
 * optional (the site works with it switched off), so it carries nothing the
 * site does not read.
 *
 * Where core/ has a parser for a kind, the policy uses it rather than a looser
 * copy. A listing whose embedded proof does not verify, or an escrow view
 * whose stated address its own keys do not produce, is refused on write
 * instead of being filtered out by every reader later.
 *
 * The policy does not check:
 *   - the event signature: strfry verifies it before consulting the plugin;
 *   - DNS: a listing's zone check needs the network, and a write path must not
 *     wait on a resolver. Readers still resolve the record themselves;
 *   - zap receipts against the zapper's LNURL key, for the same reason. The
 *     board verifies each receipt against the provider's published key.
 */

import { tagValue, tagValues, type NostrEvent } from '../../core/nostr/event.js'
import { LISTING_D_PREFIX, LISTING_KIND, LISTING_TOPIC, checkListing } from '../../core/nostr/listing.js'
import { PORTFOLIO_D, parsePortfolio } from '../../core/nostr/portfolio.js'
import { ESCROW_D_PREFIX, parseEscrowEvent } from '../../core/nostr/escrow.js'
import { DELETION_KIND } from '../../core/nostr/deletion.js'
import { RECEIPT_KIND, RECEIPT_NAMESPACE, parseReceipt } from '../../core/nostr/receipt.js'
import {
  JOB_FEEDBACK_KIND,
  VERIFY_REQUEST_KIND,
  VERIFY_RESULT_KIND,
  parseAttestation,
} from '../../core/nostr/attestation.js'
import {
  BADGE_AWARD_KIND,
  BADGE_DEFINITION_KIND,
  PROFILE_BADGES_D,
  PROFILE_BADGES_KIND,
} from '../../core/nostr/badge.js'
import { ARBITER_SET_D, FOLLOW_SET_KIND, HANDLER_KIND, WATCHLIST_D } from '../../core/nostr/profile.js'
import { RELAY_LIST_KIND } from '../../core/nostr/relays.js'
import { FLEX_TOPIC, ZAP_RECEIPT_KIND, ZAP_REQUEST_KIND } from '../../core/nostr/zap.js'
import { GIFT_WRAP_KIND } from '../../core/nostr/nip17.js'
import { PROOF_D_PREFIX, PROOF_KIND, proofFromEvent } from '../../core/oracle/proof.js'

export type Decision = { action: 'accept' } | { action: 'reject'; msg: string }

export interface PolicyOptions {
  /**
   * The flex board's zap recipient, x-only hex (web/assets/config.js,
   * `featuredRecipientPubkey`). When set, only receipts paid to it are kept;
   * when unset, any receipt for a flexmydomain zap request is.
   */
  flexRecipient?: string
  /**
   * Verifier keys whose NIP-90 job feedback (kind 7000) is kept. Feedback
   * carries nothing that ties it to this project, so it is taken only from
   * verifiers the operator names.
   */
  verifiers?: readonly string[]
  /**
   * Gift wraps (kind 1059). Refused by default: no page reads them yet, and a
   * relay that stores wraps for any recipient is a general DM store whose
   * contents it cannot inspect. Turn this on together with the private-channel
   * UI, and with NIP-42-gated reads (strfry's `restrictedReadKinds`, which the
   * 1.1.x releases do not have yet).
   */
  acceptGiftWraps?: boolean
}

const accept: Decision = { action: 'accept' }
const reject = (why: string): Decision => ({ action: 'reject', msg: `blocked: ${why}` })

const OUR_BADGE_PREFIX = 'fmd-'
const HANDLER_D = 'fmd-client'

export const OFF_TOPIC = 'this relay stores flexmydomain events only'

export function decide(event: NostrEvent, options: PolicyOptions = {}): Decision {
  switch (event.kind) {
    case LISTING_KIND:
      return decideListing(event)
    case PROOF_KIND: // 30078: proofs, portfolios, escrow views
      return decideAppData(event)
    case DELETION_KIND:
      return decideDeletion(event)
    case ZAP_RECEIPT_KIND:
      return decideZapReceipt(event, options)
    case RELAY_LIST_KIND:
      return decideRelayList(event)
    case FOLLOW_SET_KIND: {
      const d = tagValue(event, 'd')
      return d === ARBITER_SET_D || d === WATCHLIST_D ? accept : reject(OFF_TOPIC)
    }
    case HANDLER_KIND:
      return tagValue(event, 'd') === HANDLER_D ? accept : reject(OFF_TOPIC)
    case RECEIPT_KIND:
      if (!tagValues(event, 'L').includes(RECEIPT_NAMESPACE)) return reject(OFF_TOPIC)
      return parseReceipt(event).ok ? accept : reject('not a well-formed flexmydomain trade receipt')
    case VERIFY_REQUEST_KIND:
      return isVerifyRequest(event) ? accept : reject(OFF_TOPIC)
    case VERIFY_RESULT_KIND:
      if (!tagValues(event, 't').includes(FLEX_TOPIC)) return reject(OFF_TOPIC)
      return parseAttestation(event).ok ? accept : reject('not a well-formed flexmydomain attestation')
    case JOB_FEEDBACK_KIND:
      return options.verifiers?.includes(event.pubkey) ? accept : reject(OFF_TOPIC)
    case BADGE_DEFINITION_KIND:
      return (tagValue(event, 'd') ?? '').startsWith(OUR_BADGE_PREFIX) ? accept : reject(OFF_TOPIC)
    case BADGE_AWARD_KIND:
      return namesOurBadge(event) ? accept : reject(OFF_TOPIC)
    case PROFILE_BADGES_KIND:
      return tagValue(event, 'd') === PROFILE_BADGES_D && namesOurBadge(event) ? accept : reject(OFF_TOPIC)
    case GIFT_WRAP_KIND:
      if (!options.acceptGiftWraps) return reject('private messages are not stored here yet')
      return tagValues(event, 'p').length === 1 ? accept : reject('a gift wrap names exactly one recipient')
    default:
      return reject(OFF_TOPIC)
  }
}

/* A listing must carry the flexmydomain topic and a proof that verifies for
   its own key. Readers apply the same rule (spec/PROTOCOL.md); the relay
   applies it once, on write. */
function decideListing(event: NostrEvent): Decision {
  if (!tagValues(event, 't').includes(LISTING_TOPIC)) return reject(OFF_TOPIC)
  const check = checkListing({ event })
  if (!check.selfConsistent) {
    return reject(`a listing must carry a domain proof signed by its own key (${check.reason ?? 'no proof'})`)
  }
  return accept
}

/* Kind 30078 is shared by every application on nostr (NIP-78). Only our three
   `d` namespaces are stored, and each must parse the way readers parse it. */
function decideAppData(event: NostrEvent): Decision {
  const d = tagValue(event, 'd') ?? ''
  if (d.startsWith(PROOF_D_PREFIX)) {
    const proof = proofFromEvent(event)
    return proof.ok ? accept : reject(`not a valid domain proof (${proof.reason})`)
  }
  if (d === PORTFOLIO_D) {
    const portfolio = parsePortfolio(event)
    return portfolio.ok ? accept : reject(`not a valid portfolio (${portfolio.reason})`)
  }
  if (d.startsWith(ESCROW_D_PREFIX)) {
    const view = parseEscrowEvent(event)
    return view.ok ? accept : reject(`not a valid escrow view (${view.reason})`)
  }
  return reject(OFF_TOPIC)
}

/* A deletion is kept when it can remove something this relay stores: one of
   its `a` coordinates names an address this project publishes. The site
   deletes by address (a listing, when it is delisted). A deletion that names
   only other apps' addresses, or only event ids, is refused: it names nothing
   this relay could hold, and the apps that share kinds 30402 and 30078 publish
   such deletions by the hundred. strfry itself refuses a deletion of somebody
   else's event. */
function decideDeletion(event: NostrEvent): Decision {
  return tagValues(event, 'a').some(isOurAddress) ? accept : reject(OFF_TOPIC)
}

/** Whether `<kind>:<pubkey>:<d>` is an address this project publishes. The d
    tag can itself contain colons (`fmd:listing:example.com`). */
export function isOurAddress(coordinate: string): boolean {
  const [kind, pubkey, ...rest] = coordinate.split(':')
  if (!/^\d+$/.test(kind ?? '') || !/^[0-9a-f]{64}$/.test(pubkey ?? '') || rest.length === 0) return false
  const d = rest.join(':')
  switch (Number(kind)) {
    case LISTING_KIND:
      return d.startsWith(LISTING_D_PREFIX)
    case PROOF_KIND: // proofs, the portfolio and escrow views are all kind 30078
      return d.startsWith(PROOF_D_PREFIX) || d === PORTFOLIO_D || d.startsWith(ESCROW_D_PREFIX)
    case FOLLOW_SET_KIND:
      return d === ARBITER_SET_D || d === WATCHLIST_D
    case BADGE_DEFINITION_KIND:
      return d.startsWith(OUR_BADGE_PREFIX)
    case HANDLER_KIND:
      return d === HANDLER_D
    default:
      return false
  }
}

/* A receipt is ours when the zap request inside it is. The payer signs the
   request, which carries the flex tags; the zapper service writes the receipt
   and copies no custom tags into it. */
function decideZapReceipt(event: NostrEvent, options: PolicyOptions): Decision {
  if (options.flexRecipient && tagValue(event, 'p') !== options.flexRecipient) return reject(OFF_TOPIC)
  let request: { kind?: unknown; tags?: unknown } | undefined
  try {
    request = JSON.parse(tagValue(event, 'description') ?? '')
  } catch {
    return reject('a zap receipt must carry its zap request')
  }
  if (!request || request.kind !== ZAP_REQUEST_KIND || !Array.isArray(request.tags)) {
    return reject('a zap receipt must carry its zap request')
  }
  const tags = request.tags as unknown[][]
  const ours = tags.some((t) => Array.isArray(t) && (t[0] === 'fmd_flex' || (t[0] === 't' && t[1] === FLEX_TOPIC)))
  return ours ? accept : reject(OFF_TOPIC)
}

/* NIP-65 relay lists. The site publishes them (flex.js), and the outbox model
   reads them to route a user's events. Anyone can mint a key and a list, so a
   list is bounded. Profiles (kind 0) are not stored at all: the site never
   publishes one, they are all on the public relays, and an unverifiable 64 KB
   document from any fresh key is the cheapest way to fill this relay's disk. */
export const MAX_RELAY_LIST_ENTRIES = 50

function decideRelayList(event: NostrEvent): Decision {
  const relays = event.tags.filter((t) => t[0] === 'r')
  if (relays.length > MAX_RELAY_LIST_ENTRIES || event.tags.length > 2 * MAX_RELAY_LIST_ENTRIES) {
    return reject(`a relay list names at most ${MAX_RELAY_LIST_ENTRIES} relays`)
  }
  if (!relays.every((t) => /^wss?:\/\/[^\s]{1,250}$/.test(t[1] ?? ''))) {
    return reject('a relay list names relays by ws:// or wss:// URL')
  }
  if (event.content.length > 1024) return reject('a relay list carries no content (NIP-65)')
  return accept
}

/* NIP-90 inputs as buildVerifyRequest writes them: one domain, one claimant. */
function isVerifyRequest(event: NostrEvent): boolean {
  const inputs = event.tags.filter((t) => t[0] === 'i')
  return inputs.some((t) => t[4] === 'domain') && inputs.some((t) => t[4] === 'claimant')
}

function namesOurBadge(event: NostrEvent): boolean {
  return tagValues(event, 'a').some((a) => {
    const [kind, , slug] = a.split(':')
    return Number(kind) === BADGE_DEFINITION_KIND && (slug ?? '').startsWith(OUR_BADGE_PREFIX)
  })
}
