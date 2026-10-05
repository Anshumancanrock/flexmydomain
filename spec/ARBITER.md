# Arbiter policy

Anyone can be an arbiter. This document is the policy we publish for the
arbiter key we operate, and the runbook we follow with it. Anyone can operate
another arbiter and publish a different policy. Buyers and sellers can each
choose which arbiters they accept by publishing a NIP-51 set (spec/PROTOCOL.md
§5), and trade only where their two lists intersect. A side with no list
accepts only the site's own arbiter. No page here publishes such a set yet, so
in practice both sides accept the site's own arbiter.

If the two lists do not intersect, there is no trade, and the page says so
instead of falling back to a default arbiter.

Every escrow has an arbiter, and the arbiter never holds the domain: the
seller transfers it straight to the buyer, at any registrar (spec/PROTOCOL.md
§8). The arbiter completes the payout the rules call for when the two sides
don't, and decides when they disagree, from the registry's public record and
the proof each side shows it.

## 1. What an arbiter can and cannot do

With the money, an arbiter holds one key of three. It can co-sign with the
buyer or with the seller, and it can do nothing alone: no leaf in the script
tree can be spent by the arbiter key by itself, and a test asserts this
against Bitcoin Core. So an arbiter cannot take the money, cannot freeze it,
and cannot prevent the timeout path from returning it.

It cannot choose where the money goes either. It co-signs only a payout that
the side being paid has signed first: the seller's release on leaf B (seller
and arbiter), or the buyer's refund on leaf C (buyer and arbiter). That side
fixed the destination and the fee, and its signature covers both
(spec/PROTOCOL.md §8). If the side a ruling pays hasn't signed, the ruling
waits for it, or for the timeout. Leaf D lets the buyer take the refund alone
once the timelock opens, with nobody's cooperation.

With the domain, an arbiter can do nothing. It never holds it, and never sees
a transfer code, which passes only in the buyer and seller's own chat (§2).

What a party trusts an arbiter with is its judgement in a dispute, and
whatever read-only proof the party shows it. A wrong ruling pays the wrong
side, and an arbiter that never rules leaves the escrow to the timelock, which
refunds the buyer. Every ruling is signed with the arbiter key and published
with its reason (§8), so a bad one is on the arbiter's record, in its own
signature.

## 2. Where the domain goes

The domain goes straight from the seller to the buyer, the registrar's usual
way: a push to the buyer's account at the same registrar, or a move to the
buyer's own registrar with the domain's transfer code. After funding, the buyer
tells the seller where to send it, and the seller says how it sent it, both in
their private chat (spec/PROTOCOL.md §8).

We can't read that chat. Each pair of the escrow's three keys has its own
chat, and the buyer and seller's is encrypted only to the two of them, so
transfer details and codes never reach us (spec/PROTOCOL.md §10). Each side's
chat with us is private from the other side in the same way: neither sees what
we ask the other, or what the other shows us.

Beyond each side's claims, what we learn of the transfer comes from the
registry's public record (§4) and from what each side chooses to show us (§5).
When a side asks us to decide, its page sends us its reason, and can add what
it said in the other chat: the buyer, where it asked for the domain to go; the
seller, whether it pushed the domain or gave a transfer code, and when, never
the code itself.

## 3. Deadlines

The trade's own deadlines are part of its terms, counted in blocks from F, the
height of the block that confirmed the funding (spec/PROTOCOL.md §8):

| deadline | block | mainnet | test networks |
|---|---|---|---|
| the seller has said the domain is sent | `deliverBy` = F + `deliver_blocks` | 1008 blocks, about a week | 12 blocks, about 2 hours |
| the buyer's lone refund opens | `timeoutAt` = F + `timeout_blocks` | 4320 blocks, about 30 days | 144 blocks, about a day |

These are the site's rules (`SITE_RULES` in `core/escrow/trade.ts`), and both
sides' pages refuse any others. The timelock must leave at least 72 blocks,
about 12 hours, after the transfer deadline (`MIN_ARBITER_BLOCKS`): our time to
look into a dispute. The site's rules leave 3,312 blocks, about 23 days, on
mainnet, and 132 blocks, about 22 hours, on test networks.

The refund for a missed transfer deadline is due as soon as the tip reaches
`deliverBy` with no "sent" from the seller and no dispute, and we make it then.
A seller who says "sent" before we do turns the rules back to waiting for the
buyer; once the refund is out, the trade is over.

Rule well before `timeoutAt`. From the block before it, the page warns that
the buyer can take the refund alone at any moment, and from then on any payout
we complete races that refund, so a release can lose. A seller whose buyer
won't confirm should therefore ask us to decide early, and the seller's page
tells it to, well before the timeout block. If we miss everything, the parties
are not stuck: the timelock returns the money to the buyer without anyone's
cooperation.

## 4. The registry's record

In a dispute we read the registry's own public record of the domain: RDAP, the
modern WHOIS. The escrow's page reads it live from the registry's RDAP service
and shows it to us under "The registry's record":

- the registrar, by name and IANA id;
- the statuses, as the registry writes them, with plain words for those that
  bear on a transfer: a transfer lock set by the registrar or by the registry
  (client or server transfer prohibited), a move to another registrar under
  way (pending transfer), a lock against changes, and a hold, under which the
  domain doesn't resolve;
- the dates of the last transfer and the last change, each marked when it is
  later than the escrow's opening;
- the expiry date and the nameservers.

The page reads it again once a reading is five minutes old, and at once when
we press "Read it again".

A move to another registrar shows in this record: as a pending transfer while
it is under way, and then as a new registrar with a new transfer or change
date. Two things stop such a move, though a push at the same registrar usually
still works: a transfer lock, until it is lifted, and ICANN's 60 days after a
registration or a move between registrars. A push between two accounts at one
registrar doesn't show in the record at all. The record names the registrar,
never the account holder, whom GDPR redacts almost everywhere, so only the
registrar knows which account holds the domain, and for that we ask each side
for proof.

## 5. Asking for proof

In a dispute the page gives us "Ask for proof": a request for each side,
written out and ready to edit, which goes to that side alone, in its own chat
with us. We ask the buyer for proof of whether the domain is in its account at
its registrar, and the seller for proof of how and when it transferred the
domain to the buyer. Best is a read-only API key, one that can only read that
side's domains and change nothing. From the seller we also ask the date it
started the transfer. A screenshot helps too, as weaker evidence (§6). The
requests say never to send a password, a login code or a transfer code, and to
delete the key once we have ruled. The answers arrive in our Buyer and Seller
chats on the page.

We check a key on our own computer, never in a web page. A registrar's API
answers only about the domains in the key's own account. Spaceship's, for
example:

```
curl -s -H "X-API-Key: KEY" -H "X-API-Secret: SECRET" https://spaceship.dev/api/v1/domains/<domain>
```

returns the domain's details when the domain is in that account, and an error
when it isn't. Other registrars have a call like it, which their API
documentation names. A key shows only what its one account holds, so we read
it with the registry's record and with what the other side shows, and the
ruling's reason says what we checked.

## 6. The only evidence that counts

In this order:

1. The chain: the funding block, the tip, and what has been spent
2. The signed views: each side's claims, with the reason it gave for a
   cancellation or a dispute, and its signatures
3. The registry's record (§4)
4. The read-only proof each side shows us (§5)
5. What each side tells us in its chat with us, and screenshots, only where
   they agree with 1 to 4

A screenshot is weak evidence: anyone can edit a page before taking one. A
claim's stated time is not evidence either, since its author chose it, and the
same goes for a message's. The deadlines count blocks, which nobody chooses.
We never see the buyer and seller's chat, so what one side tells us of it is
that side's word.

## 7. The decision table

Every case but a dispute follows from public facts, and every page computes it
the same way (`arbiterRule` in `core/escrow/trade.ts`). The rows apply in this
order, so each side's word against its own interest comes first:

| observed | ruling |
|---|---|
| The buyer confirmed the domain is in their account | release to the seller |
| The seller cancelled | refund the buyer |
| Either side asked us to decide | we decide, below |
| The seller said the domain is sent | none yet: the buyer confirms once it arrives |
| The transfer deadline passed with no "sent" from the seller | refund the buyer |
| Anything else | none yet: the seller transfers the domain |

The arbiter's page offers what the rules say, and asks for an explicit
override to rule otherwise. Most escrows need nothing from us: the buyer's
confirmation completes the seller's release on leaf A, and a seller who
cancels completes the buyer's refund on leaf A. We complete the payout the
rules call for where the two sides haven't: after a missed transfer deadline,
after a confirmation or a cancellation made before the other side had signed,
and after every dispute we decide.

In a dispute we rule on whether the domain reached the buyer:

| the evidence shows | ruling |
|---|---|
| The domain reached the buyer | release to the seller |
| The domain never left the seller, or went somewhere the buyer didn't ask for | refund the buyer |
| A move to the buyer's registrar is under way | none yet: we wait for it to finish |
| Both sides agree on the outcome | that outcome, if it is a full release or a full refund; a payout can't be split |
| Nothing settles it | refund the buyer, and say why |

The last row favours the buyer on purpose, as the timelock does: the buyer
paid first, and "sent" is the seller's own word until something shows the
domain moved. A side can still settle a dispute without us, the buyer by
confirming and the seller by cancelling, since either outranks the dispute.

When one side never answers, we decide on the record we have: the views, the
registry's record and what the other side showed us, and the reason says the
silent side was asked. A silent seller costs the buyer nothing in the end,
since the deadlines protect the buyer: with no "sent" in time the rules refund
it, and with no payout by the timeout the timelock does. A silent buyer is the
case that needs us, and the seller should bring it to us early (§3).

A seller can open escrows on one domain with two buyers, and only one of them
can end up with it. The arbiter's list (`escrow.html?arbiter`) flags a domain
that more than one escrow names. We decide each escrow on its own record, and
only the one whose buyer got the domain pays the seller. The other buyer is
refunded, by the rules if that seller never says "sent", or by us in a dispute.

A case this section doesn't cover is a gap in it, and we amend it in public.

### On the page

1. `escrow.html?arbiter` lists the escrows naming this site's arbiter on the
   relays it asks, newest first: the domain, the amount, and where each stands,
   from no claims yet to our ruling. A dispute is marked, and so is a domain
   that more than one escrow names. The list reads claims and rulings, not the
   chain, so a passed deadline shows only on the escrow's own page.
2. Open the escrow and paste the arbiter key, as an nsec or in hex, under "Act
   on this escrow". The page takes only the key that escrow names as its
   arbiter.
3. "The rules say" gives what `arbiterRule` returns, and flags the timelock
   once the next block can carry the buyer's lone refund. "The record" below it
   shows each side's claims with their stated times and reasons, both deadlines
   as block heights, and any ruling.
4. In a dispute, read "The registry's record" (§4) and send the requests under
   "Ask for proof" (§5).
5. Under "Rule", write the reason, up to 1,800 characters, which is published
   with the ruling. It starts filled in with the rules' own reason when they
   call for a payout. Then press "Release to the seller" or "Refund the
   buyer". A button works only once the side it pays has signed its payout,
   and until then the page says which chat to ask in. Ruling against the
   rules, or while they call for no payout yet, takes the override tick; a
   dispute needs none. When not every relay answered, a claim may be missing
   from the record: refresh first if you can, or tick the second box to rule
   on it anyway. The page shows the payout in full, amount, address and fee,
   before it signs.
6. Just before it signs, the page reads both views again, and stops if a claim
   that landed meanwhile changed what the rules say. Otherwise the button
   co-signs that side's payout, broadcasts it, publishes the ruling, and tells
   each side in its own chat with us what we ruled and why.
   If the network refuses the payout, nothing is published, and the log shows
   the raw transaction to broadcast elsewhere. A ruling that too few relays
   took waits under "Publish again".

An escrow opened with the earlier flow, where the arbiter held the domain,
doesn't open: the page says so and offers nothing to sign, so we can't rule on
one. Its money is safe on chain, and the buyer of a funded one that never paid
out takes the timeout refund with `recover.html` and the recovery string.

## 8. Every ruling is published

Each ruling is a kind 30078 event at `d = fmd:ruling:<escrow id>`, signed by
the arbiter key, carrying the decision (`release` or `refund`), the reason, our
co-signature (leaf B for a release, leaf C for a refund) and the payout's txid
(spec/PROTOCOL.md §5). The page publishes it to the escrow's relays only once
the payout has been broadcast. A reader counts a ruling only when its author is
the arbiter the escrow's views name, and of several, the newest. Rulings are
our only public statements about an escrow: the arbiter states no claims in a
view.

A ruling that fewer than half the relays took is kept in the tab that made it,
which offers to publish it again until at least half of them take it, or a
relay sends it back when the page reads again. The site's own relay refuses any
request to delete a ruling (`services/relay/policy.ts`).

An arbiter's value lies in a permanent public record of how it has ruled, and
arbiters compete on that record. An arbiter whose rulings can't be found has no
record to weigh, and should be chosen accordingly. Anyone can save an escrow's
record from its page at any time, both views and the ruling, each of which
verifies on its own, so it outlives any relay. The private chats are not in it,
so we keep our own copy of what a ruling rested on: the registry's record as we
read it, what a registrar's API answered, and what each side sent us.

## 9. Messages

Each side has its own private chat with us on the escrow's page, and the buyer
and the seller have one with each other that we can't read (spec/PROTOCOL.md
§10). The pages write in them at the steps that concern us: a side that asks
us to decide sends us its reason, our requests for proof go to each side
alone, and our ruling goes to each side in its own chat.

The arbiter key is also a Nostr identity, so every message to it also goes to
the relays its kind 10050 list names (the first four), and reaches our own
Nostr inbox. Keep such a list on the discovery relays, where the pages look for
it, naming relays your client reads, and the messages arrive like any other
private message, from the parties' escrow keys, under the subject
`flexmydomain escrow <first 12 hex of the id>`. A message says what happened;
we still act only on what the escrow's page shows.

## 10. Fees

We charge nothing: every payout sends the whole escrow, less the network fee
the paid side set when it signed, to the side it pays. If that changes, the fee
will be stated in advance in a kind 30078 `d = fmd:arbiter` record, along with
our contact details, and taken as an output of the settlement transaction,
which both signers see before they sign. None of that exists yet: a payout has
one output today, and charging a fee needs a code change first.

## 11. Key hygiene

The arbiter key co-signs payouts, signs rulings, and seals our messages in the
escrow chats. It holds no funds, it is not the key that runs this site, and it
is not the key that signs attestations, so a compromise of any one of these
keys affects only one job. It signs Bitcoin transactions directly, which a
NIP-07 extension can't do, so the arbiter pastes it into the escrow's page. The
page keeps it in memory only, never in the tab's storage, so a reload drops it,
and the site never hands it to another tab. Keep it offline otherwise.

A read-only API key a side sends us can change nothing, but it shows that
side's domains, so we use it only for the dispute it came for, on our own
computer, and delete it once we have ruled, as our request asks the side to do
then too. We never ask for a password, a login code or a transfer code.

## 12. Conflicts of interest

We will not arbitrate a trade where we are the buyer or the seller, where we
hold a listing on the same domain, or where we have a financial relationship
with either party. In any of those cases the parties should pick a different
arbiter, and the escrow should not open with ours. The pages enforce the
plainest case: they never offer an arbiter whose key is either party's Nostr
key, and the script tree refuses an arbiter key that is also the buyer's or the
seller's.
