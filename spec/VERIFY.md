# Verifying the project's claims

None of the checks below relies on our server or on our word. Most use a tool
you already have; the rest run this repository's tests, which you can read.

If a check fails, the project does not do what it says. Please tell us.

## 0. There is no backend

```bash
bun run serve
```

Open `http://localhost:8000/flex.html` and watch the network tab. Every
request goes to a DNS resolver, a registry, a relay, or the domain's own web
server (the NIP-05 proof), and none of them is ours. There is no API call to a
host we run, because we run no host.

For a stronger check, ignore our deployment entirely and open the files from a
clone. The pages behave the same.

## 1. A domain proof verifies with `dig` and twelve lines

Pick any domain shown as proven on a flex page.

```bash
dig +short TXT _flexmydomain.<domain>
```

You get one token: `fmd1.<iat>.<pubkey>.<sig>`.

Then check the signature yourself. This is the whole verifier. It imports
nothing from this repository, only `@noble`:

```js
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

const [version, iat, pubkey, sig] = value.split('.')
const event = [0, pubkey, Number(iat), 30078,
               [['d', `fmd:proof:${domain}`]],
               `flexmydomain:v1:${domain}:${iat}`]
const id = sha256(utf8ToBytes(JSON.stringify(event)))
schnorr.verify(hexToBytes(sig), id, hexToBytes(pubkey))   // -> true
```

Then change one character of `domain` and watch it return `false`. The proof
is bound to the name, so it cannot be copied to another zone.

`spec/PROOF.md` is the normative definition. `test/vectors/proof.test.ts`
executes the snippet above so it cannot drift from the code.

## 2. The listings are on relays we do not run

```bash
npx nostr-tools-cli  # or any relay client you already trust
```

Subscribe to any of these with the filter `{"kinds":[30402],"#t":["flexmydomain"]}`:

```
wss://relay.damus.io   wss://nos.lol   wss://relay.primal.net
wss://nostr.oxtr.dev wss://nostr.mom
```

Every listing on the market page is there. None of those relays is ours; the
optional relay in `services/relay/` is off by default. Open a seller's `npub` in any Nostr client and their
portfolio (kind 30078, `d = fmd:portfolio`) is readable there too.

## 3. A listing carries its own proof

Take any kind 30402 event from step 2. It has an `fmd_proof` tag holding
`[iat, sig]`, and the event carries its own `pubkey`. That is everything the
verifier in step 1 needs, so a client that has never heard of this project
can check a listing with one DNS query and one signature check.

The proof's key is the event's key; there is no separate field for it. Nostr
has no gatekeeper, so anyone can publish a listing claiming `apple.com`, and
that listing fails this check on your machine without asking us.

Turn on "Show unverified listings" on the market page to see each listing that
was filtered out, labelled with the reason.

## 4. The registry agrees

```bash
curl -s https://rdap.verisign.com/com/v1/domain/<domain> | jq '.status, .events'
```

When you prove a domain, the market shows the registry's view of it: its
registrar, statuses, age and expiry. Listing cards show only a registration
date the seller states, if any. The escrow page reads the record of the domain
being traded, at any registrar, and stops the escrow only for a name the
registry says isn't registered, one expired or expiring within 45 days, or one
whose statuses show it leaving, being deleted, restored or renewed
(`pendingTransfer`, `pendingDelete`, `redemptionPeriod`, `pendingRestore`,
`pendingRenew`). A transfer lock, a registry update lock, a hold, a missing
expiry, and a registration or move between registrars in the last 60 days are
warnings both sides see, and the registrar itself is never refused. Until the
registry answers, the page doesn't offer to fund.
`bun test test/vectors/registrar.test.ts` runs the status, expiry and lock
rules.

In a dispute, the arbiter's page shows the same record: the registrar and its
IANA id, the statuses, the last transfer and last change dates, the expiry and
the nameservers. Drop the `jq` filter above to see all of it. A move to another
registrar shows there; a move between two accounts at one registrar doesn't,
which is why the arbiter also asks each side for read-only proof.

The list of TLDs with RDAP is never hardcoded. It comes from
`https://data.iana.org/rdap/dns.json` at run time, and a domain whose TLD is
not in it, or that lists only plain-HTTP RDAP services, can be flexed but not
escrowed.

## 5. The escrow address can be re-derived from three public keys and the id

```bash
bun test test/vectors
```

Every vector runs with no network, and `bun run typecheck` is clean under `strict`. The
taproot derivation in `core/escrow/` is written from scratch over `@noble`
primitives and is differentially tested against `@scure/btc-signer`, so the
test compares two independent derivations rather than a function with itself.

Then check the spend path against consensus:

```bash
bun run test:regtest
```

This needs Bitcoin Core 31.1 unpacked at `tools/bitcoin-31.1/`. `tools/` is not
in git: download the release from bitcoincore.org and check it against its
`SHA256SUMS` and the signatures on that file. Without it, the tests that need
a node are skipped. The suite starts a throwaway Bitcoin Core regtest node, funds the derived address
and spends every leaf: cooperative, both arbiter paths, and the timeout. The
timeout spend is first shown to be rejected before the timelock, then accepted
unchanged after mining past it. The test also builds, for every leaf, a
witness carrying only the arbiter's signature, and Core refuses each one.

The BIP-341 sighash is separately differential-tested against
`@scure/btc-signer`, which `core/escrow` does not import. That makes three
independent checks: this project's implementation, another implementation,
and consensus.

## 6. The reputation numbers cannot be quietly inflated

```bash
bun test test/vectors/reputation.test.ts
```

Each test describes the attack it refuses. In particular:

- a zap receipt is rejected unless it was signed by the recipient's own
  published zapper key, taken from their LNURL metadata;
- a receipt whose invoice amount disagrees with its zap request is rejected,
  since otherwise a zap could claim a million sats and pay one;
- the same receipt fetched from five relays counts once;
- a trade needs both receipts, each written by the party the other names;
- and a trade with no observed RDAP transfer is shown with a weight of zero.

The last rule is what stops wash trading. Two keys you control can escrow to
each other and produce a perfect pair of receipts for the cost of mining fees.
A real inter-registrar transfer is expensive: roughly $10 and a 60-day lock on
that name. So volume is displayed but ignored, and only transfers count. A
move between two accounts at one registrar, the quickest way an escrow here
sends a domain, shows nowhere in RDAP, so a trade made that way weighs zero.
No page writes or shows receipts yet.

## 7. Take your money out with the server off

```bash
bun run build:recover      # or just open the committed file
```

Open `web/recover.html` from `file://`. You can disconnect from the internet
first: the page makes no network requests of any kind, and the test suite
asserts it. There is no `fetch`, no `XMLHttpRequest`, no remote script,
stylesheet, font or image, and no `http` URL anywhere in the file.

Paste the buyer's recovery string. The page rebuilds the escrow, shows you the
address so you can check it against the one you funded, and, once the
timelock has passed, signs a sweep back to the buyer. You type in the funding
transaction from any block explorer, since the string is saved before funding.
Broadcast the hex wherever you like. The seller's string rebuilds the address
too, but the timeout pays only the buyer.

`test/regtest/recover.test.ts` does this in a real browser, from `file://`,
against a real regtest node, and then broadcasts what the page printed.
Bitcoin Core accepts it.

## 8. We cannot take your money

The escrow output is a 2-of-3 Taproot script tree between buyer, seller and
arbiter, with a timelock. We hold at most one key of three.

```bash
bun test test/vectors/spend.test.ts test/vectors/settle.test.ts
```

No leaf can be spent by the arbiter alone. That is a property of the tree,
and the negative tests in those two files assert it. `bun run test:regtest`
also shows Bitcoin Core refusing a witness that carries only the arbiter's
signature.

## 9. An escrow cannot point somewhere it does not derive

Open `escrow.html?id=<any id>`. Every published view of an escrow is parsed by
re-deriving the taproot address from the three keys it names and the id its terms
hash to, which the internal key commits to (PROTOCOL §5). A view whose
stated address is not the one its own parameters produce is refused, with the
words "do not fund it".

This stops an attacker from publishing a plausible escrow that names an
output only they can spend, and then waiting for somebody to fund it.

Above everything else, the page also shows where the parties' published views
disagree. Views of one id can't differ on any term, since the id hashes them
all, so a disagreement there means a bug, and the page says so loudly. That is
something you should see before funding, and it is permanent because each
view is signed.

This has been checked in a browser against the shipped bundle as well as the
source.

A view of the earlier flow, where the arbiter held the domain (version 4), is
refused with words that say so, and so is a version 5 view carrying any field
of that flow, such as `custody_account` or `forward_blocks`: a field this
version doesn't define would be a term nobody agreed to.
`bun test test/vectors/escrow-event.test.ts` runs both cases.

## 10. Where the domain goes stays between the buyer and the seller

```bash
bun test test/vectors/escrow-chat.test.ts test/vectors/transfer-flow.test.ts
```

Each pair of an escrow's three keys has its own NIP-17 chat (PROTOCOL §10): the
buyer and the seller, the buyer and the arbiter, the seller and the arbiter. A
message names exactly one recipient and is encrypted only to that recipient's
key and its author's. The tests open every copy with every key: the arbiter's
key opens nothing the buyer and the seller sent each other, neither party's
key opens the other's chat with the arbiter, and a key outside the escrow
opens nothing. On the outside, each copy names only its recipient, and nothing
of the escrow or its author.

`transfer-flow.test.ts` runs whole trades the way the pages do, over a
connection to a test relay that, like relay.damus.io, hands a key its gift
wraps only after it signs in (NIP-42). The buyer's account and the seller's
transfer code go as cards in their chat, and the arbiter, signed in as itself,
is handed no copy of either. In the dispute, each side's proof reaches the
arbiter and not the other side.

Nothing public says where the domain goes. The invite and the reply carry the
terms and one escrow key each, and nothing about any account
(`handshake.test.ts`), and a view carries the terms, its author's claims and
its signatures (`escrow-event.test.ts` pins its fields). Read any escrow's
views from a relay, as in step 2 with `{"kinds":[30078],"#t":["flexmydomain"]}`:
no field holds an account, an email or a transfer code. The one free text in a
view is the reason a side gives for a cancellation or a dispute, and that is
public.

## 11. Run the index yourself

```bash
bun services/indexer/indexer.ts      # sweeps, then serves on :8788 (--once sweeps and exits)
```

Then, in a second terminal:

```bash
curl 'http://localhost:8788/search?q=' | jq '.cache, .relays, .filter'
```

Every response says `"cache": true`, names the relays it read, and includes
the raw signed event in each row. Delete the database and it rebuilds. The
market page does not depend on the index: it queries relays directly.
