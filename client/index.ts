/**
 * The browser bundle: everything a page in web/ needs, in one module.
 *
 * `bun run build` bundles it to `web/assets/fmd.js`. Page scripts get all
 * library code from that file, with no CDN and no framework.
 *
 *   core/oracle   the proof format, normalisation, RDAP eligibility
 *   core/nostr    events, NIP-19, the listing, the portfolio
 *   core/escrow   the taproot escrow, its spends, the transfer rules
 *   net/          DoH, RDAP, relays, chain data, LNURL: all network access
 *   client/       signers and private-message helpers
 *
 * There is no backend: every user-facing feature runs from static files with
 * every server of ours switched off.
 */

export * from '../core/oracle/index.js'
export * from '../core/nostr/index.js'

/* core/escrow is exported by name rather than with a star. When two star
   exports share a name, ES modules drop that name without an error, and
   escrow's generic helpers (taggedHash, compareBytes) are the likeliest to
   collide. */
export {
  addressToScript,
  buildCommitment,
  buildSpend,
  buildTree,
  decodeAddress,
  decodeRecovery,
  deriveTransferState,
  describeTree,
  encodeRecovery,
  escrowPublicKey,
  escrowPublicKeyHex,
  feeOf,
  finaliseSpend,
  fundable,
  registrantActed,
  transferAllowed,
  rebuildFromRecovery,
  releasable,
  serializeSigned,
  sighashFor,
  signSpend,
  spendWith,
  txid,
  verifySpendSignature,
  vsize,
  MIN_POLL_GAP_SECONDS,
  NETWORK_HRP,
  RECOVERY_PREFIX,
  REQUIRED_AGREEING_POLLS,
} from '../core/escrow/index.js'
export type {
  EscrowLeaf,
  EscrowOutpoint,
  EscrowTree,
  NetworkName,
  Observation,
  Recovery,
  SpendDestination,
  TransferCommitment,
  TransferState,
  TransferVerdict,
  Tx,
} from '../core/escrow/index.js'

export { DOH_PROVIDERS, fetchNip05, lookupTxt, lookupTxtVia, unquoteTxt } from '../net/dns.js'
export type { DohObservation, TxtLookup } from '../net/dns.js'

export {
  RDAP_BOOTSTRAP_URL as RDAP_BOOTSTRAP_ENDPOINT,
  clearBootstrapCache,
  fetchRdapBootstrap,
  fetchRdapDomain,
  fetchRdapDomainAt,
} from '../net/rdap.js'
export type { RdapSnapshot } from '../net/rdap.js'

export {
  countOnRelay,
  countOnRelays,
  fetchRelayInfo,
  newestPerAddress,
  publishToRelay,
  publishToRelays,
  queryRelay,
  queryRelays,
} from '../net/relay.js'
export type { Filter, PublishResult, QueryOptions } from '../net/relay.js'

export { CHAIN_APIS, EXPLORERS, chainApi, findFunding } from '../net/chain.js'
export type { ChainApi, ChainTx, Utxo } from '../net/chain.js'

export { RelayDirectory, publishOutbox, queryDiscovery, queryOutbox } from '../net/outbox.js'

export {
  clearZapperKeyCache,
  fetchLnurlPay,
  lightningAddressUrl,
  requestZapInvoice,
  zapperKeyFor,
} from '../net/lnurl.js'
export type { LnurlPayInfo } from '../net/lnurl.js'

export { checkDomain, checkDomainProof, checkRegistry } from '../net/verify.js'
export { observe, record } from '../net/transfer.js'
export type { DomainReport, RegistryReport } from '../net/verify.js'

export { canSealWith, readMessages, sealMessage, wrapEntropy } from './messages.js'

export {
  extensionSigner,
  forgetStoredKey,
  generateSecretKey,
  hasExtension,
  hasStoredKey,
  loadKey,
  localSigner,
  storeKey,
  waitForExtension,
} from './signer.js'
