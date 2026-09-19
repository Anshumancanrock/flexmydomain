/* Deployment configuration.
 *
 * The only file in web/ that holds values specific to whoever runs this
 * marketplace. Everything else works the same for anybody who clones the
 * repository: a fork that changes this file runs its own market against the
 * same relays and the same protocol.
 *
 * Every value is optional. When one is blank, the feature that needs it says
 * so instead of failing, so a fresh clone runs as it is.
 */
export const CONFIG = {
  /* Which Bitcoin network this deployment escrows on:
   * "signet" | "testnet" | "mainnet" | "regtest".
   *
   * Signet is the default and should stay the default until the escrow has
   * been audited by someone other than its own tests. Its faucets work, its
   * blocks are regular, and it is not periodically reorged the way testnet
   * is. The escrow derives an address for every network from the same three
   * keys, so moving to mainnet is a one-word change, and an easy one to make
   * by mistake. */
  network: "signet",

  /* The chain API. Any Esplora instance works, including one you run. The
   * default is mempool.space, the explorer most people already use. It is
   * read-only apart from broadcast, needs no key and serves
   * Access-Control-Allow-Origin: *, so the page calls it directly with no
   * backend of ours in between.
   *
   * Blank means "use the default for the network above". */
  chainApiBase: "",

  /* Where featured-spot zaps are sent (NIP-57).
   *
   * A lightning address with Nostr zaps enabled; an Alby or LNbits address
   * works. Left blank, the pages still load: the board shows no ranking, and
   * the Feature button explains that payments are not switched on here
   * instead of producing an invoice nobody can pay.
   *
   * The site holds no funds and runs no payment infrastructure; this is only
   * a lightning address. */
  featuredLightningAddress: "",

  /* The Nostr pubkey that receives those zaps: x-only hex, this deployment's
   * own key.
   *
   * It cannot be discovered and must not be guessed. A zapper service signs
   * receipts for all of its users, so taking the recipient from a receipt the
   * provider signed picks an arbitrary stranger. An attacker whose receipt was
   * picked could then climb the ranking by zapping themselves.
   *
   * Blank means featured zaps are not counted at all. That is the safe
   * default: a ranking nobody can verify is worse than none. */
  featuredRecipientPubkey: "",

  /* The arbiter offered by default when opening an escrow.
   *
   * An x-only pubkey, or blank. Blank is a valid setting: the no-arbiter
   * escrow is a two-leaf tree between buyer and seller alone, and a
   * deployment that referees nothing should leave this empty rather than
   * nominate itself. */
  arbiterPubkey: "",

  /* Verifiers whose attestations this deployment shows, and how many must
   * agree (spec/PROTOCOL.md describes the attestation).
   *
   * Which verifiers to trust is the operator's choice, so this is a list of
   * x-only pubkeys and a threshold. An attestation from a key not on the list
   * is ignored, not weighed.
   *
   * An attestation never replaces the page's own DNS lookup, which always
   * runs; attestations are a second opinion shown beside it. Empty means none
   * are shown. */
  verifiers: [],
  verifierThreshold: 2,

  /* Extra relays this deployment publishes to and reads from, in addition to
   * the defaults and a user's own NIP-65 write relays and never in place of
   * them: where a user's events live is the user's decision (spec/PROTOCOL.md).
   *
   * services/relay/ is a ready-made one: strfry, storing flexmydomain events
   * only and mirroring them from the public relays. Once it is deployed and
   * `bun run relay:check wss://your.relay --mine` passes, add it here, for
   * example ["wss://relay.example.com"]. Everything keeps working without it. */
  extraRelays: [],

  /* The footer's social links. A blank one is hidden rather than shown as a
   * button that goes nowhere. */
  socials: {
    x: "",
    discord: "",
    github: "",
  },
};

/* Both are required. The address is where a zap is paid; the pubkey is who it
   must be paid to for its receipt to count. With only one of them, the page
   could take a payment it could not then verify. */
export const featuringEnabled = () =>
  CONFIG.featuredLightningAddress.trim() !== "" &&
  /^[0-9a-f]{64}$/.test(CONFIG.featuredRecipientPubkey.trim());
