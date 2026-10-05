#    ◇ FlexMyDomain ◇

**Buy and sell domains with nobody in the middle.** Listings live on Nostr,
ownership is proved with a DNS record, and the money sits in a Bitcoin escrow
that nobody can take alone, us included. No accounts, no commission, no backend.

**Live:** https://flexmydomain-neon.vercel.app (the escrow runs on Bitcoin signet)

## Why this exists

Selling a domain to a stranger is a trust problem, and today you pay heavily to
solve it.

- **Big cuts.** Marketplaces take 5 to 20% of the sale, and escrow services
  charge on top of that. Cheap names often aren't worth listing at all.
- **Someone has to go first.** If the buyer pays first, the seller can keep the
  money. If the seller transfers first, the buyer can disappear. So a middleman
  holds the money and you wait on them.
- **Fake listings.** Most sites let anyone list a name they don't own, and a
  buyer finds out after paying.
- **Platform risk.** Your listings, your history and your money sit in someone
  else's account system, which can change its fees, freeze a payout or shut down.

FlexMyDomain removes the middleman from each of these, with tools that already
exist: DNS for ownership, Nostr for listings and messages, and Bitcoin script for
the escrow.

## What you can do

**List a domain for free.** Add one TXT record that ties the domain to your Nostr
key. Every visitor's browser checks that record against two independent DNS
resolvers before showing your listing. A listing for a domain you don't control
never appears.

**Sell it safely, at 0% commission.**

1. The buyer pays into a 2-of-3 Taproot address held by the buyer, the seller
   and an arbiter. No single key can move the money.
2. The buyer tells the seller where to send the domain, in a private encrypted
   chat: the registrar, the account, the email.
3. The seller transfers it the normal way at any registrar: a push to the
   buyer's account, or a transfer code for the buyer's own registrar.
4. The buyer confirms it arrived, and that confirmation pays the seller straight
   away.

The only cost is the Bitcoin network fee, which the page shows before anything
is signed.

**Settle disputes with evidence.** If the two sides disagree, the arbiter reads
the domain's public WHOIS (RDAP) record and asks each side, in its own private
chat, for read-only proof from their registrar, such as an API key that can only
read. Then it co-signs either the refund or the payout. The arbiter can never
take the money or send it anywhere new, and every ruling is published with its
reason.

**Get your money back if everyone vanishes.** A timelock lets the buyer take the
refund alone, even with this site offline, using the `recover.html` page and a
saved recovery string.

**Flex your domain.** The home page ranks domains by the sats people pay for
them. On the live site that's signet coins sent to one public address, each
payment matched to a claim its payer signed on Nostr, so anyone can recount the
board from the chain and the relays. The board can take Lightning zaps instead,
whose receipts the provider signs.

## What we can and can't do

| We can | We can't |
|---|---|
| Refuse to show a listing on our site | Delete it from the relays |
| Refuse to arbitrate | Move a single satoshi by ourselves |
| Publish a ruling you disagree with | Freeze, seize or reverse a payment |
| Read the domain's public registry record | Touch your domain: it goes straight from seller to buyer |
| Stop running this site | Take your listings, your keys or your history |

If the site disappeared tomorrow, the listings would still be on the relays and
the money would still be safe on chain.

## Built for real trades

This isn't a demo that only works on stage. The parts that guard money are
specified, tested and checked against the real systems they touch.

- **Every spending path runs against Bitcoin Core.** The regtest suite funds real
  escrows and spends each path: cooperative release, arbiter release, arbiter
  refund and the timeout refund. A negative test proves no path spends with the
  arbiter key alone.
- **Addresses are bound to their escrow.** The Taproot internal key commits to
  the escrow id, so a signature made for one trade can't spend another trade's
  coins, even with the same keys.
- **Private things stay private.** Each pair of buyer, seller and arbiter has its
  own NIP-17 chat. The arbiter never sees what the buyer and the seller say to
  each other, transfer codes included.
- **Nothing is taken on trust.** Every page re-derives the escrow address from
  the public keys, re-checks DNS proofs itself, and applies the same published
  rules to the same public facts.
- **Written down.** The protocol, the arbiter's policy, the threat model and a
  guide to checking our claims yourself are in [`spec/`](spec/).

There are about 770 tests: `bun run test` runs the protocol vectors, and
`bun run test:regtest` runs the escrow against a local Bitcoin node.

> The escrow runs on **Bitcoin signet** (test coins) for now and moves to mainnet
> after an independent audit. The marketplace and the flex board work today.

## How it's built

There is no server. The pages are static files that talk directly to:

- **Nostr relays** for listings, portfolios, escrow records and private messages
- **DNS over HTTPS** (Cloudflare and Google) for ownership proofs
- **RDAP**, the registry's own WHOIS service, for registrar, locks and dates
- **An Esplora API** (mempool.space) for funding and settlement
- **LNURL and NIP-57** if the flex board takes Lightning zaps instead of signet payments

```
core/      protocol: escrow script tree, settlements, Nostr events, DNS proofs
net/       relays, DNS, RDAP, chain and Lightning clients
client/    browser bundle: signers, private messages, invoices
web/       the site: static pages and their TypeScript sources
services/  optional extras: a policy relay, an indexer, a proof verifier
spec/      protocol, arbiter policy, threat model, verification guide
test/      protocol vectors and Bitcoin Core regtest suites
```

## Run it

You need [Bun](https://bun.sh).

```bash
git clone https://github.com/Anshumancanrock/flexmydomain && cd flexmydomain
bun install
bun run build     # compile the pages
bun run serve     # http://localhost:8000
bun run test      # protocol tests, no network needed
```

## Try a whole trade in 10 minutes

The sandbox runs everything on your machine: a throwaway Bitcoin chain, a local
relay, and stand-ins for a domain registry and DNS. It comes with test keys for
the buyer, the seller and the arbiter, so you don't need a wallet, a domain or
your own Nostr key, and nothing touches a public relay or real money.

**1. Get Bitcoin Core 31.1** into `tools/` (it isn't in git). On Linux x86_64:

```bash
mkdir -p tools && cd tools
curl -LO https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz
curl -LO https://bitcoincore.org/bin/bitcoin-core-31.1/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
tar xzf bitcoin-31.1-x86_64-linux-gnu.tar.gz && cd ..
```

On a Mac, take `bitcoin-31.1-arm64-apple-darwin.tar.gz` (or `x86_64-apple-darwin`)
instead and check it with `shasum -a 256 --ignore-missing -c SHA256SUMS`.

**2. Start it:**

```bash
bun run sandbox
```

Open the control page at **http://127.0.0.1:3002/**. It shows the three test keys
and has a faucet, a mine button and payout addresses.

**3. Play the buyer and the seller.** Open the buyer link and the seller link from
the control page. They use different browser origins, so each keeps its own key.
On each, click **Connect** and unlock the stored key with the passphrase
`sandbox-pass`.

- As the **buyer**, on the escrow page: any domain (say `lumenary.com`), a price
  like `100000`, "I am buying", and the seller's npub from the control page.
  **Check the terms**, then **Create the invite**.
- As the **seller**, the invite shows at the top of the escrow page. Open it and
  accept. The reply goes back to the buyer by itself, and both sides publish.
- **Fund it** from the control page: paste the escrow address and the amount into
  the faucet and press **Pay and mine 1 block**.
- **Buyer:** sign the refund, then say where to send the domain.
- **Seller:** pick how you send it, paste a payout address from the control page,
  and press **I sent it**.
- **Buyer:** **Confirm and pay the seller**, mine a block, and the escrow settles.

**4. Play the arbiter.** Start a second trade, and instead of confirming, have the
buyer press **Ask the arbiter to decide**. Then:

- On the control page, press **Copy arbiter key**.
- Open **http://[::1]:8100/escrow?arbiter**, the list of escrows naming the
  arbiter, and open the disputed one.
- Paste the key under **Act on this escrow**. You now see the arbiter's two
  private chats, the domain's WHOIS record, buttons that ask each side for
  read-only proof, and the release and refund buttons.
- To see the registry record change, tick "moved to another registrar" in the
  control page's Registry box, press **Apply**, then **Read it again** on the
  escrow page.

**5. Flex a domain.** On the Rank page of either tab, type any domain and press
**Flex it**. Pay the exact amount it shows, to the address it shows, from the
control page's faucet, and the domain lands on the board.

Ctrl-C stops the sandbox and deletes the chain.

### Being the arbiter with your own key

Each escrow fixes its arbiter in its terms when it opens, and a site offers its
own arbiter from `web/assets/config.js`. To run your own:

1. Put your npub in `arbiterPubkey` in `web/assets/config.js`. Use a key that
   does nothing else.
2. Serve the site (`bun run serve`) and open new escrows there.
3. On an escrow's page, paste your nsec (or the hex key) under **Act on this
   escrow**. The page keeps it in memory only: it is never stored, never sent,
   and gone when you reload.

On the public site the arbiter is the site's own key, so visitors can't take
that role there.

## License

MIT
