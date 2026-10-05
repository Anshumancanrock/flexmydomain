# FlexMyDomain

**Buy and sell domains with no middleman.**

Listings live on Nostr. Ownership is proved with a DNS record. Funds sit in a Bitcoin escrow that no single party can control—including us. No accounts. No commission. No backend.

**Live:** [flexmydomain.com](https://flexmydomain-neon.vercel.app)
(The escrow and the flex board currently run on Bitcoin signet.)

## The problem

Selling a domain to a stranger is a trust problem, and the current solutions are painful for most people.

- Marketplaces take 5–20% of the sale price, with escrow fees on top. Many lower-value names are simply not worth listing.
- Someone must go first. If the buyer pays first, the seller can disappear with the money. If the seller transfers first, the buyer can vanish. The usual answer is a middleman who holds the funds while both parties wait.
- Most platforms let anyone list a domain they do not own. Buyers often discover this only after payment.
- Listings, history, and funds live inside someone else’s account system—subject to fee changes, frozen payouts, or sudden shutdowns.

FlexMyDomain removes the middleman from each of these points using tools that already exist: DNS for ownership proofs, Nostr for listings and messaging, and Bitcoin script for escrow.

## What you can do

**List a domain for free.**  
Add one TXT record that links the domain to your Nostr key. Every visitor’s browser verifies that record against two independent DNS resolvers before the listing is shown. A listing for a domain you do not control never appears.

**Sell it safely at 0% commission.**

1. The buyer pays into a 2-of-3 Taproot address controlled by the buyer, the seller, and an arbiter. No single key can move the funds.
2. The buyer privately tells the seller (via encrypted chat) where to send the domain—registrar, account, or email.
3. The seller transfers the domain the normal way: a push to the buyer’s account or an auth code for the buyer’s registrar.
4. The buyer confirms receipt. That confirmation releases payment to the seller immediately.

The only cost is the Bitcoin network fee, which is shown before any signature is created.

**Resolve disputes with evidence.**  
If the parties disagree, the arbiter reviews the domain’s public WHOIS/RDAP record and requests read-only proof from each side’s registrar (for example, a read-only API key). The arbiter then co-signs either the payout or the refund. The arbiter cannot take the funds or redirect them. Every ruling is published with its reasoning.

**Recover funds if everyone disappears.**  
A timelock allows the buyer to reclaim the funds unilaterally—even if this site is offline—using the recovery page and a saved recovery string.

**Flex your domain.**  
The home page ranks domains by sats paid. On the live site, each payment is a signet transaction to one public address, matched to a claim the payer signed on Nostr, so anyone can independently recount the rankings from the chain and the relays. A site can take Lightning zaps instead, whose receipts the payment provider signs.

## What we can and cannot do

| We can                                      | We cannot                                              |
|---------------------------------------------|--------------------------------------------------------|
| Refuse to display a listing on this site    | Delete it from the relays                              |
| Decline to arbitrate                        | Move a single satoshi by ourselves                     |
| Publish a ruling you disagree with          | Freeze, seize, or reverse a payment                    |
| Read the domain’s public registry record    | Touch your domain—it transfers directly from seller to buyer |
| Stop operating this site                    | Take your listings, keys, or history                   |

If the site disappeared tomorrow, the listings would remain on the relays and the funds would remain safe on-chain.

## Built for real trades

This is not a stage demo. The components that protect money are specified, tested, and verified against the systems they interact with.

- Every spending path is exercised against Bitcoin Core. The regtest suite funds real escrows and spends each path: cooperative release, arbiter release, arbiter refund, and timeout refund. A negative test confirms that the arbiter key alone cannot spend.
- Addresses are bound to their escrow. The Taproot internal key commits to the escrow ID, so a signature for one trade cannot spend another trade’s coins—even when the same keys are reused.
- Private communication stays private. Each pair of buyer, seller, and arbiter has its own NIP-17 chat. The arbiter never sees messages exchanged between buyer and seller (including transfer codes).
- Nothing is taken on trust. Every page re-derives the escrow address from the public keys, re-checks DNS proofs, and applies the same published rules to the same public facts.
- Everything is documented. The protocol, arbiter policy, threat model, and a guide for independently verifying the claims live in `spec/`.

There are approximately 770 tests. `bun run test` runs the protocol vectors; `bun run test:regtest` runs the escrow against a local Bitcoin node.

> The escrow and the flex board currently run on **Bitcoin signet** (test coins). The escrow will move to mainnet after an independent audit. The marketplace and flex board are live today.

## Architecture

There is no application server. The pages are static files that communicate directly with:

- **Nostr relays** — listings, portfolios, escrow records, private messages
- **DNS over HTTPS** (Cloudflare and Google) — ownership proofs
- **RDAP** — registrar data, locks, and dates
- **Esplora API** (mempool.space) — escrow funding and settlement, and flex payments
- **LNURL and NIP-57** — Lightning zaps, for a site that runs the flex board on Lightning
