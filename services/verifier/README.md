# verifier: a domain-verification daemon

Re-resolves domain proofs and publishes what it saw as NIP-90 kind 6970
results.

```bash
bun services/verifier/verifier.ts --nsec nsec1... --once
bun services/verifier/verifier.ts --key-file ./verifier.key --interval 3600
```

| flag | default | what |
|---|---|---|
| `--nsec` / `--key-file` / `$FMD_VERIFIER_NSEC` | — | the signing key, required |
| `--relays` | the five in `core/nostr/index.ts` | comma separated |
| `--interval` | `3600` | seconds between sweeps |
| `--concurrency` | `4` | DoH lookups in flight; providers rate-limit |
| `--once` | off | one sweep, then exit |

## What it does

Collects every `(domain, claimant)` pair it can find in listings and
portfolios, re-resolves each proof from wherever this machine is, and publishes
a signed attestation with one of three verdicts:

- `proven`: a record verified for that key.
- `absent`: the resolvers answered, and no record verified.
- `unreachable`: no resolver answered, which says nothing about the domain.
  Recording it as `absent` would make a network problem here look like a
  vanished proof to everyone reading.

## What it is not

It is not required. Every page in `web/` resolves DNS itself and reaches its
own verdict. Turn this off and nothing degrades: listings still verify and the
flex page still renders.

It is not an authority. An attestation is one party saying "I looked, from
somewhere else". `tally()` in `core/nostr/attestation.ts` counts distinct
verifiers against a threshold the reader chooses, from a trusted set the
reader chooses. A client that trusts three attestations instead of doing one
DNS lookup has swapped a check it controls for three it does not.

## Running several

Daemons on one host behind one resolver give one opinion, however many there
are. Run each on a different network with a different resolver, and give each
its own key. An attestation key should hold no funds and no identity, so a
compromise exposes nothing but attestations.

The kinds `5970` and `6970` are this project's choice inside NIP-90's custom
range. They are not registered anywhere.
