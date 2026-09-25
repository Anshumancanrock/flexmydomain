/* Deployment config, the only site-specific file in web/.
 * Every value is optional. A blank one turns its feature off with a notice.
 */
export const CONFIG = {
  /* Escrow network: "signet" | "testnet" | "mainnet" | "regtest".
   * Keep signet until the escrow is independently audited. Mainnet is real money. */
  network: "signet",

  /* Esplora API base URL. The browser calls it, so it needs CORS.
   * Blank uses the network's default. */
  chainApiBase: "",

  /* Lightning address with NIP-57 zaps enabled, for flex payments. Blank turns payments off. */
  featuredLightningAddress: "",

  /* Your own pubkey that receives those zaps, x-only hex. Never copy it from a
   * receipt, since the provider signs for all its users. Blank counts nothing. */
  featuredRecipientPubkey: "",

  /* Default escrow arbiter, x-only hex. Leave blank if you won't referee disputes. */
  arbiterPubkey: "",

  /* Trusted attestation verifiers (x-only hex) and how many must agree
   * (spec/PROTOCOL.md). Empty shows none. Our own DNS check always runs. */
  verifiers: [],
  verifierThreshold: 2,

  /* Extra relays to read and publish, beside the defaults, e.g. ["wss://relay.example.com"].
   * services/relay/ is a ready-made one. Add it once
   * `bun run relay:check wss://your.relay --mine` passes. */
  extraRelays: [],

  /* Footer link URLs. A blank one is hidden. */
  socials: {
    x: "",
    discord: "",
    github: "",
  },
};

/* Needs both, or we could take a payment we can't verify. */
export const featuringEnabled = () =>
  CONFIG.featuredLightningAddress.trim() !== "" &&
  /^[0-9a-f]{64}$/.test(CONFIG.featuredRecipientPubkey.trim());
