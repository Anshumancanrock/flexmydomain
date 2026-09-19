# Threat model

What can go wrong, who can do it, and what stops them. Where nothing stops an
attack, this document says so.

## 1. What we can and cannot do to you

| We can | We cannot |
|---|---|
| Refuse to show your listing on our page | Remove it from the relays |
| Refuse to arbitrate your trade | Move a single satoshi by ourselves |
| Publish a ruling you disagree with | Freeze, seize or reverse a payment |
| Stop running this site | Take your domain, your key or your history with us |

The escrow output is a Taproot tree with a cooperative leaf (buyer + seller),
two dispute leaves (arbiter + one party) and a timeout leaf. No leaf spends
with the arbiter key alone. If we disappear, the timeout path settles the
escrow without us: to the buyer in the four-leaf tree, and to the seller in
the no-arbiter tree, where the timeout is reversed so that a buyer holding the
domain cannot win by waiting.

## 2. Attacks on the domain proof

Anyone can publish a listing for a domain they do not own, because Nostr has
no gatekeeper. Every client and the indexer apply the same rule: the embedded
proof must verify for that domain under the event's own key, and DNS must
still agree. The event stays on the relays, but it is not served as real.

Copying somebody else's proof into your own listing does not work. The signed
message contains the domain, and the signature is checked against the listing
author's key, so a lifted proof fails immediately. `buildListing` also refuses
to construct such a listing.

A seller who loses the domain cannot keep a stale proof alive, because proofs
are re-resolved continuously, not checked once. A record that vanishes makes
the listing stale (shown, greyed and dated) rather than silently deleted. For
a funded escrow, a vanished proof is a dispute trigger.

To resist a poisoned lookup, two independent DoH providers are queried and
must agree; a record that only one resolver returns is reported as disputed
and left unverified. DNSSEC validation is shown when the chain validates, and
a verifier daemon on a different network gives a third view.

Zone control is not ownership. A TXT record proves that whoever holds the key
could write to the zone, and a DNS admin, a host, an agency or a former
employee can do that with no registrar access at all. Selling needs registrar
control, which is checked separately: the escrow funds only after the registry
has been seen with `clientTransferProhibited` on and then off, a change only
the account holder can make. The absence of the lock is not that check. Many
registrars never set it, so an unlocked domain says nothing about who listed
it. Confusing zone control with registrar control is the most dangerous
mistake available here, so the code keeps the two in separate fields with
separate names throughout.

## 3. Attacks on reputation

In wash trading, two keys you control escrow to each other and produce a
perfect pair of receipts. The bitcoin comes straight back, and the only cost
is mining fees. Any system that measures volume alone can be faked this way,
and ours would be too.

The defence is to weight volume at zero. A trade counts only with a registrar
transfer observed in RDAP, which needs a real inter-registrar transfer:
roughly $10 and a 60-day lock on that name afterwards. Nobody can do that a
hundred times in a week. Everything else is displayed but ignored, because
hiding it would conceal the pattern a reader should see.

So that one relationship cannot count as ten, reputation counts distinct
counterparties rather than trades (`core/nostr/receipt.ts`), and each receipt
names its counterparty, so a page that shows them can show whether five sales
means five people or one friend five times. No page shows receipts yet.

A bad review cannot be deleted by its subject. Receipts are kind 1985, which
is regular rather than replaceable, and each party writes about the other, so
you cannot replace the receipt your counterparty wrote about you. Even the
author of a receipt can only send a deletion request, which relays may ignore.

Forged receipts cannot inflate a zap ranking. A receipt is rejected unless it
is signed by the recipient's own published zapper key, its embedded zap
request verifies, and the invoice amount matches the request. Duplicate
receipts from several relays collapse by id.

A key can list badges it was never given, because a kind 30008 is
self-published and says only "show these". Each claim is therefore checked
against a real kind 8 award naming that key, issued by the author of the badge
definition.

## 4. Attacks on the trade

A buyer who has received the domain can stop signing and wait out the
timelock, which deadlocks the trade. The arbiter is the backstop, with a
published SLA and a decision table. Where the parties choose no arbiter, the
timeout must pay the seller instead, and the no-arbiter mode is only safe
because of that.

A seller can open escrows on one domain with two buyers. We cannot prevent
that without becoming a gatekeeper, and we do not try. Our index does not
show, and we do not arbitrate, a second escrow on a domain that has a funded
one outstanding. The losing buyer is protected by the dispute and timeout
leaves, and the receipt graph makes the attempt permanently visible.

Opening an escrow cannot be used to grief a seller. Opening is free and costs
the listing nothing: only a funded escrow marks a listing as in escrow, and an
unfunded one expires.

A settlement can get stuck when fees rise. Settlement inputs signal RBF.
Timeout spends cannot, because their sequence field carries the relative
timelock, so they overpay the fee or add a change output to fee-bump from.

## 5. Attacks on keys

Keys generated in the page as the fallback signer are encrypted at rest with
AES-256-GCM under a PBKDF2-SHA256 key (310,000 iterations), and the passphrase
never leaves the page. This is storage on one machine and not a backup:
clearing site data destroys it, and there is nobody to ask for a reset. The UI
forces a backup step and states the warning plainly.

Anything running on our origin can read that storage. A NIP-07 extension is
strictly better and is offered first.

A malicious signer extension could return a different pubkey than it
advertised, or alter `created_at` before signing. Either would produce a
proof that never verifies, discovered days later. Every signer response is
checked again against the event we asked it to sign.

Our own arbiter key is one of three and can move nothing alone.

## 6. Attacks on us, and on you through us

We can be compelled to stop showing a listing. We cannot be made to remove it
from relays we do not run, and the filter for finding it is published, so
anyone can rebuild the view. Our moderation list is a public, forkable Nostr
list rather than a private table.

Relays could be captured or could refuse us. Events are published to the
user's own NIP-65 write relays, and our five are a fallback, never a
replacement. If every relay we list refused us tomorrow, users who have set
their own relay list would be unaffected.

The supply chain is five pinned runtime dependencies, all `@noble` or
`@scure`, all audited, with almost no transitive tree. TypeScript is a dev
dependency and reaches neither the browser bundle nor the daemons. The browser
bundle is committed, so you can diff it against a build of your own. There is
no CDN, no analytics and no font fetched from a third party.

## 7. What we have not solved

- Refusing registrar-side custody leaves a gap. We hold no registrar account
  and no API key, so we cannot move a domain for anybody, including a buyer
  whose seller stops responding. That case is left to the arbiter and the
  timelock, which is slower than an integrated marketplace would be.
- Registrant identity is redacted almost everywhere since GDPR. RDAP shows
  that a name moved and to which registrar, but never to whom. The buyer
  commits to a registrar and nameserver fingerprint when the escrow opens
  instead. That is weaker, and it is why the dispute policy relies on
  snapshots over time.
- A seller can satisfy the fingerprint without handing the domain over.
  Nameservers are set by whoever holds the registrar account, so a seller can
  point the domain at the buyer's committed nameservers and keep it. A seller
  willing to pay a transfer fee can also move the name to the buyer's
  committed registrar, into an account of their own. RDAP sees neither
  account, so a fingerprint match is evidence, not proof. The page tells the
  buyer to confirm the domain is in their own registrar account before
  signing a release, calls a nameserver-only commitment weak, and refuses a
  commitment the registry already matches at escrow-open (the same-registrar
  case, which would otherwise read as "transferred" from the first poll).
- A domain can be sold twice in the interval between two RDAP polls.
- Escrow signing is unaudited. The tree, the settlement transaction and the
  witness are built and verified against Bitcoin Core on regtest, but by
  nobody except their own tests. The deployment default is signet, and
  nothing in this repository should hold real money until someone else has
  reviewed it.
