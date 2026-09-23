# relay: an optional strfry relay that stores flexmydomain events only

[strfry](https://github.com/hoytech/strfry) 1.1.3, with a write policy from
this repository and a live mirror of the public relays. It gives the site a
relay that answers NIP-45 `COUNT` for the whole network's listings, keeps
delistings (`a`-tag deletions) honoured, and refuses everything else.

It is optional, and nothing may come to depend on it. The site reads the five
public relays whether this runs or not; add this one to `extraRelays` in
`web/assets/config.js` and it becomes a sixth. Turn it off and nothing breaks.
Delete its database and a backfill rebuilds it, because everything on it also
lives on the public relays.

```bash
cp .env.example .env              # fill it in
docker compose up -d --build      # strfry and its mirror, and Caddy for TLS
bun run relay:check wss://relay.example.com --mine
```

## What it stores

`policy.ts` decides, using the same `core/` parsers the pages use, so an event
that would fail on every reader's machine is refused when it is published.

| kind | stored when |
|---|---|
| 30402 listing | tagged `flexmydomain` and its embedded proof verifies for its own key |
| 30078 | a domain proof, a portfolio or an escrow view that parses. For an escrow view, the stated address must be the one its keys produce |
| 5 deletion | one of its `a` coordinates is an address this project publishes: a listing (`fmd:listing:*`), a proof, the portfolio or an escrow view, the arbiter set or watchlist, an `fmd-*` badge. Other apps' deletions of the same kinds are refused |
| 9735 zap receipt | the zap request inside it is a flex-board zap (`fmd_flex` or `t=flexmydomain`), paid to `FMD_FLEX_RECIPIENT` when that is set |
| 10002 relay list | up to 50 relays, by `ws://` or `wss://` URL. The site publishes them, and the outbox model reads them |
| 30000 | the `fmd:arbiters` and `fmd:watchlist` sets |
| 1985, 5970, 6970 | trade receipts (`fmd.trade`), verification requests and attestations that parse |
| 7000 | job feedback from the verifiers named in `FMD_VERIFIERS` |
| 30009, 8, 30008 | the `fmd-*` badges |
| 1059 gift wrap | never, until `FMD_ACCEPT_GIFT_WRAPS=1` |

Anything else gets `blocked: this relay stores flexmydomain events only`.
Client writes are rate-limited per address (30 a minute, bursts of 60), and an
IPv6 client by its /64, since every IPv6 host can pick the rest of its address.

Profiles (kind 0) are refused. The site never publishes one, every profile is
on the public relays anyway, and an unverifiable 64 KB document from any
freshly minted key is the cheapest way to fill a relay's disk.

Gift wraps stay off. No page reads them yet, and strfry 1.1.x cannot restrict
who reads them, so this relay would hand private-message metadata to anyone
who asked. Turn them on together with the private-channel UI and a strfry that
has `restrictedReadKinds` (on strfry's master branch, not yet in a release).

What the policy does not check: event signatures (strfry has already verified
them), and DNS or zapper keys (a write path must not wait on the network).
Readers still check both, as they do for every relay.

## The mirror

`strfry router` streams new flexmydomain events down from the five public
relays. A stream only sees what is published while it is connected, so a
backfill (`strfry sync`, negentropy, NIP-77) also fetches whatever the relay
lacks: everything, 30 seconds after start-up, then every `FMD_BACKFILL_HOURS`
(default 1) whatever was published in the last three days. That covers the
history on a first start and any gap while a connection was down. The router
and the backfill pass every event through the same write policy as client
writes, so the mirror cannot pull in anything a client could not publish. The
filters are in `entrypoint.sh`:

```
{"kinds":[30402,30078,6970],"#t":["flexmydomain"]}
{"kinds":[5],"#k":["30402","30078"]}
{"kinds":[1985],"#L":["fmd.trade"]}
{"kinds":[30000,30009],"#d":["fmd:arbiters","fmd:watchlist","fmd-verified-sale","fmd-proven-holder"]}
{"kinds":[9735],"#p":["<FMD_FLEX_RECIPIENT>"]}   only when it is set
```

Standalone proof events are not mirrored. They carry no tag a filter could
select on, and every listing and portfolio embeds its proof anyway.

The filters select by tag, and other apps share some of these kinds and
tags: the deletions filter, for one, sees every marketplace's delistings. The
write policy refuses those, and a refused event is never stored, so each
backfill downloads it again. That is why the hourly backfills look back three
days rather than over all of history.

Most public relays have negentropy switched off. On 2026-09-24, of the five,
only nostr.oxtr.dev answered it; relay.damus.io, nos.lol, relay.primal.net and
nostr.mom replied `negentropy disabled`. The backfill moves on as soon as a
relay says so, and the router streams from all five either way. For what the
site publishes, one is enough, because the site sends every event to all
five. Other relays that support negentropy can be added to `UPSTREAM_RELAYS`;
each backfill's log says which relays synced. A relay that cannot be reached
is tried once more half a minute later, then at the next backfill.

The mirror runs in the relay's own container, under `entrypoint.sh`, which
starts the router again whenever it stops. "Operating it" explains why it is
not a separate service. `FMD_MIRROR=0` turns it off.

## Deploying

You need:

- a small VPS. Running, the relay container uses about 60 MB of memory (what
  Docker counts, the write-policy plugins included) and Caddy about 20 MB. The
  image build is a C++ compile that wants 2 GB, and it downloads about 150 MB;
- Docker with Compose v2;
- a DNS A record for the relay's host name pointing at that server, and no
  AAAA record unless you give the Docker network IPv6 as described below.

1. Clone this repository onto the server and `cd services/relay`.
2. `cp .env.example .env`, then set `RELAY_HOST` and `RELAY_CONTACT`. Set
   `FMD_FLEX_RECIPIENT` to the site's `featuredRecipientPubkey` if the flex
   board takes payments. Every value is checked at start-up: a malformed one
   stops the container with a message that says which, instead of quietly
   switching something off.
3. `docker compose up -d --build`. Caddy fetches the TLS certificate on first
   start. Half a minute later the first backfill fetches the existing events:
   `docker compose logs strfry | grep backfill` shows it.
4. From any machine with Bun: `bun run relay:check wss://<RELAY_HOST> --mine`.
   It publishes a throwaway test listing, confirms that it is stored, counted
   and deleted, and that a forged listing and an off-topic note are refused.
   The test listing expires by itself after five minutes if anything goes
   wrong.
5. Add `"wss://<RELAY_HOST>"` to `extraRelays` in `web/assets/config.js`.
   Every discoverable event the site publishes then goes there too, reads
   include it, and flex-board zap requests ask the zapper to send receipts
   there directly.

Ports 80 and 443 are the only ones published. strfry itself listens only on
the compose network.

Do not put Cloudflare's proxy (the orange cloud) in front of the relay. Caddy
tells strfry each client's address, and the rate limit is per address. Behind
another proxy, every client arrives from that proxy's addresses and shares one
budget. Keep the DNS record grey-clouded, or configure Caddy's
`trusted_proxies` for Cloudflare's ranges and read `CF-Connecting-IP`.

Docker itself causes the same problem for IPv6. The compose network is
IPv4-only, so Docker forwards connections to the host's IPv6 address through
its userland proxy, which connects on to Caddy from the network's gateway
address, and every IPv6 client shares one rate-limit budget. For that reason,
publish only an A record. To serve IPv6 as well, give the network IPv6
(Docker 27 or newer, where `ip6tables` is on by default) by adding this to
`docker-compose.yml`, then add the AAAA record:

```yaml
networks:
  default:
    enable_ipv6: true
```

Check it from an IPv6 client: `docker compose logs strfry | grep "Connect from"`
must show that client's own address, not `172.x.x.x`.

## Operating it

```bash
docker compose logs -f strfry          # the relay, and the mirror (lines start "router:" or "backfill:")
docker compose exec strfry /app/entrypoint.sh backfill   # a backfill now
docker compose exec strfry /app/entrypoint.sh scan '{"kinds":[30402]}'   # any strfry command
./backup.sh                            # dated export into ./backups, keeps 14
```

Use `exec`, never `run`, for anything that touches the database. LMDB
registers every process that reads the database by locking the byte at offset
`<pid>` of its lock file. `docker compose run` starts a fresh container, which
numbers its processes from 1 again, so its strfry can get the same PID as one
in the relay's container, and then its lock fails. `exec` runs inside the
relay's container, where every PID is unique.

The mirror stays in the relay's container for the same reason. Two containers
can share one PID namespace, but Docker does not wait for, or retry, a
container that joins another's namespace: after a reboot or a relay crash, a
separate mirror container could stay stopped and nothing would show it.

- Backups: `backup.sh` is meant for a nightly cron job. Its header comment
  has the restore command.
- Upgrading strfry: change `STRFRY_TAG` and `STRFRY_COMMIT` in the
  Dockerfile together (the build refuses a tag that does not point at that
  commit), read strfry's changelog, then `docker compose up -d --build`.
- Upgrading Bun: change `BUN_VERSION` and `BUN_BASELINE_SHA512` in the
  Dockerfile together. `BUN_VERSION` is both the `oven/bun` image tag and the
  baseline runtime's version. The sha512 is the npm registry's `integrity` for
  `@oven/bun-linux-x64-baseline` at that version, decoded from base64 to hex.
- Starting over: `docker compose down`, then
  `docker volume rm fmd-relay_strfry-db`, then `docker compose up -d`. The
  backfill at start-up fetches everything again. Do not use `down -v` for
  this: it also deletes Caddy's certificates, and requesting them again too
  often runs into Let's Encrypt's rate limits.

## How this was tested

Tested in Docker (Engine 29, Compose v5) on 2026-09-24. The image was built
from this Dockerfile and the stack started with `docker compose up` plus a
test override, which bound the ports to loopback, gave Caddy its local CA for
`localhost`, and added an open strfry standing in for the public relays.

- The build ran the policy's tests before compiling the plugin
  (`test/vectors/relay-policy.test.ts` covers it rule by rule). On an emulated
  CPU without AVX (QEMU, `-cpu Nehalem`), the image's plugin answered
  correctly, where a default Bun build died with "Illegal instruction".
- Through Caddy and TLS, `relay:check` passed all ten checks. Headless Chrome
  fetched NIP-11 from another origin, then read and counted over a WebSocket.
- The `.env` values reached the plugin: a flex zap paid to
  `FMD_FLEX_RECIPIENT` was kept and one paid to anyone else was refused, and
  job feedback was kept only from `FMD_VERIFIERS`. Each malformed value
  stopped the container with exit code 64 and a message naming it.
- strfry saw each client's address as Caddy saw it. A spoofed
  `X-Forwarded-For`, single or a list, was ignored, and writes past the burst
  were refused as rate-limited.
- The mirror streamed new events and refused forged listings, off-topic events
  and other apps' deletions. The first backfill brought in the history, and a
  mirrored deletion removed its listing. Against the five real public relays
  (reading only), it streamed from all five and backfilled from the one with
  negentropy on, skipping the other four at once.
- A killed router was back within 15 seconds. A killed relay took the
  container down, and Docker had it running again in about a second.
  `docker compose stop` took about a second.
- `backup.sh` exported every event. After the database volume was deleted as
  described under "Starting over", the export imported back complete.

Not tested here: a real Let's Encrypt certificate, which needs a public host
name, and IPv6 with `enable_ipv6`.
