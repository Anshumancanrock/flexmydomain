# Threat model

What can go wrong, who can do it, and what stops them. Where nothing stops an
attack, this document says so.

## 1. What we can and cannot do to you

| We can | We cannot |
|---|---|
| Refuse to show your listing on our page | Remove it from the relays |
| Refuse to arbitrate your trade | Move a single satoshi by ourselves |
| Publish a ruling you disagree with | Freeze, seize or reverse a payment |
| Read the registry's public record of your domain | Touch your domain: it goes straight from the seller to the buyer |
| Ask you for read-only proof in a dispute | Read your chat with the other side: only the two of you can |
| Stop running this site | Take your key or your history with us |

The escrow output is a Taproot tree with a cooperative leaf (buyer + seller),
two leaves the arbiter completes (arbiter + one party) and a timeout leaf. No
leaf spends with the arbiter key alone, and the arbiter only ever completes a
payout the side it pays signed first. If we disappear, the timeout path
refunds the buyer without us.

The domain never passes through us. The seller transfers it straight to the
buyer, the registrar's usual way, so we hold no registrar account and no
domain in transit. What a trade trusts the arbiter with is its judgement in a
dispute (§4). If we disappeared, the buyer would still be refunded by the
timelock, and a seller who had already transferred the domain would be paid
only if the buyer confirmed: a buyer who kept quiet until the timelock could
keep both.

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
are re-resolved on every view, not checked once. A record that vanishes makes
the listing unverified: the market hides it unless "Show unverified listings"
is on, and then shows it greyed with the reason. The portfolio page keeps the
domain, marked "proof not found". Nothing is deleted from the relays. A funded
escrow doesn't watch the proof: only its deadlines, the two sides' claims and
the arbiter's ruling move it.

To resist a poisoned lookup, two independent DoH providers are queried and
must agree; a record that only one resolver returns is left unverified, and
the prove-a-domain step says which resolver saw it. While one resolver doesn't
answer, nothing can be verified, and the pages say "not checked" rather than
"no record". DNSSEC validation is shown when the chain validates, and
a verifier daemon on a different network gives a third view.

Zone control is not ownership. A TXT record proves that whoever holds the key
could write to the zone, and a DNS admin, a host, an agency or a former
employee can do that with no registrar access at all. Selling needs control of
the registrar account that holds the domain, and nothing public shows whose
account a name is in: RDAP names the registrar, and the registrant is redacted
almost everywhere. So the escrow doesn't try to check it before funding. A
seller who can't transfer the domain never gets the buyer's confirmation, and
the buyer is refunded: at the transfer deadline if the seller never says
"sent", and otherwise by a ruling or by the timelock (§4). The cost of a fake
seller is the buyer's time, not the buyer's money, unless the seller fools the
arbiter.
Confusing zone control with registrar control is the most dangerous mistake
available here, so the code keeps the two in separate fields with separate
names throughout.

## 3. Attacks on reputation

In wash trading, two keys you control escrow to each other and produce a
perfect pair of receipts. The bitcoin comes straight back, and the only cost
is mining fees. Any system that measures volume alone can be faked this way,
and ours would be too.

The defence is to weight volume at zero. A trade counts only with a registrar
transfer observed in RDAP, which needs a real inter-registrar transfer:
roughly $10 and a 60-day lock on that name afterwards. Nobody can do that a
hundred times in a week. Everything else is displayed but ignored, because
hiding it would conceal the pattern a reader should see. A move between two
accounts at one registrar shows nowhere in RDAP, so an escrow trade made that
way weighs zero.

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

That holds only if the zapper key belongs to the recipient alone. A custodial
provider (Alby, Wallet of Satoshi, a shared LNbits) signs receipts for every
account with one key, so anyone with an account there can zap the board from
their own address, pay themselves, and get a receipt the board counts. A
deployment that turns the board on must take payments through an LNURL server
whose `nostrPubkey` is its own.

A key can list badges it was never given, because a kind 30008 is
self-published and says only "show these". Each claim is therefore checked
against a real kind 8 award naming that key, issued by the author of the badge
definition.

## 4. Attacks on the trade

The domain moves once, straight from the seller to the buyer, the registrar's
usual way: a push to the buyer's account at the same registrar, or a move to
the buyer's registrar with a transfer code (spec/PROTOCOL.md §8). After
funding, the buyer tells the seller where to send it, and the seller sends any
transfer code, in their private chat. Saying "sent" also signs the seller's
payout on leaves A and B. The buyer's confirmation co-signs the release on
leaf A, which pays the seller at once. Either side can instead ask the arbiter
to decide. Nothing on chain or in a view shows where the domain went, so the
arbiter reads the registry's public record itself, asks each side for proof in
its own chat with it, completes one side's own signed payout, and publishes a
ruling with its reason.

A seller can say "sent" without sending. From then on the transfer deadline no
longer refunds the buyer: the rules wait for the buyer's confirmation, and the
seller's payout completes only with that or with a ruling. The buyer asks the
arbiter to decide. A move to another registrar shows in the registry's record,
first as a pending transfer, then as a new registrar and a new transfer date,
and the arbiter's page marks a transfer or a change dated after the escrow
opened. A push inside one registrar shows nowhere public, so the arbiter asks
each side for read-only proof. If nobody rules, the timelock refunds the buyer.
The seller gains nothing; the buyer loses time.

A buyer who has the domain can keep quiet, or say it never arrived. The seller
asks the arbiter to decide, and the arbiter completes the release the seller
signed on leaf B when it said "sent". The seller has to ask in time: from the
timelock on, the buyer can take the money back alone through leaf D, and a
release completed after that races it. The site's timelock opens 4,320 blocks
(about 30 days) after funding on mainnet, 3,312 blocks after the transfer
deadline, and 144 blocks (about a day) after funding on test networks, 132
after the deadline. Terms that leave less than 72 blocks between the two are
refused (`MIN_ARBITER_BLOCKS`).

Read-only proof is what the arbiter weighs where the registry's record is
silent (spec/ARBITER.md §5). It asks each side for a registrar API key that
can only read, and checks the key on its own computer, never in a web page,
against the registrar's API, which answers only about the domains in that
key's own account. A key that lists the domain shows that its account holds
it. One that doesn't shows only that this account doesn't, so a side that
wants to hide the domain can show an empty account (§7). A screenshot is
weaker: anyone can edit a page before taking one. The arbiter reads the
registry's record itself, so neither side can hand it a doctored one. The
page's request tells each side never to send a password, a login code or a
transfer code. A read-only key still shows the arbiter every domain in its
account until its owner deletes it, as the request asks once the ruling is
in.

A transfer code can leak. It travels only in the buyer and the seller's chat,
encrypted to their two escrow keys: the page never puts it in a view or sends
it to the arbiter. Whoever reads it anyway, with a stolen escrow key or a
stolen Nostr key that opens that escrow key's backup (§5), can start a move of
the domain to a registrar of their own while the domain is unlocked. A seller
who fears that can have its registrar issue a new code and send it to the
buyer from the page's box for new transfer details.

The buyer's account reaches the seller only as a card in their chat, and the
newest card counts. If the two later disagree about what the buyer asked for,
each can show the arbiter its own copy, and nothing in the pages proves who
wrote a chat message (see "Private messages" below), so the arbiter weighs one
side's word against the other's.

A buyer's confirmation can't be taken back. Its co-signature completes the
seller's release on leaf A, the page broadcasts it at once, and anyone who saw
it can broadcast it too. The page asks the buyer to confirm only once the
domain is in their account at their registrar.

A seller can cancel at any time before the buyer confirms. The cancellation
refunds the buyer, and it outranks a dispute and the seller's own "sent". A
seller who cancels after the domain reached the buyer gives the buyer both, so
the page says to cancel after "sent" only if the transfer failed.

Claim times are chosen by whoever signs them, so a backdated claim could move
a deadline that counted from it. None does: every deadline counts blocks from
the funding block, and the rules read only whether a claim exists, never the
time it states. That cuts both ways. A "sent" made after the transfer deadline
counts as much as one made before it, and so does a dispute, so the deadline
refunds the buyer only while there is no "sent" and no dispute. From the
deadline block on, with neither, the rules say refund, and the arbiter can
complete the buyer's refund on leaf C at once. Until it does, a late "sent"
puts the trade back to waiting for the buyer, who can then ask the arbiter to
decide, or wait for the timelock.

A seller can open escrows on one domain with two buyers. Only one of them can
end up with the domain. A seller who says "sent" in both stops both deadlines,
and the buyer who gets nothing asks the arbiter to decide, or waits for the
timelock. The arbiter's list marks escrows that name the same domain.

While an escrow is funded and neither confirmed nor cancelled, the page keeps
reading the registry, and shows everyone who opens the escrow a refusal that
appears, such as a pending delete or an expiry, and, once the seller has said
"sent", a move to another registrar under way.

Opening an escrow cannot be used to grief a seller. Opening is free and costs
the listing nothing, and an unfunded escrow lapses: a day after the views are
published, the page stops offering to fund it.

Anyone can pay an escrow address hundreds of dust outputs. Past 500 unspent
ones, mempool.space stops listing them, and the page can no longer read the
escrow. Nothing is lost: the parties use their own node or another Esplora,
and recover.html still sweeps the timeout. It costs the attacker their dust.

A published signature can't be turned into another payout. It commits to the
funding output, the leaf, the destination and the fee, and every page checks
it against the output as the chain shows it, never against an amount a party
states.

Nor can a signature be moved to another escrow between the same keys. The
internal key commits to the escrow id, so each id has its own address, and a
signature commits to the script of the output it spends. Without that, a party
could publish a view at a second id, a fresh salt with the same keys, where the
other side has said nothing, and have the arbiter settle the first escrow's coins
by the second one's rules.

A settlement can get stuck when fees rise. The paid side can bump it with a
child transaction that spends their own output. Settlement inputs also signal
RBF, and so do timeout spends, whose sequence field is the block count, far
below the 0xfffffffe cutoff, but the pages don't yet offer signing a payout
again at a higher fee.

### Attacks by the arbiter

The arbiter holds one key of three and decides disputes. It never holds the
domain, and needs no registrar account. What it can do, and what that costs
it:

- **Rule for the seller** when the buyer never got the domain. It completes
  the release the seller signed on leaf B, and the buyer loses the money.
- **Rule for the buyer** when the domain arrived. It completes the refund the
  buyer signed on leaf C, and the seller loses the domain and the money.
- **Rule against the rules.** Its page offers what the rules say and asks for
  an explicit tick to rule otherwise, but that is a page, not a lock: the
  arbiter key can co-sign whichever side's payout is signed. Once the seller
  has said "sent", both usually are.
- **Say nothing.** A dispute then waits until the timelock opens, and from then
  the buyer can take the money back alone. Silence favours the buyer: a seller
  whose buyer has the domain and won't confirm loses both.
- **Read what each side shows it,** read-only keys included, and with them
  every domain in the account a key reads, until it is deleted. It can't read
  the buyer and the seller's chat, or a transfer code in it.
- **Lose its key** to an attacker, who could then do all of the above in every
  escrow that names it, and read every chat it is in. Every payout it can
  complete still pays an address one of the parties signed.

None of this lets the arbiter move money alone. The leaf a payout used is on
chain for good, and a payout on leaf B or C carries the arbiter's signature,
ruling or no ruling. The page publishes each ruling, with its reason and the
arbiter's co-signature, once the payout is broadcast. A ruling is signed with
the arbiter key, so a copy verifies wherever it is kept, the record any party
can save from the escrow's page included, and the site's own relay refuses
deletion requests for rulings. A ruling sits at one address per escrow, so the
arbiter can replace it with a newer one, which is the one the pages count; the
older one still verifies wherever a copy was kept.

### Private messages

An escrow's three chats, and invites and replies sent privately, are NIP-17
(spec/PROTOCOL.md §10).

- **Who reads what.** Each pair of the escrow's three keys has its own chat:
  buyer and seller, buyer and arbiter, seller and arbiter. A message names
  exactly one recipient, among the other two keys, and is wrapped only for that
  recipient and for its author. So the arbiter reads nothing the buyer and the
  seller say to each other, transfer details and codes included, and neither
  side reads the other's chat with the arbiter. A message of the earlier
  three-way thread named two recipients, and is part of neither chat.
- **What a relay learns.** Each copy names the key it is for, and the escrow's
  keys are public in its views, so a relay can see that an escrow's keys are
  receiving messages, roughly how many, and their sizes. Times are backdated at
  random by up to two days. Nothing outside a copy names its author or the
  escrow, and nothing shows the words. Both copies of a message, the
  recipient's and the author's, go out at the same moment, so a relay that
  watches them arrive can guess which two keys a message went between, though
  not which way. relay.damus.io hands out gift wraps only to the key they name
  after it signs in (NIP-42), and the pages do; the other public relays hand
  them to anyone who asks, which is still only ciphertext, so on those relays
  anyone can learn as much as the relay does. A read that authenticates
  (NIP-42) uses a connection of its own and closes it after. The pages keep a
  plain read's connection open a few seconds for the next one (net/README.md),
  but never one that authenticated, so no other read is tied to the key.
- **Impersonation.** Every message is sealed by its author's key, and a chat
  keeps only messages sealed by one of the escrow's three keys, naming this
  escrow once and exactly one recipient, with the reader as its author or its
  recipient. Nobody outside the trade can write into a chat, and nobody inside
  can make a message look like another party's.
- **A note or a card is not a claim.** The pages leave a note in a chat as they
  act (a confirmation, a cancellation, a dispute, a ruling), and the transfer
  details travel as cards: the buyer's account goes to the seller, and the
  seller's word of how it sent the domain goes to the buyer. The pages read a
  card to fill in a form, and nothing reads a note or a card as evidence. The
  views and the ruling are the record, and the rules read only the views. A
  card that fails its check is dropped, and its text still shows.
- **Spam.** Anyone can send gift wraps to an escrow's keys. They cost the
  reader one failed decryption each, and none of them can reach a chat. A read
  asks each relay for at most 500, and a relay sends the newest, so a flood of
  fresh ones can push real messages out of a read. Messages a tab has read
  already stay on screen.
- **Lost messages.** A message counts as sent once a relay takes the
  recipient's copy, and the page says so when none does. A relay can still lose
  it, or never hand it out. When the seller has said "sent" and no transfer
  details are in the chat, both sides' pages say so, and the seller can send
  them again. If the buyer's account never reaches the seller and the seller
  never says "sent", the deadline refunds the buyer, and the seller keeps the
  domain. A view a relay drops hides a claim from whoever reads only that
  relay, so the page warns before funding, and before publishing a view again,
  when not every relay answered, and the arbiter's page asks for a separate
  tick before ruling on such a read.
- **A fake invite.** A private invite proves nothing by itself: the invite inside
  carries its own signature, the page shows who signed it, and the inbox lists
  only invites addressed to the reader and signed by whoever sent the message.
  The reader still has to know the npub they mean to trade with.
- **Deniability.** Rumors are never signed, and the pages offer no way to prove
  to a third person who wrote a message, so what one side shows the arbiter from
  its chat with the other is that side's word. The views and rulings are signed,
  and they, the registry's record and what the arbiter checks itself are what a
  dispute rests on.

## 5. Attacks on keys

Keys generated in the page as the fallback signer are encrypted at rest with
AES-256-GCM under a PBKDF2-SHA256 key (310,000 iterations), and the passphrase
never leaves the page. This is storage on one machine and not a backup:
clearing site data destroys it, and there is nobody to ask for a reset. The UI
forces a backup step and states the warning plainly.

Anything running on our origin can read that storage. A NIP-07 extension is
strictly better and is offered first.

Once unlocked, a page key stays usable while the user works on the site, if
"Keep it unlocked" is ticked, as it is by default, so the site's other pages and
tabs don't ask for the passphrase again. It is then held unencrypted in each
tab's sessionStorage, and a new tab gets it from one already open over a
BroadcastChannel, which only this site's tabs in the same browser can use; a tab
takes it only if it is the key stored in this browser now. Closing the tab is
not a lock: a browser that restores a closed tab, or a whole session, brings its
sessionStorage back, and may keep it on disk meanwhile. So a kept key locks
again once no open page of the site has used it for 8 hours, and at once when
the user disconnects, which clears every kept key, page and escrow alike, in
every open tab, connected or not. Any script on our
origin, in any tab, could read the key or ask a tab for it, as it could read the
unlocked key from the page's memory; the Content-Security-Policy, which runs no
foreign script here, is what keeps it out of other people's code. Unticking the
box keeps the key unlocked on one page only. The site's own arbiter key is never
kept or shared this way, even when it is a key made in the page. A NIP-07
extension is reconnected on each page by asking the extension again, and the
page never holds its key.

A buyer's or seller's escrow key, from their recovery string, is kept the same
way for the tab, one per escrow, with the same 8 hours, so a reload or a visit
to another page doesn't ask for the recovery string again. "Forget the key" or
disconnecting drops it.

Each side's escrow key is also backed up to their own Nostr account, encrypted
to their Nostr key (PROTOCOL.md §5, "Key backups"), so whoever holds that Nostr
key can open the escrow on any device. The side that opens the escrow backs its
key up as soon as it signs the invite, as a draft, so closing the page before
the reply comes loses nothing. That puts the escrow key behind the Nostr
key: someone who steals the nsec can read the backup, and holds what a stolen
recovery string gives. They could sign that side's payout to an address of
their own, which the other side or the arbiter might then complete, read that
side's chats, the buyer's account and any transfer code included, and with
the buyer's key take the timeout refund of an escrow nobody settled. So the
Nostr key has to be kept as carefully as the money in the escrow. Anyone can see
that an npub keeps flexmydomain escrow key backups, and how many. The events
don't say which escrows: the `d` tag is unrelated to the escrow, and only the
author can decrypt the content. A relay that sees a backup and an escrow's view
arrive from one connection moments apart could still link the two by timing.
A relay can drop a backup, so the page counts one only when at least two relays
(every relay, on a site that uses fewer) hand it back, asks for the recovery
string otherwise, and on mainnet always asks for the user's own copy before the
view is published. Whoever holds the key in a page can download the recovery
string again at any time.

A malicious signer extension could return a different pubkey than it
advertised, or alter `created_at` before signing. Either would produce a
proof that never verifies, discovered days later. Every signer response is
checked again against the event we asked it to sign.

Our own arbiter key is one of three and can move nothing alone. It signs
Bitcoin transactions directly, which a NIP-07 extension can't, so it is pasted
into the page when the arbiter acts and kept in that page's memory only: it is
never written to any storage, and a reload forgets it. Each page
loads its scripts only from its own origin under a Content-Security-Policy,
so an injected script can't run there to read it. The same key opens the
arbiter's chats in every escrow that names it, so whoever steals it also reads
what the parties told the arbiter, read-only keys they haven't deleted
included.

## 6. Attacks on us, and on you through us

We can be compelled to stop showing a listing. We cannot be made to remove it
from relays we do not run, and the filter for finding it is published, so
anyone can rebuild the view. There is no moderation list today: the market
shows every listing that verifies. If one is added, it will be a public,
forkable Nostr list rather than a private table.

Relays could be captured or could refuse us. Events are published to the
user's own NIP-65 write relays as well as to our five, so a user's events
survive on their own relays if ours refuse them. Discovery is another matter:
"every listing" has no author to route by, so the market finds listings only
on the five and any a deployment adds. If those refused us, existing users'
data would live on, but the market would show nothing new.

The supply chain is five pinned runtime dependencies, all `@noble` or
`@scure`, all audited, with almost no transitive tree. TypeScript is a dev
dependency and reaches neither the browser bundle nor the daemons. The browser
bundle is committed, so you can diff it against a build of your own. There is
no CDN, no analytics and no font fetched from a third party.

## 7. What we have not solved

- Nothing public shows which account holds a domain. RDAP gives the registrar,
  the statuses and the dates, never the account holder, and a push between two
  accounts at one registrar changes nothing in it. A dispute over such a push
  rests on the read-only proof each side chooses to show and on the arbiter's
  judgement, and a side that keeps the domain in another account of its own can
  show an empty one. Where nothing settles a dispute, our arbiter refunds the
  buyer (spec/ARBITER.md §7), so a buyer who hides a pushed domain that way may
  keep both it and the money.
- A seller who has transferred the domain is paid by the buyer's confirmation,
  or by a ruling the arbiter completes before the timelock opens. After that, a
  buyer who kept quiet can take the money back alone and keep the domain, and a
  release the arbiter completes then races the buyer's refund.
- A seller can be paid and then tell its registrar the transfer was theft.
  Nothing on chain undoes the payment. The seller's own view, with its signed
  "sent" and payout signature, and any ruling are the public record against
  the claim.
- ICANN keeps a domain at its registrar for 60 days after it was registered or
  last moved between registrars. In that time only a push to an account at the
  same registrar works, and the pages show the lock as a warning, not a
  refusal. After a move between registrars, the same lock holds the name at the
  buyer's registrar.
- Nothing notifies a seller who has closed the page that the escrow is funded,
  or a buyer that the domain was sent: the chats go to per-trade keys that only
  the escrow page reads. The arbiter key is a Nostr identity, so messages to it
  also go to the relays its kind 10050 list names, where its own client reads.
  The arbiter's list marks disputes but reads no chain, so a missed transfer
  deadline shows only on the escrow's own page.
- Escrow signing is unaudited. The tree, every settlement and the witness are
  built and verified against Bitcoin Core on regtest, but by nobody except
  their own tests. The deployment default is signet, and nothing in this
  repository should hold real money until someone else has reviewed it.
