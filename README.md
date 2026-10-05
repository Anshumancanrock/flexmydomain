#    ◇ FlexMyDomain ◇

A marketplace for domain names, built on Nostr and Bitcoin. There is no
backend and no account to create. Listings are Nostr events, ownership is
proved with a DNS record, and payments sit in a Bitcoin escrow that we cannot
spend.

## The flex board

The home page ranks domains by the sats people zap to them. Anyone can put
any domain there, and paying is the only requirement. The ranking is worked
out from public zap receipts, so anyone can recount it.

## The marketplace

Listing a domain is free. The seller adds one TXT record to the domain's DNS,
which ties the domain to their Nostr key, and every visitor's browser checks
that record before it shows the listing. A domain you don't control can't be
listed.

## Buying a domain through our escrow at 0 commission

The escrow handles domains at any registrar. The seller transfers the domain
straight to the buyer, the registrar's usual way, and the buyer's confirmation
pays the seller. If they disagree, an arbiter decides from the registry's
public record and the proof each side shows it. The arbiter never holds the
domain, and can never move the money alone.

1. The seller lists the domain for free.
2. A buyer opens an escrow from the listing. The page reads the domain's
   registry record (RDAP, the modern WHOIS) and stops a domain that is expired,
   expiring soon or already leaving its registrar.
3. The buyer pays the asking price into a Taproot address that needs two of
   three keys: buyer, seller and an arbiter. We never hold the money and can't
   move it. Right after paying, the buyer signs a refund to their own address.
4. The buyer tells the seller where to send the domain: the registrar, the
   username or account id there, and the email on it. The seller moves it to
   that account, or, at another registrar, sends the transfer code. Both go
   only through the two sides' private chat.
5. Saying it's sent also signs the seller's payout. Once the domain is in the
   buyer's account, the buyer confirms, and the seller is paid at once. We
   charge no fee; the only cost is the Bitcoin network fee, which the page
   shows before anything is signed.

Each pair of the three has its own private chat on the escrow's page,
end-to-end encrypted with NIP-17: the buyer and the seller, the buyer and the
arbiter, the seller and the arbiter. The arbiter never sees what the buyer and
the seller say to each other, transfer codes included. The invite goes
privately to the counterparty's Nostr inbox, and the reply comes back by
itself, so nobody copies links around. Each side's escrow key is backed up to
their own Nostr account, encrypted to their Nostr key, so connecting that key
on any device opens the escrow again; the recovery string is there as an
offline copy. Once a deal is paid out, each side's page says so, and the deal
log lists the whole public record: payment, claims, signatures, any ruling and
the payout.

The money can't get stuck. If the seller doesn't say the domain is sent within
the transfer window, the arbiter refunds the buyer. If the seller cancels, the
buyer is refunded at once. If either side disagrees, it asks the arbiter to
decide: the arbiter checks the registry's record (the registrar, its locks,
when the domain last moved) and asks each side, in its own chat, for read-only
proof such as a registrar API key that can only read, then co-signs the payout
the evidence supports and publishes its ruling with the reason. The arbiter can
only complete a payout the paid side already signed, never move money alone,
and if everyone vanishes a timelock refunds the buyer. After the timelock, the
buyer can sweep the escrow offline with `recover.html` from their recovery
string.

## Try the escrow on your own machine

```bash
bun run sandbox
```

This starts a throwaway Bitcoin Core regtest node with blocks mined on demand,
a local relay that applies the same write policy as `services/relay/`, and
stand-ins for a domain registry's record and DNS, then serves the pages built
from the current sources. Its control page, `http://127.0.0.1:3002/`, gives the
buyer, the seller and the arbiter each their own browser origin and a test key,
and has a faucet, a mine button, the DNS records, and a registry switch that
shows a domain moved to another registrar, for trying a dispute. Nothing reaches a public
relay or holds real money. It needs Bitcoin Core under `tools/`
(spec/VERIFY.md section 5); Ctrl-C stops it and deletes the chain.
