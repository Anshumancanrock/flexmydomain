# flexmydomain

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

## Buying a domain through flexmydomain's escrow at 0 commission

1. The seller lists the domain for free.
2. A buyer opens an escrow from the listing and says where the domain should
   end up: their registrar, or the nameservers they will point it at.
3. Before any money moves, the seller turns the registrar's transfer lock on
   and then off. Only the account holder can do that, so it shows the seller
   really controls the domain, and the page sees it in public registry data.
4. The buyer pays the asking price into a Taproot address that only the buyer
   and seller can spend together (or an arbiter with one of them, if they
   picked one). The money waits there. We never hold it and can't move it.
5. The seller sends the transfer code privately, or pushes the domain to the
   buyer's account if they use the same registrar.
6. The page polls the registry (RDAP) until two readings, at least half an hour
   apart, show the domain at the buyer's destination. Buyer and seller then
   sign the release and the seller is paid. We charge no fee; the only cost is
   the Bitcoin network fee which is negligible

The money can't get stuck. With an arbiter, a dispute is settled by the
arbiter and one of the two parties, and if nobody acts, a timelock refunds the
buyer. Without an arbiter the timelock pays the seller instead, so the buyer is
trusting the seller to deliver. `recover.html` can sweep an escrow offline
from a single recovery string.
