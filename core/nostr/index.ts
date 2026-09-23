/**
 * core/nostr: NIP-01 events, NIP-19 identifiers, NIP-44 and NIP-17
 * encryption, and the builders and parsers for every event this marketplace
 * publishes.
 *
 * Pure: no relays, no fetch, no clock. Connecting, subscribing and publishing
 * live in net/, page code and services/, which take this module's output as
 * their input.
 *
 * Relays hold the data; any database is a cache. Given an event from any
 * relay, this module says whether it is what it claims to be, with no call to
 * a server run by this project.
 *
 *   import { checkEvent, buildListing } from './core/nostr/index.js'
 */

export {
  addressOf,
  checkEvent,
  eventDigest,
  eventId,
  findTag,
  isAddressable,
  isEphemeral,
  isHex32,
  isHex64,
  isReplaceable,
  serializeEvent,
  signEvent,
  tagValue,
  tagValues,
  verifyDigestSignature,
  verifyEvent,
} from './event.js'
export type { NostrEvent, NostrTag, Signer, UnsignedEvent } from './event.js'

export {
  decodeNip19,
  naddrEncode,
  neventEncode,
  noteEncode,
  npubEncode,
  nprofileEncode,
  nsecEncode,
  nostrUri,
  shorten,
  toPubkeyHex,
  tryDecodeNip19,
} from './nip19.js'
export type {
  AddressPointer,
  DecodedNip19,
  EventPointer,
  Nip19Prefix,
  ProfilePointer,
} from './nip19.js'

export {
  LISTING_D_PREFIX,
  LISTING_KIND,
  LISTING_TOPIC,
  PRICE_CURRENCY,
  buildListing,
  checkListing,
  checkListingAgainstZone,
  listingAddress,
  listingFilter,
  parseListing,
} from './listing.js'
export type { Listing, ListingCheck, ListingParams, ListingStatus } from './listing.js'

export {
  ARBITER_SET_D,
  FOLLOW_SET_KIND,
  HANDLER_KIND,
  PROFILE_KIND,
  WATCHLIST_D,
  arbiterIntersection,
  buildArbiterSet,
  buildHandlerAdvertisement,
  buildWatchlist,
  identityProofUrl,
  parseArbiterSet,
  parseProfile,
  parseWatchlist,
  profileFilter,
} from './profile.js'
export type { ExternalIdentity, Profile } from './profile.js'

export {
  JOB_FEEDBACK_KIND,
  VERIFY_REQUEST_KIND,
  VERIFY_RESULT_KIND,
  attestationFilter,
  buildAttestation,
  buildJobFeedback,
  buildVerifyRequest,
  parseAttestation,
  tally,
} from './attestation.js'
export type { Attestation, AttestationParams, AttestationVerdict } from './attestation.js'

export {
  BADGE_AWARD_KIND,
  BADGE_DEFINITION_KIND,
  FMD_BADGES,
  PROFILE_BADGES_D,
  PROFILE_BADGES_KIND,
  buildBadgeAward,
  buildBadgeDefinition,
  buildProfileBadges,
  parseBadgeAward,
  parseBadgeDefinition,
  parseProfileBadges,
  verifiedBadges,
} from './badge.js'
export type { BadgeDefinition } from './badge.js'

export {
  FLEX_TOPIC,
  MSATS_PER_SAT,
  ZAP_RECEIPT_KIND,
  ZAP_REQUEST_KIND,
  bolt11AmountMsats,
  buildZapRequest,
  flexZapFilter,
  rankByZaps,
  rankFlexDomains,
  verifyZapReceipt,
  zapReceiptFilter,
} from './zap.js'
export type { Zap } from './zap.js'

export {
  RECEIPT_KIND,
  RECEIPT_NAMESPACE,
  buildReceipt,
  countsTowardReputation,
  pairReceipts,
  parseReceipt,
  receiptFilter,
  summariseTrades,
} from './receipt.js'
export type { Receipt, ReceiptParams, Trade, TradeOutcome, TradeRecord, TradeRole } from './receipt.js'

export {
  MIN_PLAINTEXT_BYTES,
  MAX_PLAINTEXT_BYTES,
  NIP44_VERSION,
  conversationKey,
  decrypt,
  encrypt,
  paddedLength,
} from './nip44.js'

export {
  CHAT_KIND,
  GIFT_WRAP_KIND,
  MAX_TIMESTAMP_JITTER,
  SEAL_KIND,
  buildRumor,
  giftWrap,
  giftWrapFilter,
  unwrap,
} from './nip17.js'
export type { Rumor, WrapEntropy } from './nip17.js'

export {
  ESCROW_D_PREFIX,
  ESCROW_KIND,
  ESCROW_TOPIC,
  ESCROW_VERSION,
  buildEscrowEvent,
  compareViews,
  deriveEscrowId,
  deriveEscrowState,
  escrowAddress,
  escrowFilter,
  escrowsForFilter,
  parseEscrowEvent,
} from './escrow.js'
export type { Disagreement, EscrowParams, EscrowState, EscrowView } from './escrow.js'

export {
  INVITE_PREFIX,
  REPLY_PREFIX,
  decodeInvite,
  decodeReply,
  encodeInvite,
  encodeReply,
  resolveHandshake,
} from './handshake.js'
export type { Commitment, Invite, Reply } from './handshake.js'

export { DELETION_KIND, applyDeletions, buildDeletion, deletionFilter, parseDeletion } from './deletion.js'

export {
  READ_FANOUT,
  RELAY_LIST_KIND,
  WRITE_FANOUT,
  buildRelayList,
  inboxRelaysFor,
  isOwnRelayList,
  normaliseRelayUrl,
  parseRelayList,
  planAuthorQuery,
  readRelaysFor,
  relayListFilter,
  writeRelaysFor,
} from './relays.js'
export type { RelayEntry } from './relays.js'

export {
  PORTFOLIO_D,
  PORTFOLIO_KIND,
  PORTFOLIO_TOPIC,
  PORTFOLIO_VERSION,
  buildPortfolio,
  parsePortfolio,
  portfolioFilter,
  removeEntry,
  upsertEntry,
  verifyPortfolio,
} from './portfolio.js'
export type { EntryVerification, Portfolio, PortfolioEntry } from './portfolio.js'

/**
 * The default relay set.
 *
 * It lives in code rather than a config file so anyone can rebuild the
 * marketplace from this repository alone. These five relays hold the data,
 * and none of them is run by this project.
 *
 * It is only a fallback. Under NIP-65 a user's own write relays take
 * precedence for their events (relays.ts): where a seller publishes is the
 * seller's decision.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
] as const

/*
 * Each relay here was checked before it was added: a websocket query returns
 * events, it serves a NIP-11 document, and that document declares no
 * restricted writes, required auth or payment.
 *
 * `wss://relay.nostr.band` is left out on purpose. It is a search aggregator:
 * it serves no NIP-11 document, and a plain kind 1 query returned nothing in
 * nine seconds, so it cannot be relied on to hold a seller's inventory.
 */
