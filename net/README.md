# net/

The only code in this repository that makes network requests.

`core/` decides things and may not perform I/O. `services/` holds daemons that
must never be required for a user-facing feature. Neither is the right home
for "resolve this TXT record", which is I/O, is not a daemon, and is needed by
a page, by a test and by a verifier alike.

So net/ fetches and core/ decides. A function in this directory returns what
the network said, with enough provenance attached (which provider answered,
when, and the bytes verbatim) for `core/` to reach a verdict and for a dispute
to be about evidence rather than memory.

Everything here is isomorphic: `fetch` and `WebSocket` only, both of which
exist unchanged in a browser and under Bun. No `node:*`, no bundler
assumptions. The DoH, RDAP and Esplora endpoints used here were checked on
2026-09-18 and answer with `Access-Control-Allow-Origin: *`, and relays are
WebSockets, which CORS does not cover. That is what lets a static page do this
work with no backend.

    chain.ts     Esplora chain data: UTXOs, transactions, broadcast, fee rates
    dns.ts       DNS-over-HTTPS TXT lookups, two independent providers
    lnurl.ts     LNURL-pay and lightning addresses, for NIP-57 zaps
    outbox.ts    NIP-65 outbox routing over the relay pool
    rdap.ts      the IANA bootstrap file and registry queries
    relay.ts     a minimal Nostr relay pool: query, publish, count
    transfer.ts  RDAP polls as dated, hashed transfer observations
    verify.ts    the domain proof and registry checks: fetch, then decide

Two rules hold throughout:

- Never let one failed fetch mean "no". A negative result requires an answer,
  not a timeout. Every function here distinguishes "the provider said there is
  no such record" from "the provider did not answer".
- Always carry the observation: raw bytes, the provider, the timestamp.
