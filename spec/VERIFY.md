# Verifying the project's claims

None of the checks below relies on our server or on our word. Most use a tool
you already have; the rest run this repository's tests, which you can read.

If a check fails, the project does not do what it says. Please tell us.

## 0. There is no backend

```bash
bun run serve
```

Open `http://localhost:8000/flex.html` and watch the network tab. Every
request goes to a DNS resolver, a registry or a relay, and none of them is
ours. There is no API call to a host we run, because we run no host.

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

`clientTransferProhibited` present means the domain is locked and cannot be
sold yet. The market shows the lock state, and the escrow page lets a buyer
fund only after the registry has shown the lock turned on and then off.
Changing the lock is an act only the registrant can perform, and anyone can
observe it.

The list of TLDs with RDAP is never hardcoded. It comes from
`https://data.iana.org/rdap/dns.json` at run time, and a domain whose TLD is
not in it can be flexed but not escrowed.

## 5. The escrow address can be re-derived from three public keys

```bash
bun test test/vectors
```

528 vectors, no network, and `bun run typecheck` is clean under `strict`. The
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
and spends every leaf: cooperative, both dispute paths, and the timeout. The
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
that name. So volume is displayed but ignored, and only transfers count.

## 7. Take your money out with the server off

```bash
bun run build:recover      # or just open the committed file
```

Open `web/recover.html` from `file://`. You can disconnect from the internet
first: the page makes no network requests of any kind, and the test suite
asserts it. There is no `fetch`, no `XMLHttpRequest`, no remote script,
stylesheet, font or image, and no `http` URL anywhere in the file.

Paste your recovery string. The page rebuilds the escrow, shows you the
address so you can check it against the one you funded, and signs a sweep.
Broadcast the hex wherever you like.

`test/regtest/recover.test.ts` does this in a real browser, from `file://`,
against a real regtest node, and then broadcasts what the page printed.
Bitcoin Core accepts it.

## 8. We cannot take your money

The escrow output is a 2-of-3 Taproot script tree between buyer, seller and
arbiter, with a timelock. We hold at most one key of three.

```bash
bun test test/vectors/escrow.test.ts
```

No leaf can be spent by the arbiter alone. That is a property of the tree,
and the negative test asserts it.

## 9. An escrow cannot point somewhere it does not derive

Open `escrow.html?id=<any id>`. Every published view of an escrow is parsed by
re-deriving the taproot address from the three keys it names. A view whose
stated address is not the one its own parameters produce is refused, with the
words "do not fund it".

This stops an attacker from publishing a plausible escrow that names an
output only they can spend, and then waiting for somebody to fund it.

Above everything else, the page also shows where the parties' published views
disagree: different amounts, keys or funding outpoints. That is a dispute you
should see before funding, and it is permanent because each view is signed.

This has been checked in a browser against the shipped bundle as well as the
source.

## 10. Run the index yourself

```bash
bun services/indexer/indexer.ts --once
curl 'http://localhost:8788/search?q=' | jq '.cache, .relays, .filter'
```

Every response says `"cache": true`, names the relays it read, and includes
the raw signed event in each row. Delete the database and it rebuilds. The
market page does not depend on the index: it queries relays directly.
