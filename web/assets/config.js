// Deployment config. Every value is optional; a blank one turns its feature off.
export const CONFIG = {
  // "signet" | "testnet" | "mainnet" | "regtest". Stay on signet until the escrow is audited.
  network: "signet",

  // Esplora API base URL (needs CORS). Blank uses the network's default.
  chainApiBase: "",

  // Lightning address with NIP-57 zaps, for flex payments. Its zap key must be yours alone:
  // a shared custodial one signs receipts for all its users.
  featuredLightningAddress: "anshuman@cake.cash",

  // Your pubkey that receives those zaps, x-only hex. Don't copy it from a receipt.
  featuredRecipientPubkey: "e6e9460b961261f71b786bf4274c001869b17e04e1b12e6c1b551e92ea4a81f8",

  // Arbiter public key, npub or hex. Use a key that does nothing else and keep its secret offline.
  arbiterPubkey: "npub1p5t9q3nq26nhkt40fzpumthx0uzy5azgkh560sxfspnlfyua25mq6ucwcj",

  // Trusted attestation verifiers (x-only hex) and how many must agree.
  verifiers: [],
  verifierThreshold: 2,

  // Extra relays beside the defaults. Add one once `bun run relay:check wss://your.relay --mine` passes.
  extraRelays: [],

  // Footer links. Blank ones are hidden.
  socials: {
    x: "",
    discord: "",
    github: "",
  },
};

// needs both, or we could take a payment we can't verify
export const featuringEnabled = () =>
  CONFIG.featuredLightningAddress.trim() !== "" &&
  /^[0-9a-f]{64}$/.test(CONFIG.featuredRecipientPubkey.trim());
