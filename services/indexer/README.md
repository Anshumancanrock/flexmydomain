# indexer: a cache of the relays

Subscribes to relays, verifies every listing with the same functions the
browser runs, writes SQLite and serves one read-only endpoint.

```bash
bun services/indexer/indexer.ts                  # sweep + serve on :8788
bun services/indexer/indexer.ts --once           # one sweep, no server
bun services/indexer/indexer.ts --db ./fmd.db --port 9000 --interval 600
```

## A cache

Delete `fmd-index.db` and it rebuilds from the relays; nothing is stored only
here. The market page queries relays directly and does not depend on it.

Every `/search` response says `"cache": true`, names the relays it read, and
includes the raw signed event in each row, so a consumer can verify each
listing without trusting the indexer.

## The filter

```json
{"kinds":[30402],"#t":["flexmydomain"]}
```

Another indexer run against the same filter gets the same listings.

## What it verifies

`checkListing` and `checkDomainProof`, imported from `core/` and `net/`, so
the indexer and the pages reach the same verdict on every listing.

A listing is stored either way and labelled `verified: 0|1` with a `reason`.
`/search` returns only verified listings unless you pass `unverified=1`. An
unverified listing stays on the relays, and the rule it failed is published in
spec/PROTOCOL.md; the indexer only declines to serve it as real.

## Endpoints

| path | what |
|---|---|
| `/search?q=&tld=&sort=price-desc&limit=50&unverified=0` | listings |
| `/health` | row count and last sweep time |

Any other path returns 404 with a note that the relays are the source.
