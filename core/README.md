# core/

The protocol's rules, as pure and isomorphic code. Everything here runs
unchanged in a browser and under Bun. The pages do their own work, with any
server only as an optional accelerator, and `web/recover.html` has to rebuild
an escrow and sign a sweep with no network and no server.

Rules, enforced in review:

- No I/O: no `fetch`, filesystem, sockets or database.
- No config: no environment variables or globals. Everything arrives as
  arguments.
- No environment assumptions: nothing from `node:*` and nothing from `window`.
- Deterministic: the same inputs give the same bytes. No clocks, and no
  randomness except where a caller passes entropy in.

Code that needs the network or the clock belongs in `net/`, `services/` or page
code, and takes the pure output of this module as its input.

- `escrow/`: taproot script trees, address derivation, transaction building
  and signing, and witness finalisation.
- `oracle/`: domain normalisation, the proof record, NIP-05, and RDAP response
  parsing with the eligibility rules. These are the pure halves; the fetching
  lives in `net/`.
- `nostr/`: construction, parsing and verification of NIP-01 events, NIP-19
  identifiers, the kind 30402 listing and the kind 30078 portfolio.

The one exception to the environment rule is `Date.parse`, which
`oracle/rdap.ts` uses to read a timestamp the registry wrote. It is never used
to read the current time. Every function that needs the current time takes it
as a parameter, so an eligibility verdict can be reproduced from its snapshot
months later, in a dispute.
