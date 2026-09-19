# The flexmydomain domain proof, v1

A single DNS TXT record that proves a Nostr public key controls a domain's
zone. The proof is self-contained: a verifier needs only the record, with no
server of ours, no API, no account and no code we wrote.

This document is the normative definition. If our implementation and this
document disagree, the document is right.

## 1. The record

    name    _flexmydomain.<domain>
    type    TXT
    value   fmd1.<iat>.<pubkey>.<sig>

The value is a single token with no spaces. Fields are separated by `.`
(U+002E).

| field    | encoding                      | notes                            |
|----------|-------------------------------|----------------------------------|
| `fmd1`   | literal                       | format version. Reject anything else. |
| `iat`    | decimal unix seconds          | when the claimant signed         |
| `pubkey` | 64 lowercase hex chars        | the claimant's Nostr key, x-only |
| `sig`    | 128 lowercase hex chars       | BIP-340 Schnorr signature        |

Total length is 209 characters, inside the 255-byte limit for a single
character-string in a TXT RDATA, so it never needs splitting.

### Why a single token rather than space-separated fields

SPF and DKIM records separate their fields with spaces, but registrar DNS
panels treat SPF specially and handle other values that contain spaces
inconsistently: some add quotes, some split the value on whitespace into
several character-strings, and some strip the whitespace. A single token with
no spaces survives every panel we have been able to test, and it can be copied
with one selection.

Verifiers SHOULD also accept the four fields separated by spaces instead of
`.`, to be liberal in what they accept. Generators MUST emit the `.`-joined
form.

### Why the pubkey is in the record

With the pubkey in it, the record alone answers "which key controls this
domain", and not only "does this key control this domain". A verifier who has
never heard of us and has no Nostr event in hand can resolve one record and
learn the binding.

### Why `_flexmydomain` and not the apex

Apex TXT is crowded with SPF and with a verification token from every SaaS
vendor the owner has tried, and some panels make editing apex TXT awkward for
that reason. A dedicated underscore label never collides, and it is the
established convention for protocol records.

## 2. The signed message

    flexmydomain:v1:<domain>:<iat>

UTF-8, no trailing newline, no padding. `<domain>` is the normalised domain
(section 4). `<iat>` is the same decimal string that appears in the record.

The message binds:

- the domain, so a record copied to another zone does not verify;
- the timestamp, so a verifier can apply a freshness policy;
- and, through BIP-340 verification, the key.

There is no server-issued nonce. A challenge code from us would make this a
claim only we could check, and the proof is meant to need no trust in us.

### 2.1 What the signature covers

The signature is BIP-340 Schnorr, by the private key for `<pubkey>`, over the
id of this NIP-01 event:

    {
      "pubkey":     "<pubkey>",
      "created_at": <iat>,
      "kind":       30078,
      "tags":       [["d", "fmd:proof:<domain>"]],
      "content":    "flexmydomain:v1:<domain>:<iat>"
    }

    id = sha256(JSON.stringify([0, pubkey, iat, 30078, tags, content]))

serialised as NIP-01 requires: no whitespace, and only NIP-01's escapes.

Every field can be derived from the record itself. The pubkey and the `iat`
are in the record, the domain is what the verifier is checking, and this
document fixes the kind, the tag and the shape of the content. The proof stays
self-contained: the record and this page are all anyone needs.

#### Why an event id and not the bare message

NIP-07 browser extensions, the primary signer, offer `signEvent` and no other
way to sign. No extension can sign an arbitrary message: the only BIP-340
signature a user with Alby or nos2x can produce is one over a NIP-01 event id.
If the proof signed the bare message, the only way to create one would be to
paste a private key into a web page, and the project is built so that it never
sees your key.

The cost is one extra construction step in the verifier: roughly five lines,
or none if it already uses a Nostr library.

#### The proof is also a publishable event

Because the signed object is a real event, it can be published, and then the
same 64-byte signature proves the claim in two places: in DNS for anyone with
`dig`, and on relays for anyone with a Nostr client. One signing action
produces both.

Kind 30078 is NIP-78 application data and is addressable, so proving a domain
again replaces the previous event instead of adding another. A relay therefore
holds only one current proof per domain per key.

A verifier that receives the event instead of the record MUST check that it is
the canonical event above (same kind, same `d` tag in normalised form, same
content, and `created_at` equal to the `iat` inside the content) before
trusting any of its fields. Only the event whose id the signature covers
proves anything; an event that merely looks like a proof does not.

## 3. Verifying

Given a domain `D` and a claimed pubkey `P`:

1. Normalise `D` per section 4. If it does not normalise, fail.
2. Resolve TXT at `_flexmydomain.<D>`. Section 5 says how.
3. For each returned record (a zone may hold several):
   1. Split into four fields. Skip records whose version is not `fmd1`.
   2. Skip records that are malformed: wrong field count, non-decimal `iat`,
      `pubkey` not 64 hex chars, `sig` not 128 hex chars.
   3. If `pubkey != P`, skip. This is not a failure: a domain may carry
      proofs for several keys, for example during a handover.
   4. Rebuild the event of section 2.1 from the normalised domain, `P` and
      the record's own `iat`; compute its id; verify the Schnorr signature
      against `P` over that id.
4. The domain is proven for `P` if at least one record verifies. Where
   several do, prefer the one with the newest `iat`, so the age you display
   is the age of the best evidence rather than of whichever record the
   resolver happened to list first.

A verifier MUST NOT treat a malformed or non-matching record as a hard failure
while other records remain unchecked, because zones accumulate junk.

The signature check on its own fits in a few lines, with no code from this
repository (`test/vectors/proof.test.ts` runs this exact function):

```js
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

// value: the TXT record. domain: the normalised domain it was found under.
export function verify(value, domain) {
  const [version, iat, pubkey, sig] = value.split('.')
  if (version !== 'fmd1') return false

  // The signature covers a Nostr event id that the record alone rebuilds,
  // so a NIP-07 extension can produce it without exposing a key.
  const event = [0, pubkey, Number(iat), 30078,
                 [['d', `fmd:proof:${domain}`]],
                 `flexmydomain:v1:${domain}:${iat}`]
  const id = sha256(utf8ToBytes(JSON.stringify(event)))

  return schnorr.verify(hexToBytes(sig), id, hexToBytes(pubkey))
}
```

### Freshness

`iat` is advisory, not an expiry. A proof does not become false with age: the
claimant still controls the zone, or the record would not still be there.
Freshness policy belongs to the reader:

- reject an `iat` more than 300 seconds in the future (a clock-skew guard);
- display the age, and let the reader judge;
- re-resolve at least daily rather than trust an old observation, because a
  proof is a live claim. A listing whose record has vanished is marked stale,
  not deleted.

## 4. Domain normalisation

Before both signing and verifying:

1. trim whitespace; lowercase;
2. strip a URL scheme or a leading `//`, any `userinfo@`, any port, path,
   query or fragment (`https://www.MyShop.io/pricing?x=1` becomes
   `myshop.io`);
3. strip one trailing `.` (the DNS root);
4. strip leading `www.` labels, but never down to a single label;
5. convert Unicode labels to A-labels (IDNA / punycode `xn--`);
6. reject if it is not a registrable domain: at least two labels, label
   length 1..63, total length <= 253, labels `[a-z0-9-]` not starting or
   ending with `-`, and a TLD of 2..24 alphabetic characters.

Lowercasing is Unicode-aware and happens before punycode encoding. Otherwise
`MÜNCHEN.de` and `münchen.de` would encode to two different A-labels, and so
to two different signed messages.

Normalisation MUST be idempotent: normalising an already-normalised domain
returns it unchanged. That is why step 4 strips repeatedly. Stripping once
would turn `www.www.example.com` into `www.example.com`, which normalises
again to `example.com`. If normalisation changed its own output, a caller that
normalised twice on one side of the exchange and once on the other would
produce a signature that verifies for nobody.

An `xn--` label supplied directly MUST decode, MUST re-encode to the form
given, and MUST NOT decode to pure ASCII. The three rules stop a single domain
from having two spellings, and so two signed messages for one claim.

Step 6 rejects an A-label TLD, so `xn--p1ai` (.рф) and the other IDN TLDs
cannot be proven with this version of the format. This is a known limitation
of the format, and the code does not work around it.

Signer and verifier MUST apply identical normalisation, because the
normalised string is inside the signed message. A mismatch is a silent
verification failure, so both sides are checked against one shared set of
test vectors.

## 5. Resolution

The proof is only as trustworthy as the lookup that found it.

- Query two independent DoH providers and require agreement.
- Prefer a DNSSEC-validated answer. When the chain validates, say so in the
  UI: it is a real strength signal and it costs nothing.
- Where possible, query the domain's authoritative nameservers directly, so
  you observe the zone rather than somebody's cache.
- Record the observation verbatim with a timestamp, so that a dispute is
  about evidence, not memory.

A single failed fetch is not a negative result. Never move escrow state on one
failed lookup.

## 6. What this proves, and what it does not

The proof shows that the holder of `P` could write to this zone at time `iat`.

It does not show that `P` is the registrant, or that `P` can sell the domain.
A DNS administrator, a hosting provider, an agency or a former employee can
hold zone control with no registrar access at all.

Selling requires registrar control, and the separate check for that is a
change to the transfer lock: `clientTransferProhibited` seen present in RDAP,
then absent. Only the registrant can make that change, and anybody can
observe it. The absence of the lock alone is not the check, because many
registrars never set it, so a domain can show as unlocked no matter who lists
it.

    TXT record         ->  zone control       ->  enough to FLEX, and to LIST
    lock on, then off  ->  registrant control ->  required before FUNDING

spec/THREATS.md (section 2) describes what goes wrong when the two are
confused.

## 7. Alternative proof: NIP-05

A domain that already serves `/.well-known/nostr.json` mapping any name to `P`
gives equivalent evidence of control, and the owner has already done the
work. A verifier SHOULD accept it, and SHOULD label which proof it used: NIP-05
proves control of the web server, the TXT record proves control of the zone,
and the two claims are not quite the same.

## 8. Test vectors

The vectors are in `test/vectors/proof.test.ts`, and the implementation is in
`core/oracle/`. An independent implementation should reproduce the vectors
exactly. If it cannot, one of the two implementations is wrong, and this
document decides which.

When porting to another language, re-run the normalisation table in
particular. The normalised domain is inside the signed message, so a
one-character disagreement there produces a signature that verifies for
nobody, with no diagnostic for either side.
