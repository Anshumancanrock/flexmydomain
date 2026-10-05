# The flexmydomain protocol

This document specifies everything a second implementation needs. Where it
and the code disagree, the document is right and the code has a bug.

`spec/PROOF.md` defines the domain proof and is normative on its own.

## 1. Identity

A participant is a secp256k1 keypair (a Nostr key). There are no accounts,
passwords or registration. Everything below is signed by such a key.

Signing goes through NIP-07 where available. A NIP-07 extension cannot sign an
arbitrary message, only a NIP-01 event id, so every signature a Nostr key makes
in this protocol covers an event and never a bare string. Payout signatures are
made by escrow keys over BIP-341 sighashes (§8).

## 2. Event kinds

| kind | NIP | `d` identifier | what |
|---|---|---|---|
| 30078 | 78 | `fmd:proof:<domain>` | the domain proof (also a DNS TXT record) |
| 30078 | 78 | `fmd:portfolio` | every domain a key has proven |
| 30078 | 78 | `fmd:escrow:<id>` | one party's view of an escrow |
| 30078 | 78 | `fmd:ruling:<id>` | the arbiter's ruling on an escrow |
| 30078 | 78 | `fmd:key:<slot>` | a party's escrow key, encrypted to their own Nostr key (§5) |
| 30078 | 78 | `fmd:flex:<claim id>` | a claim on an on-chain flex payment (§11) |
| 30402 | 99 | `fmd:listing:<domain>` | a listing, for sale |
| 1985 | 32 | — | a trade receipt, written about the counterparty |
| 6970 | 90 | — | a verifier's attestation |
| 5970 | 90 | — | a request for one |
| 9734 / 9735 | 57 | — | featured-spot zaps, when the board takes Lightning |
| 10002 | 65 | — | where a key publishes |
| 30000 | 51 | `fmd:arbiters` | the arbiters a key accepts (§5) |
| 30000 | 51 | `fmd:watchlist` | domains a key is watching |
| 20078 | — | — | an escrow invite or reply, passed as a string and never published (§5) |
| 1059 | 17, 59 | — | a private message: one of an escrow's chats, or an invite or reply on its way (§10) |
| 10050 | 17 | — | where a key reads its private messages |
| 22242 | 42 | — | signing in to a relay, sent in an AUTH frame and never published |
| 7000 | 90 | — | a verifier's job feedback |
| 31990 | 89 | `fmd-client` | the site's handler for listings |
| 5 | 09 | — | a deletion *request* |
| 30009 / 8 / 30008 | 58 | — | badges |

Every extension tag is prefixed `fmd_`, because an unprefixed name would
squat on a namespace that other applications share.

Kinds 5970 and 6970 are our own choice within NIP-90's custom range. They are
not registered anywhere.

## 3. The listing

```json
{
  "kind": 30402,
  "pubkey": "<seller>",
  "tags": [
    ["d",            "fmd:listing:lumenary.com"],
    ["title",        "lumenary.com"],
    ["summary",      "A brighter internet."],
    ["price",        "2500000", "SATS"],
    ["status",       "active"],
    ["t",            "domain"],
    ["t",            "flexmydomain"],
    ["published_at", "1789000000"],

    ["fmd_domain",   "lumenary.com"],
    ["fmd_proof",    "<iat>", "<64-byte schnorr sig, hex>"],
    ["fmd_rdap",     "<sha256 of the RDAP snapshot>", "<observed at>"],
    ["fmd_created",  "<registration unix>"],
    ["fmd_arbiter",  "<x-only pubkey>"]
  ],
  "content": "<markdown>"
}
```

`fmd_rdap`, `fmd_created` and `fmd_arbiter` are optional. This site's listing
form writes none of them, and the escrow ignores `fmd_arbiter`: the arbiter
comes from each side's NIP-51 set (§5).

Prices are in satoshis. USD is for display only: it is never stored or signed,
and it is never part of an agreement.

### The rule every reader must apply

A listing is real when all of these hold:

1. the event's own signature verifies;
2. the `fmd_proof` signature verifies for this domain under this event's
   pubkey (the proof has no key field of its own, so the two cannot
   disagree);
3. the domain's DNS still carries a verifying record;
4. it has not passed its NIP-40 `expiration`, when it carries one.

Steps 1 and 2 run offline. Step 3 needs the network, and when it cannot run
the listing is reported as unverified, never as verified.

An unverified listing stays on the relays, and this rule is public. A reader
only declines to display the listing as real.

### Delisting

To delist, republish the listing with `status: sold`. That is the
authoritative signal: it is a positive statement, and it replaces the old
event on every relay it reaches.

A kind 5 deletion request is sent as well. Relays may ignore it, and anyone
who already holds the event keeps it.

## 4. The portfolio

One replaceable event per key, `d = fmd:portfolio`, content:

```json
{
  "v": 1,
  "domains": [
    { "domain": "lumenary.com", "source": "dns", "first_seen": 1780000000,
      "iat": 1789000000, "sig": "<hex>", "tagline": "…", "for_sale": true }
  ]
}
```

Keys are written in this order, `tagline` only when there is one and
`for_sale` only when true.

Each entry carries its own proof, so a reader can verify every domain offline
against the portfolio's pubkey. That shows only that the holder of this key
signed a claim to these domains at these times. To learn whether a zone still
agrees, resolve it again.

Entries are sorted by domain so that republishing an unchanged portfolio
produces identical bytes.

Republishing replaces the portfolio on every relay it reaches: the key's write
relays (at most five) and the discovery relays. So a client starts from the
newest version: it reads again just before, from every relay the key writes to
and from the discovery relays, and stamps the new event later than the one it
replaces. When some relay didn't answer, the newest version may be there, and
the user is told which relays and asked before going on. A portfolio the
client can't read in full, because its content doesn't parse, it has no
`domains` list, or an entry doesn't parse, is never replaced: republishing
would drop what the client couldn't read. The pages read the relay list
(kind 10002) and the watchlist again the same way before replacing them.

`first_seen` is kept when a domain is proven again. It is the holder's own
claim and nothing can check it, so a reader shows it as theirs and only clamps
what cannot be true: a date before 1985-03-15, when the first domain was
registered, or after the event that states it.

## 5. The escrow

The escrow is a BIP-341 Taproot output with no key path, an internal key bound
to the escrow id (below), and a script tree of four leaves:

```
  A  <BUYER> OP_CHECKSIGVERIFY <SELLER> OP_CHECKSIG     buyer and seller together
  B  <SELLER> OP_CHECKSIGVERIFY <ARBITER> OP_CHECKSIG   pays the seller, under the rules
  C  <BUYER> OP_CHECKSIGVERIFY <ARBITER> OP_CHECKSIG    refunds the buyer, under the rules
  D  <N> OP_CHECKSEQUENCEVERIFY OP_DROP <BUYER> OP_CHECKSIG   the buyer alone, after N blocks
```

These are the exact leaf scripts, keys x-only and `N` a minimal push, and the
tree is `((A, B), (C, D))`. They are written out rather than as miniscript,
since the address depends on every byte and miniscript's `v:older` compiles
to `OP_VERIFY`, not `OP_DROP`.

No leaf spends with the arbiter key alone. That is a property of the tree, and
a negative test asserts it.

Every escrow has an arbiter, who decides a dispute (§8) and never holds the
domain, and the timeout always refunds the buyer. `core/escrow` can still
build a two-leaf tree with no arbiter (A, and D paying whichever side
`timeoutTo` names), and `scripts/escrow-signet.ts` makes one for a bare test
escrow, but no page opens one: both sides' pages refuse terms without an
arbiter. The timelock and the transfer window of §8 are the deployment's own
values (`SITE_RULES` in `core/escrow/trade.ts`; on mainnet 4320 and 1008
blocks, on the test networks 144 and 12), and both sides' pages refuse other
terms, whoever proposes them (`termsProblem` in `core/nostr/handshake.ts`).

### Opening an escrow

The two sides agree on the terms with an invite and a reply. Each is a kind
20078 event signed by the sender's Nostr key, passed as a string
(`fmdinv5…`, `fmdrep5…`) and never published, though either may travel inside a
private message (§10). The invite carries the salt, the terms (domain, amount,
network, the timelock, the transfer window and the arbiter), the initiator's
escrow key and the Nostr key of the one person it is for:

```json
{"v":5,"salt":"<64 hex>","domain":"lumenary.com","amountSats":2500000,"network":"mainnet",
 "timeoutBlocks":4320,"deliverBlocks":1008,"arbiter":"<64 hex>","initiatorRole":"buyer",
 "initiatorKey":"<64 hex>","to":"<the invited Nostr key, 64 hex>"}
```

with tags `["t", "fmd-invite"]` and `["p", <to>]`. The reply carries
`{"v":5,"invite":"<the invite's event id>","joinerKey":"<64 hex>"}` with tags
`["t", "fmd-reply"]`, `["e", <invite id>]` and `["p", <inviter>]`. Neither holds
a secret, and neither says anything about where the domain goes: the buyer
tells the seller that after funding, in their private chat (§8, §10). A string
from an earlier version (`fmdinv1…4`, `fmdrep1…4`) is refused with a reason.

The signatures matter because escrow keys identify nobody. Without them,
whoever saw the invite link first could answer it with a key of their own and
become the counterparty. A reply from any other key, or to an earlier invite
with other terms, is refused.

An arbiter must be accepted by both sides. A side may publish the arbiters it
accepts as a NIP-51 set (kind 30000, `d = fmd:arbiters`, one `p` tag per
arbiter) from any Nostr client; no page here publishes one yet. A side with no
set accepts only the deployment's own arbiter. One side's list never decides
alone, since a counterparty could list its own second key and hold two of the
three. The escrow page looks for sets on the discovery relays, and when none
of them answers it offers no arbiter rather than guessing.

### The escrow id

The id is the hex of

```
sha256(utf8("fmd:escrow:v5") || salt || buyer_x || seller_x || arbiter_x ||
       utf8("buyer:<timeout_blocks>:<deliver_blocks>:<network>:<amount_sats>:<domain>:"))
```

with the salt and the three keys as raw bytes (32 each) and the domain
normalised, all 32 bytes of the hash, since the joiner picks a key after seeing
the invite and could grind a shorter id into a collision. No term can contain a
colon: numbers, a network name and a normalised domain. The id covers every
term both sides agreed to, so a view
that changes any of them lands at another id. A reader keeps only views whose
own parameters derive the id they asked for, each carrying exactly one `d`
tag.

### The internal key

The internal key is the x coordinate of `P = H + r·G`, where `H` is the BIP-341
NUMS point (x = `50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0`,
the SHA-256 of the uncompressed generator) and
`r = int(tagged_hash("fmd/escrow-binding", id))`, a BIP-340 tagged hash of the 32
id bytes. Nobody knows the discrete log of `H`, so nobody knows that of `P`, and
anyone can recompute `P` from the id.

The leaves depend only on the keys and the timelock. Without the binding, two
escrows with the same keys would share an address. A party could publish a view
at a second id, a fresh salt with the same keys, where the other side has said
nothing, and have the arbiter settle it by the rules of §8. The arbiter's
signature would spend the first escrow's coins. With the id in the internal key,
every id has its own address, and BIP-341 signatures commit to the script of the
output they spend, so a signature made for one escrow can't spend another's. The
recovery string carries the id for the same reason.

The deployment's arbiter is never offered when it is one of the two parties,
and neither is either party's own key: an arbiter who is also the seller holds
two of the three keys.

### Views

Escrow state is derived from signed events and chain data. There is no server
state machine. The buyer and the seller each publish their own view, and
where the views disagree, the disagreement is public and permanent.

Each view is signed by that party's escrow key, the key inside the tree, and
never by their Nostr identity. A participant is whoever holds a tree key,
because that is the only thing a stranger reading the escrow can check, and a
view signed by any other key is ignored. Escrow keys are fresh for each trade,
so a view links to no identity at all.

A view carries the terms, so anyone can re-derive the address and the id, and
its author's own progress:

| field | author | means |
|---|---|---|
| `sent` | seller | the seller has transferred the domain to the buyer, or started the registrar's transfer to them |
| `cancelled` | seller | no sale: refund the buyer (with a reason) |
| `received` | buyer | the domain is in the buyer's account at their registrar |
| `disputed` | either | let the arbiter decide (with a reason) |
| `sigs` | either | signatures on payouts (§8) |

A view with a claim its author may not make, or a signature on a leaf its
author is not in, is refused, and so is one carrying a claim of an earlier
version (`pushed`, `dispute`). A claim's time is chosen by its author, so no
deadline depends on it. It is whole seconds from 0 to 4294967295, and a view
with any other is refused. A reason is text of at most 2,000 characters. Where
the domain goes, and any transfer code, is never in a view: the buyer and the
seller say that in their private chat (§10).

The content of a view, with every field that can appear, in the order they are
written. Optional fields appear only when set, and a real view carries only the
ones its author may state:

```json
{
  "v": 5, "id": "<escrow id>", "salt": "<64 hex>",
  "buyer_x": "<64 hex>", "seller_x": "<64 hex>", "arbiter_x": "<64 hex>",
  "timeout_to": "buyer", "timeout_blocks": 4320, "deliver_blocks": 1008,
  "network": "mainnet", "address": "bc1p…", "amount_sats": 2500000, "domain": "lumenary.com",
  "listing": "<naddr>", "deadlines": { "fund_by": 1789086400 },
  "sent": { "at": 0 }, "cancelled": { "at": 0, "reason": "…" }, "received": { "at": 0 },
  "disputed": { "at": 0, "reason": "…" },
  "sigs": [{ "kind": "refund", "leaf": "C", "outpoint": "<txid>:<vout>", "dest": "bc1…", "fee": 300, "sig": "<128 hex>" }]
}
```

A view of an earlier version is refused with a reason that says so, and so is
a version 5 view carrying any field of the custody flow (`registrar`,
`custody_account`, `deliver_to`, `return_to`, `deliver_to_enc`,
`return_to_enc`, `forward_blocks`): a field this version doesn't define would
be a term nobody agreed to. Version 4 escrows, where the arbiter held the domain
between the two sides, are not run by this version; their money is safe on
chain, and a funded one is still refunded by its timelock with `recover.html`,
as are those of versions 1 to 3.

Its tags are `d = fmd:escrow:<id>`, `t = flexmydomain`, `fmd_domain`, a `p` for
each of the three keys, and an `a` naming the listing when there is one.

A ruling is a kind 30078 at `d = fmd:ruling:<id>`, signed by the arbiter key,
with tags `t = flexmydomain`, `fmd_escrow` and a `p` for each party, and content
`{ v: 1, escrow, decision, reason, settlement, txid }`: the decision `release`
or `refund`, a reason of 1 to 2,000 characters, and optionally the arbiter's
co-signature and the payout's txid. A reader counts a ruling only when its
author is the arbiter that the escrow's own views name, and of several the
newest counts.

### The recovery string

Each side's page gives it a recovery string before anything is paid. It is
`fmdrec1` followed by the unpadded base64url of a payload and its checksum, the
first 4 bytes of the payload's SHA-256. The payload is:

| bytes | field |
|---|---|
| 1 | version, 1 |
| 1 | flags: 1 an arbiter key follows, 2 the timeout pays the seller, 4 a funding outpoint follows, 8 a binding follows |
| 2 | timeout blocks, big-endian |
| 32 | this side's escrow secret key |
| 32 | buyer x-only key |
| 32 | seller x-only key |
| 32 | arbiter x-only key, with flag 1 |
| 32 | the binding, the escrow id the internal key commits to, with flag 8 |
| 32 + 4 + 8 | the funding txid as displayed, vout little-endian, amount in sats little-endian, with flag 4 |

A reader refuses any flag it doesn't know, a short field and trailing bytes,
so a string from a newer page is refused rather than half read. Without the
binding, the address it rebuilds is the unbound one of older escrows.

### Key backups

So that nobody has to copy the recovery string around, each side's page also
backs it up to that side's own Nostr account: a kind 30078 signed by the Nostr
key, its content the NIP-44 encryption, by that key to itself, of

```json
{"v":1,"recovery":"fmdrec1…","id":"<escrow id>","role":"buyer","domain":"lumenary.com","amountSats":2500000,"network":"signet","at":1791000000}
```

with exactly two tags, `["d", "fmd:key:<slot>"]` and a NIP-31 `alt` reading
`An encrypted flexmydomain escrow key backup`, and a content of at most 4,096
characters; our relay keeps nothing else in this namespace. The slot is the first
16 bytes, in hex, of `SHA-256("fmd/key-backup-slot" || escrow secret key)`: the
same for one escrow every time, so a second backup replaces the first, and
unrelated to anything public, so the event itself doesn't say which escrow it
belongs to. Only the author can decrypt it. A relay that sees the backup and the
escrow's view arrive from one connection moments apart could still guess they
go together; the backup's content stays unreadable to it.

A reader takes a backup only after decrypting it, checking every field, and
checking that the recovery string's binding is the `id` it names; the page then
rebuilds the key and checks it against the escrow's views like any other.
The page counts a backup as kept only once at least two relays (every relay, on
a site that uses fewer) hand it back when asked for it. On a test network that
is enough to publish the view; otherwise, and always on mainnet, the user saves
the recovery string themselves first. Relays can drop events, so for real money
a backup is a convenience on top of the recovery string, never the only copy.
Whoever holds the key in a page can download the recovery string again at any
time.

The side that opens an escrow holds its key from the moment it signs the invite,
before any escrow exists to bind a recovery string to. Its page backs that key
up at once as a draft, at the same `d` and in the same way:

```json
{"v":1,"draft":true,"invite":"fmdinv5…","key":"<escrow secret key, hex>","role":"buyer","domain":"lumenary.com","amountSats":2500000,"network":"signet","at":1791000000}
```

A reader takes a draft only if the key is the one the invite names and the role,
domain, amount and network are the invite's. A field it doesn't know, such as
the account an earlier draft carried, is dropped. With it a page picks the invite up again in any tab, on any device,
and finds the reply sent to the invite's key meanwhile, since the reply waits on
the relays as a private message. Once the reply is in, the escrow's own backup
is written at the same `d`, strictly newer, and replaces the draft. A page that
picks up a draft whose view is out already opens the escrow rather than
publishing a fresh view over it.

> Status: built and verified. `core/escrow/` derives the tree, builds and
> signs every settlement, and assembles the witness.
> `test/regtest/e2e.test.ts` spends every leaf against Bitcoin Core, proves the
> timeout leaf is rejected before its timelock and accepted after, and proves
> no leaf is spendable by the arbiter alone. `test/regtest/settle.test.ts`
> runs each payout of §8 the way the pages do: signed by one side, completed
> later by the other key, accepted by the node. `test/vectors/transfer-flow.test.ts`
> runs a whole trade over a relay: the handshake, the views, both private
> chats with their cards, a dispute and a ruling.

## 6. Trade receipts

On settlement, each party can publish a kind 1985 label about the other. No
page publishes or shows receipts yet:

```json
{
  "kind": 1985,
  "pubkey": "<buyer>",
  "tags": [
    ["L", "fmd.trade"], ["l", "settled", "fmd.trade"],
    ["p", "<seller>"], ["a", "30402:<seller>:fmd:listing:lumenary.com"],
    ["fmd_escrow", "<id>"], ["fmd_funding", "<txid>:<vout>"],
    ["fmd_settle", "<txid>"], ["fmd_amount", "2500000"],
    ["fmd_domain", "lumenary.com"], ["fmd_role", "buyer"],
    ["fmd_transfer", "<sha256 of the RDAP snapshot showing the transfer>"]
  ]
}
```

Kind 1985 is regular, so nobody can replace the receipt their counterparty
wrote about them. Each side attests about the other, never about itself.

One receipt alone does not show a trade. Only a matched pair is evidence: each
receipt names the other's author, and the two agree on txids, amount and
domain. Where a pair disagrees, the disagreement is recorded and left
unresolved.

A trade with no `fmd_transfer` is shown with a weight of zero. Volume is nearly
free to fake; a registrar transfer is not. A move between two accounts at one
registrar shows nowhere in RDAP, so such a trade carries no `fmd_transfer` and
weighs zero. No page shows receipts yet.

No score is published. Each reader computes the weighting from their own
follow graph.

## 7. Relays

Events are published to the author's own NIP-65 write relays. An author's
events are read from the relays that author writes to, rather than from ours
or the reader's. Our five relays are a fallback for keys with no relay list,
never a replacement for one.

```
wss://relay.damus.io  wss://nos.lol  wss://relay.primal.net
wss://nostr.oxtr.dev  wss://nostr.mom
```

Discovery ("show me every listing") has no author to route by, so it sweeps
the fallback relays and any that a deployment adds. A sweep finds only what is
on the relays it asks, so every event meant to be discovered (a listing, its
deletion, a proof, a portfolio) is published both to the author's own write
relays and to the discovery relays.

A deployment may add its own relay to the discovery set (`extraRelays`).
`services/relay/` is one: strfry with a write policy that stores only the
events this protocol defines, in the shapes it defines, plus a mirror that
streams those events from the fallback relays and backfills from the ones that
support negentropy. Its `COUNT`s therefore cover what the public relays hold,
not only what was sent to it. It is a sixth relay and not a source of truth:
nothing may depend on it, and deleting it loses nothing that the public relays
do not also hold. A UI that shows counts must present them as counts from the
relays it asked, not from the whole network.

## 8. The transfer: straight from seller to buyer

The seller moves the domain straight to the buyer, the registrar's usual way,
at any registrar. There are two ways, and the seller picks one:

- a push: a move to the buyer's account at the same registrar, which
  registrars call a push, a change of account or a transfer of ownership;
- a transfer: the seller turns off the transfer lock and gives the buyer the
  domain's transfer code (the auth or EPP code), and the buyer starts the
  transfer at their own registrar, which takes up to about a week.

The buyer confirms once the domain is in their account, which pays the seller.
Either side can instead ask the arbiter to decide. The arbiter never holds the
domain: it weighs the registry's public record and the proof each side shows
it, and co-signs one side's own payout (§5). It can't move the money alone.

### Before anything is paid

Each side's page reads the domain's RDAP record when the escrow opens, and
again before it says the escrow is ready to fund (`registrarFindings` in
`core/escrow/registrar.ts`). A name that is leaving its registrar
(`pendingTransfer`), being deleted, restored or renewed, expired, or expiring
within 45 days stops the escrow, and so does a TLD with no RDAP service over
HTTPS or a name the registry says isn't registered. A transfer lock, an update
lock, a hold, a missing expiry, and a registration or move between registrars
in the last 60 days (ICANN's lock on moving to another registrar; a push
still works) are warnings both sides see. The registrar itself is shown and
never refused. While the escrow is funded and the buyer hasn't confirmed, the
pages keep reading the record: a new refusal is reported, and a pending
transfer after the seller says it is sent is shown as the move under way.

### Where the domain goes

Nothing about either side's account is in a view, the invite or the reply.
After funding, the buyer tells the seller where to send the domain in their
private chat (§10) with a `transfer-to` card: the registrar, the username or
account id there, and optionally the email on that account. The seller sends
it, and says so, with a `transfer-sent` card in the same chat: the method,
`push` or `code`, the transfer code when the method is `code`, and an optional
note. The arbiter can't read that chat. The buyer can send a new `transfer-to`
card, and the seller a new `transfer-sent` card, at any time; the newest of
each kind counts.

### Deadlines

Every deadline counts blocks from F, the height of the block that confirmed
the funding output. Claim times are chosen by their authors; F is chosen by
nobody.

| from block | rule |
|---|---|
| F + deliver_blocks | if the seller hasn't said the domain is sent, the rules refund the buyer |
| F + timeout_blocks | the buyer can take the refund alone through leaf D |

The timelock must leave at least 72 blocks (about 12 hours) after the transfer
deadline (`MIN_ARBITER_BLOCKS`): the arbiter's time to look into a dispute.
That floor only refuses terms. The site's rules leave 3,312 blocks on mainnet
and 132 on the test networks, and a payout completed after the timeout opens
races the buyer's lone refund, so a seller whose buyer doesn't confirm asks for
a ruling well before it.

### The rules

`arbiterRule` in `core/escrow/trade.ts` applies these, in this order, to the
latest view of each side and the chain tip:

1. the buyer said received: release;
2. the seller cancelled: refund;
3. either side asked the arbiter to decide: the arbiter decides;
4. the seller said sent: wait for the buyer, or a ruling;
5. the transfer deadline has passed: refund;
6. otherwise, wait.

Each side's word against its own interest comes first. A `sent` claim stated
after the transfer deadline still counts, since its time is the seller's own
word: a buyer who disputes it asks the arbiter, and an arbiter that has
already refunded under rule 5 has ended the trade.

Every page runs the same function on the same public facts, and the arbiter's
page offers what it returns. A ruling against it needs an explicit override,
except when the rules say the arbiter decides, and every ruling is published
with its reason (spec/ARBITER.md).

### Disputes

A `disputed` claim, from either side, carries a reason, and the page also
sends it to the arbiter in that side's own chat with it (§10). The arbiter then
weighs:

- the registry's RDAP record, read live on its escrow page: the registrar's
  name and IANA id, the statuses (a transfer lock, a pending transfer), the last
  transfer and last change dates against when the escrow opened, the expiry
  and the nameservers. A move to another registrar shows as a new registrar
  and new dates. A push between two accounts at one registrar doesn't show in
  RDAP at all;
- read-only proof it asks each side for, in its own chat with that side: best
  a registrar API key that can only read, which the arbiter checks on its own
  computer, never in a web page, since a registrar's API answers only about the
  domains in that key's own account. Never a password, a login code or a
  transfer code.

It then co-signs the payout the evidence supports: the seller's release on leaf
B, or the buyer's refund on leaf C, and publishes the ruling. A side can still
settle without the arbiter: the buyer by confirming, the seller by cancelling.

### Settlement

A payout is one transaction: the funding output in, one output out, the whole
amount less the fee. The side it pays proposes it and signs it first. The
seller signs a release on leaves A and B when it says the domain is sent, or
any time after, and the buyer a refund on leaves A and C, best right after
funding. The proposer fixes the destination and the fee, and the sighash
commits to both, so a published signature completes only that one
transaction. The second signature completes it:

| payout | signed first by | completed by |
|---|---|---|
| release, leaf A | seller | buyer, on "received" |
| release, leaf B | seller | arbiter, by the rules or a ruling |
| refund, leaf A | buyer | seller, on "cancelled" |
| refund, leaf C | buyer | arbiter, by the rules or a ruling |

A buyer who confirms before the seller has signed a release records the claim
alone, and the release is completed once the seller signs it: by the buyer's
page, or by the arbiter, since the rules then say release.

Signatures travel in views as `{kind, leaf, outpoint, dest, fee, sig}`, signed
by the view's author, and the arbiter's in its ruling. A reader checks each
against the funding output as the chain shows it, never against an amount a
party states, and any page can broadcast a pair that completes. A view keeps
one signature per kind and leaf, and a new one replaces the old there, but
the old one stays valid for anyone who saw it. Confirming receipt therefore
can't be taken back.

### Reading the chain

Funding is the oldest confirmed unspent output to the address that pays at
least the amount, read from the address's UTXO set. Settlement is read from
the address's full history, paged until every transaction is in. A history
too long to read is reported as such, never taken as "not spent". The leaf a
spend used is read from its witness, and a spend still in the mempool is
shown as settling, not settled. Once the escrow has paid out, any later
payment to the address is extra, and the pages offer only the timeout to
return it.

### What this does not solve

- In a dispute, the arbiter decides on evidence it can be shown, and evidence
  can be faked: a screenshot proves little, and a read-only API key proves only
  what that one account holds. A move between two accounts at one registrar is
  invisible to anyone but that registrar. What the protocol adds is that every
  ruling is signed, public and permanent, with its reason.
- A buyer who has the domain can stay silent and never confirm. The seller
  then asks the arbiter to decide before the timeout; after it, the buyer can
  take the money back alone through leaf D.
- A transfer code is a secret for as long as the transfer is open. It travels
  only in the buyer and seller's chat, encrypted to the two of them, and the
  seller can make the registrar issue a new one.
- A seller can be paid and then tell the registrar its account was taken over
  and the move was theft. Nothing on chain undoes a payment, and the chats,
  the views and any ruling are the record against that claim.
- After a change of registrant, or a move to another registrar, ICANN's
  60-day lock can stop the buyer moving the name to another registrar for a
  while.
- Domains whose registry has no RDAP service over HTTPS can't be checked, so
  they can be listed and flexed but not escrowed.

## 9. Attestations

A verifier resolves a proof again from its own network and publishes a kind
6970:

```json
{ "v": 1, "domain": "…", "claimant": "…", "verdict": "proven|absent|unreachable",
  "source": "dns", "iat": 0, "dnssec": true, "resolvers": ["cloudflare","google"],
  "observed_at": 0 }
```

`unreachable` means not every resolver answered, so nothing could be agreed,
and it says nothing about the domain. Recording it as `absent` would make one
verifier's network problem look like a vanished proof to everyone reading.

A reader counts distinct verifiers from a trusted set they choose, against a
threshold they choose. An attestation never replaces resolving the record
yourself.

## 10. Private messages

Messages between the people in a trade are NIP-17: a kind 14 rumor, never
signed, sealed (kind 13) and signed by its author, then gift-wrapped (kind 1059)
by a one-off key, once for each recipient. The seal and the wrap are backdated
by up to two days at random. A relay sees, for each wrap, the key it is
addressed to and a false time, and nothing of the author, the content or the
escrow.

### An escrow's chats

Each pair of the escrow's three keys has its own chat: the buyer and the seller,
the buyer and the arbiter, the seller and the arbiter. So the arbiter never
reads what the buyer and the seller say to each other, transfer details and
codes included, and each party talks to the arbiter alone. The keys are the
escrow's own: the two parties' per-trade keys and the arbiter key, all named in
the views. A message is one rumor from one of the three to exactly one other,
naming the escrow inside the encryption:

```
kind 14, pubkey <sender's escrow key>
tags: ["p", <recipient's escrow key>], ["fmd_escrow", <escrow id>],
      ["subject", "flexmydomain escrow <first 12 hex of the id>"],
      and for a card, ["fmd_card", <the card as JSON>]
content: the message, 1 to 2000 characters after trimming
```

It is wrapped once for its recipient and once for its author, so both pages
of the pair read the chat back, and published to the escrow's relays. The
arbiter key is also a Nostr identity, so a copy for the arbiter key goes as
well to the relays its own kind 10050 list names, where its usual client reads.

A card is a message the page also reads as a form's result (§8):

```json
{"kind":"transfer-to","registrar":"Namecheap","account":"buyer_77","email":"buyer@example.com"}
{"kind":"transfer-sent","method":"code","code":"<the transfer code>","note":"…"}
```

Only the buyer sends `transfer-to`, and only to the seller; only the seller
sends `transfer-sent`, and only to the buyer. `account` is required, the
registrar and the email may be empty; `code` is required when the method is
`code`. Fields are at most 100 (registrar), 200 (account), 254 (email), 500
(code) and 1,000 (note) characters (`cardProblem` in
`core/nostr/escrow-chat.ts`). The message's text says the same in words, so any
Nostr client shows it.

A reader asks the escrow's relays for kind 1059 addressed to its own escrow key,
opens what it can, and keeps a message only when one of the escrow's three keys
sealed it, it names this escrow exactly once, it names exactly one recipient,
and the reader is its author or that recipient (`escrowChats`). A card that
doesn't check out is dropped and its text kept. Messages of the three-way
thread an earlier version wrote, naming both other keys, are left out. Each
message shows once, however many copies arrive, oldest first by the time its
author stated.

The pages also write in the chats themselves: the buyer's `transfer-to` card
to the seller and its confirmation of receipt; the seller's `transfer-sent`
card to the buyer and its cancellation; a side's dispute, with its reason, to
the arbiter; the arbiter's requests for proof, and its ruling to each side.
Those messages say what happened; the views and the ruling remain the record.

### Invites and replies

An invite may go privately to the one key it is for: a rumor from the
initiator's Nostr key to the invited key, carrying the invite link and an
`["fmd_invite", <invite event id>]` tag, wrapped only for the invited key and
published to the relays its kind 10050 list names and to the discovery relays.
It shows in the recipient's own Nostr messages, and the escrow page lists, for a
connected key, the invites in its messages from the last two weeks, keeping
only those whose invite is addressed to that key and was signed by the key that
sealed the message. The message proves nothing on its own: the invite inside
carries its own signature, which the joiner's page checks as in §5.

The reply goes back without the joiner's Nostr key at all: a rumor from the
joiner's new escrow key to the initiator's escrow key, which the invite names,
carrying the reply string and an `["fmd_reply", <invite event id>]` tag. Only
the initiator's open tab holds that key, and it looks for such a message every
few seconds while it waits, using the first reply that `decodeReply` accepts
for its own invite.

### Signing in to relays

Some relays hand a key its gift wraps only after it signs in (NIP-42), as
relay.damus.io does. A page answers a relay's challenge with a kind 22242,
signed by the key whose messages it is reading, only for those queries, so
the relay learns that key reads its messages and nothing more. A query the
relay closed as `auth-required:` is sent once more after the relay accepts. The
same holds for a publish refused as `auth-required:`.

## 11. Flex payments on chain

A site can take flex payments on chain instead of as Lightning zaps, by setting
`flexAddress` (and `flexNetwork`) in its config. The live site does this on
signet. A Bitcoin payment carries no domain, so the payer first signs a claim:

```json
{
  "kind": 30078,
  "pubkey": "<payer>",
  "tags": [
    ["d", "fmd:flex:<16 to 64 hex>"],
    ["t", "flexmydomain"], ["t", "fmd-flex"], ["t", "fmd-flex-10123"],
    ["fmd_domain", "lumenary.com"],
    ["fmd_amount", "10123"],
    ["fmd_address", "tb1q…"]
  ],
  "content": ""
}
```

Then they pay at least `fmd_amount` sats to `fmd_address`: the amount is a
minimum, and a bigger payment counts in full. The page asks for the price it
shows, unless an open claim from the last day is within 10 sats of it, or a
payment from the last day is at most 10 sats above it; then it adds a few odd
sats so the payments stay apart.

To count the board, a reader takes every output paid to the address and every
claim for it from the relays, and keeps claims made no more than a day before a
payment and no more than 15 minutes after it. A payment never counts for a claim
above it. Payments at most 10 sats above a claim are paired first, each with the
closest such claim, because those odd sats name it; some wallets also add a sat
or two. Then each larger payment, oldest first, takes the closest open claim
below it. A claim made before the payment beats one made after it, then the
closer amount wins, then the earlier claim. The domain is credited with what was
actually paid. A payment still in the mempool counts at the time it is read.
Each claim and each output is used once, and a payment nobody claimed counts for
nothing.

Nothing in the payment points back at its claim, so someone who sees a payment
can sign a backdated claim for the same amount and take the credit, and a payment
bigger than its claim can land on another open claim closer below it. On test
coins that costs nothing worth protecting. Real money needs an address per
claim, or the Lightning zaps above, whose receipts the provider signs.

