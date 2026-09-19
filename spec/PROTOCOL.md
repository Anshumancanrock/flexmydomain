# The flexmydomain protocol

This document specifies everything a second implementation needs. Where it
and the code disagree, the document is right and the code has a bug.

`spec/PROOF.md` defines the domain proof and is normative on its own.

## 1. Identity

A participant is a secp256k1 keypair (a Nostr key). There are no accounts,
passwords or registration. Everything below is signed by such a key.

Signing goes through NIP-07 where available. A NIP-07 extension cannot sign an
arbitrary message, only a NIP-01 event id, so every signature in this protocol
covers an event and never a bare string.

## 2. Event kinds

| kind | NIP | `d` identifier | what |
|---|---|---|---|
| 30078 | 78 | `fmd:proof:<domain>` | the domain proof (also a DNS TXT record) |
| 30078 | 78 | `fmd:portfolio` | every domain a key has proven |
| 30078 | 78 | `fmd:escrow:<id>` | one party's view of an escrow |
| 30402 | 99 | `fmd:listing:<domain>` | a listing, for sale |
| 1985 | 32 | — | a trade receipt, written about the counterparty |
| 6970 | 90 | — | a verifier's attestation |
| 5970 | 90 | — | a request for one |
| 9734 / 9735 | 57 | — | featured-spot zaps |
| 10002 | 65 | — | where a key publishes |
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

Prices are in satoshis. USD is for display only: it is never stored or signed,
and it is never part of an agreement.

### The rule every reader must apply

A listing is real when all three hold:

1. the event's own signature verifies;
2. the `fmd_proof` signature verifies for this domain under this event's
   pubkey (the proof has no key field of its own, so the two cannot
   disagree);
3. the domain's DNS still carries a verifying record.

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
    { "domain": "lumenary.com", "source": "dns", "iat": 1789000000,
      "sig": "<hex>", "first_seen": 1780000000, "tagline": "…", "for_sale": false }
  ]
}
```

Each entry carries its own proof, so a reader can verify every domain offline
against the portfolio's pubkey. That shows only that the holder of this key
signed a claim to these domains at these times. To learn whether a zone still
agrees, resolve it again.

Entries are sorted by domain so that republishing an unchanged portfolio
produces identical bytes.

`first_seen` is kept when a domain is proven again. It is the only number on a
flex page that cannot be manufactured on the spot.

## 5. The escrow

The escrow is a BIP-341 Taproot output with an unspendable NUMS internal key
and a script tree, parameterised by whether there is an arbiter:

```
with an arbiter (four leaves)
  A  and_v(v:pk(BUYER),pk(SELLER))        cooperative, no third party
  B  and_v(v:pk(ARBITER),pk(SELLER))      dispute, resolved for the seller
  C  and_v(v:pk(ARBITER),pk(BUYER))       dispute, resolved for the buyer
  D  and_v(v:older(N),pk(TIMEOUT_PARTY))  the backstop

without an arbiter (two leaves)
  A  and_v(v:pk(BUYER),pk(SELLER))
  D  and_v(v:older(N),pk(TIMEOUT_PARTY))
```

No leaf spends with the arbiter key alone. That is a property of the tree, and
a negative test asserts it.

The timeout party is a parameter. With an arbiter it is normally the buyer.
With no arbiter it must be the seller, because nothing else stops a buyer who
already has the domain from waiting out the clock; the no-arbiter mode is only
safe with the timeout reversed this way.

Escrow state is derived from signed events and chain data. There is no server
state machine. Each of the three parties publishes its own view, and where the
views disagree, the disagreement is public and permanent.

Each view is signed by that party's escrow key, the key inside the tree, and
never by their Nostr identity. A participant is whoever holds a tree key,
because that is the only thing a stranger reading the escrow can check, and a
view signed by any other key is ignored. Escrow keys are fresh for each trade,
so a view links to no identity at all.

> Status: built and verified. `core/escrow/` derives the tree, builds and
> signs the settlement transaction, and assembles the witness.
> `test/regtest/e2e.test.ts` spends every leaf against Bitcoin Core, proves the
> timeout leaf is rejected before its timelock and accepted after, and proves
> no leaf is spendable by the arbiter alone.

## 6. Trade receipts

On settlement, both parties publish a kind 1985 label about the other:

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
free to fake; a registrar transfer is not.

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

## 8. The transfer, without touching a registrar

A domain sale needs a registrar transfer, and the seller's domain can be at
any registrar in the world. The protocol integrates with no registrar. Holding
registrar API keys, or becoming a reseller and moving names between accounts
we control, would make us the custodian of the asset: we would hold the domain
and could refuse to hand it over, which is the trusted intermediary the
Bitcoin side is designed to remove. A reseller push has a further cost: under
ICANN's Transfer Policy a change of registrant also starts a 60-day lock, so
the buyer would receive a name they could not move out of our infrastructure
for two months.

The parties transfer the domain themselves, as in any other domain sale, and
the escrow watches the transfer through RDAP. RDAP is public and read-only,
needs no key, account or contract, and answers the same way for every
registrar.

| observed in RDAP | means | gates |
|---|---|---|
| `clientTransferProhibited` seen present, then absent | only the registrant can change it | funding |
| `pendingTransfer` present | the transfer is underway | point of no return |
| registrar IANA id or nameservers match the buyer's commitment | the registry agrees it moved | release |
| it matched, and then stopped matching | a registrar reversal | dispute |

The order is fixed: the seller changes the lock, the buyer funds, and only
then does the seller send the auth code. A `pendingTransfer` seen before
funding therefore blocks funding, because that transfer was started by
somebody who has not paid.

### The buyer's commitment

Since GDPR the registrant is redacted almost everywhere, so RDAP shows that a
name moved and to which registrar, but never to whom. The buyer therefore
states, before funding, where they will receive the domain: a registrar IANA
id, a set of nameservers, or both.

There are two fields because either one alone misses a case. An
inter-registrar transfer changes the IANA id. A push inside one registrar
leaves the IANA id unchanged, and in that case the nameservers are what move.
A commitment with neither field is refused at construction: the transfer
could never be shown to have completed, and the escrow would be a trap.

A commitment the registry already matches when the escrow opens is also
refused, because it would read as "transferred" from the first poll. A match
is evidence, not proof: nameservers are set by whoever holds the account, so a
seller can point the domain at the buyer's committed nameservers and keep it.
The buyer confirms that the domain is in their own registrar account before
signing a release; see THREATS.md.

### Two agreeing polls, thirty minutes apart

RDAP is cached and some registries lag by hours. No state changes on one
observation, and a failed fetch is not an observation: recorded as one, it
would look identical to a vanished lock or a reversed transfer.

A state is confirmed only by `REQUIRED_AGREEING_POLLS` (2) observations at
least `MIN_POLL_GAP_SECONDS` (1800) apart. Observations that disagree confirm
nothing, and the previous confirmed state stands. Every verdict carries the
snapshot hashes that justify it, so a ruling rests on evidence rather than
memory.

Implemented in `core/escrow/transfer.ts` and tested in
`test/vectors/transfer.test.ts`.

### The auth code

The auth code is the one secret in a domain sale: whoever holds it can take
the name. It travels from seller to buyer as a NIP-17 gift-wrapped message. It
is NIP-44 encrypted, sealed under the sender's key and wrapped under a
throwaway key, and the two timestamps are each moved back by an independent
random amount.

A relay storing it learns only that somebody sent something to that pubkey.
We cannot read it, be compelled to produce it, or lose it, because we never
hold it.

On unwrapping, the rumor's author must equal the seal's author. Without that
check anyone could seal a message claiming to come from the seller, such as a
forged "here is the code", and that forgery is the attack this handover has to
stop.

Implemented in `core/nostr/nip44.ts` and `core/nostr/nip17.ts`, and
differential-tested against nostr-tools in both directions.

### What this does not solve

- The 60-day lock after registration or a previous transfer blocks a sale
  outright. It is detected at listing time and the listing is refused.
- ccTLDs and TLDs with no RDAP cannot be verified, so they can be flexed but
  not escrowed.
- A registrar can reverse a completed transfer inside its own window. The
  watcher reports `reverted`, and the arbiter's decision table covers it.
- An inter-registrar transfer takes up to five days, so the escrow timelock
  must comfortably exceed it. Thirty days does.

## 9. Attestations

A verifier resolves a proof again from its own network and publishes a kind
6970:

```json
{ "v": 1, "domain": "…", "claimant": "…", "verdict": "proven|absent|unreachable",
  "source": "dns", "iat": 0, "dnssec": true, "resolvers": ["cloudflare","google"],
  "observed_at": 0 }
```

`unreachable` means no resolver answered, and it says nothing about the
domain. Recording it as `absent` would make one verifier's network problem
look like a vanished proof to everyone reading.

A reader counts distinct verifiers from a trusted set they choose, against a
threshold they choose. An attestation never replaces resolving the record
yourself.
