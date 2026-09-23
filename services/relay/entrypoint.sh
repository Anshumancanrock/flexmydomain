#!/usr/bin/env bash
# Start the flexmydomain relay image in one of its roles:
#
#   relay     the relay and its mirror, together (default)
#   backfill  one-off: fetch what the public relays have and this one lacks
#
# Anything else goes straight to strfry. Run maintenance commands inside the
# running container, with `exec`, never with `run`:
#
#   docker compose exec strfry /app/entrypoint.sh scan '{"kinds":[30402]}'
#   docker compose exec strfry /app/entrypoint.sh backfill
#
# Why one container, and why `exec`: every strfry process opens the same LMDB
# database, and LMDB tells its live readers apart by process id. Processes in
# one container never share an id. A second container (`docker compose run`,
# or a separate service) numbers its processes from 1 again, so its strfry can
# get the same id as one in here and then fails to open the database. Two
# containers can share a PID namespace, but Docker neither orders nor retries
# the start of a container that joins another's namespace, so after a reboot
# or a relay crash the mirror could stay down and nothing would report it.
#
# The mirror: `strfry router` streams new flexmydomain events from the public
# relays, and a backfill (negentropy, NIP-77) fetches whatever the stream
# missed, at start-up and then every FMD_BACKFILL_HOURS. Both pass every event
# through the same write policy as client writes, so the mirror cannot pull in
# anything the relay would refuse from a client.
set -euo pipefail

# Paths are overridable so this same script can be run outside the image.
STRFRY=("${STRFRY_BIN:-/app/strfry}" --config="${STRFRY_CONF:-/etc/strfry.conf}")
POLICY=${FMD_POLICY_BIN:-/app/fmd-write-policy}

die() { echo "fmd-relay: $*" >&2; exit 64; }
hex64='^[0-9a-f]{64}$'

# --- configuration, checked before anything starts ---------------------------
# A setting that is present but malformed stops the container with a reason. A
# silent fallback would leave the relay running without the thing configured.

RELAY_HOST=${RELAY_HOST:-}
RELAY_URL=${RELAY_URL:-${RELAY_HOST:+wss://$RELAY_HOST}}

FMD_FLEX_RECIPIENT=$(printf '%s' "${FMD_FLEX_RECIPIENT:-}" | tr 'A-F' 'a-f')
if [[ -n "$FMD_FLEX_RECIPIENT" && ! "$FMD_FLEX_RECIPIENT" =~ $hex64 ]]; then
  die "FMD_FLEX_RECIPIENT must be a 64-character hex pubkey (not an npub)"
fi
export FMD_FLEX_RECIPIENT

verifiers=${FMD_VERIFIERS:-}
for v in ${verifiers//,/ }; do
  [[ "$(printf '%s' "$v" | tr 'A-F' 'a-f')" =~ $hex64 ]] || die "FMD_VERIFIERS: '$v' is not a 64-character hex pubkey"
done

for n in FMD_RATE_PER_MINUTE FMD_RATE_BURST; do
  val=${!n:-}
  [[ -z "$val" || "$val" =~ ^[1-9][0-9]*$ ]] || die "$n must be a positive whole number"
done

[[ "${FMD_ACCEPT_GIFT_WRAPS:-0}" =~ ^[01]$ ]] || die "FMD_ACCEPT_GIFT_WRAPS must be 0 or 1"

FMD_MIRROR=${FMD_MIRROR:-1}
[[ "$FMD_MIRROR" =~ ^[01]$ ]] || die "FMD_MIRROR must be 0 or 1"
FMD_BACKFILL_HOURS=${FMD_BACKFILL_HOURS:-1}
[[ "$FMD_BACKFILL_HOURS" =~ ^(0|[1-9][0-9]{0,3})$ ]] || die "FMD_BACKFILL_HOURS must be a whole number of hours (0: only at start-up)"

# The public relays mirrored from: the five the site itself reads.
UPSTREAM_RELAYS=${UPSTREAM_RELAYS:-"wss://relay.damus.io wss://nos.lol wss://relay.primal.net wss://nostr.oxtr.dev wss://nostr.mom"}
relay_re='^wss?://[^[:space:]"]+$'
for url in $UPSTREAM_RELAYS; do
  [[ "$url" =~ $relay_re ]] || die "UPSTREAM_RELAYS: '$url' is not a ws:// or wss:// URL"
done

# What is mirrored, grouped by the tag that selects it, because each router
# stream opens one connection per upstream relay. Proof events are left out:
# they carry no tag a filter can select on, and every listing and portfolio
# embeds its proof anyway.
FILTERS=(
  '{"kinds":[30402,30078,6970],"#t":["flexmydomain"]}'
  '{"kinds":[5],"#k":["30402","30078"]}'
  '{"kinds":[1985],"#L":["fmd.trade"]}'
  '{"kinds":[30000,30009],"#d":["fmd:arbiters","fmd:watchlist","fmd-verified-sale","fmd-proven-holder"]}'
)
if [[ -n "$FMD_FLEX_RECIPIENT" ]]; then
  FILTERS+=("{\"kinds\":[9735],\"#p\":[\"$FMD_FLEX_RECIPIENT\"]}")
fi

# --- the mirror ---------------------------------------------------------------

router_conf() {
  echo 'connectionTimeout = 20'
  echo 'verbose = false'
  echo 'streams {'
  local i=0 filter url
  for filter in "${FILTERS[@]}"; do
    echo "  mirror$i {"
    echo '    dir = "down"'
    echo "    filter = $filter"
    echo "    pluginDown = \"$POLICY\""
    echo '    urls = ['
    for url in $UPSTREAM_RELAYS; do echo "      \"$url\""; done
    echo '    ]'
    echo '  }'
    i=$((i + 1))
  done
  echo '}'
}

# strfry's start-up banner, which would otherwise be most of what an hourly
# backfill writes to the log.
banner='^date +time|INFO\| (arguments:|Current dir:|stderr verbosity:|-----|CONFIG: |Setting up write policy|atexit)'

# One relay, one negentropy sync. Returns 0 when it synced, 2 when the relay
# answered with something other than negentropy (it has it switched off, or
# refused), and 1 otherwise: no connection, or no answer in time.
sync_from() {
  local line out pid refused=0 status=0
  echo "backfill: $1"
  # 300 seconds is far longer than the flexmydomain events take even from
  # scratch, and a relay that never answers must not stall the backfill.
  # --foreground lets Ctrl-C on a manual `exec ... backfill` reach strfry.
  coproc SYNC { exec timeout --foreground 300 "${STRFRY[@]}" sync "$1" --dir down --filter "$2" 2>&1 < /dev/null; }
  pid=$SYNC_PID
  exec {out}<&"${SYNC[0]}"   # a copy: bash closes SYNC's own when strfry exits
  while IFS= read -r line <&"$out"; do
    [[ "$line" =~ $banner ]] && continue
    echo "backfill: $line"
    # Where negentropy is off, the relay answers NEG-OPEN with a NOTICE and
    # strfry sync goes on waiting for a reply that never comes (nos.lol does
    # this). Stop it there.
    if [[ "$line" == *"Unexpected message from relay"* ]] && (( ! refused )); then
      refused=1
      kill "$pid" 2>/dev/null || true
    fi
  done
  exec {out}<&-
  wait "$pid" 2>/dev/null || status=$?
  if (( refused )); then return 2; fi
  if (( status )); then return 1; fi
  return 0
}

# With a unix time as $1, only what was published since then.
backfill() {
  local filters url status=0 rc failed=() f windowed=()
  for f in "${FILTERS[@]}"; do windowed+=("${f%\}}${1:+,\"since\":$1}}"); done
  filters=$(IFS=,; echo "[${windowed[*]}]")
  for url in $UPSTREAM_RELAYS; do
    rc=0; sync_from "$url" "$filters" || rc=$?
    case $rc in
      0) ;;
      2) echo "backfill: $url does not sync by negentropy (NIP-77); the router still streams from it" ;;
      *) failed+=("$url") ;;
    esac
  done
  # A relay that dropped the connection usually syncs on a retry half a
  # minute later.
  if (( ${#failed[@]} )); then
    sleep 30
    for url in "${failed[@]}"; do
      rc=0; sync_from "$url" "$filters" || rc=$?
      case $rc in
        0) ;;
        2) echo "backfill: $url does not sync by negentropy (NIP-77); the router still streams from it" ;;
        *) echo "backfill: $url did not sync, twice; the next backfill tries again"; status=1 ;;
      esac
    done
  fi
  return "$status"
}

# The stream, started again whenever it stops.
mirror_stream() {
  while :; do
    "${STRFRY[@]}" router "$1" 2>&1 | sed -u 's/^/router: /' || true
    echo "router: stopped; starting it again in 15 seconds"
    sleep 15
  done
}

# The first backfill fetches everything; the hourly ones only the last three
# days, which is far longer than any gap in the stream. An event the policy
# refuses is never stored, so every backfill downloads it again, and over all
# of history those would only pile up.
mirror_backfill() {
  backfill || true
  while (( FMD_BACKFILL_HOURS > 0 )); do
    sleep "$((FMD_BACKFILL_HOURS * 3600))"
    backfill "$(( $(date +%s) - 3 * 86400 ))" || true
  done
}

# Stop the relay and the mirror's loops, then exit. As the container's first
# process, this script takes whatever they started down with it: when process
# 1 exits, the kernel kills everything else in the container.
stop_all() {
  trap '' TERM INT
  kill -TERM ${relay_pid:+"$relay_pid"} ${mirror_pids[@]+"${mirror_pids[@]}"} 2>/dev/null || true
  [[ -z "$relay_pid" ]] || wait "$relay_pid" 2>/dev/null || true
  exit "$1"
}

role=${1:-relay}
case "$role" in
  relay)
    url_re='^wss?://[A-Za-z0-9.-]+(:[0-9]+)?$'
    [[ "$RELAY_URL" =~ $url_re ]] \
      || die "set RELAY_HOST (or RELAY_URL) in .env; RELAY_URL must look like wss://relay.example.com, with no path"
    admin=${RELAY_ADMIN_PUBKEY:-}
    npub_re='^npub1[02-9ac-hj-np-z]{58}$'
    if [[ -n "$admin" && ! "$(printf '%s' "$admin" | tr 'A-F' 'a-f')" =~ $hex64 && ! "$admin" =~ $npub_re ]]; then
      die "RELAY_ADMIN_PUBKEY must be an npub or a 64-character hex pubkey"
    fi

    # Written before anything starts, so a failure stops the container here
    # rather than leaving the relay running without its mirror.
    stream_conf=${TMPDIR:-/tmp}/fmd-router.conf
    [[ "$FMD_MIRROR" == 0 ]] || router_conf > "$stream_conf"

    # This script stays in charge as the container's first process: something
    # has to start the stream again when it stops, reap the processes a
    # stopped child leaves behind (process 1 inherits them), and stop the
    # mirror when the relay stops.
    relay_pid='' mirror_pids=()
    trap 'stop_all 0' TERM INT
    "${STRFRY[@]}" \
      --set "relay.auth.serviceUrl=$RELAY_URL" \
      --set "relay.info.name=${RELAY_NAME:-flexmydomain}" \
      --set "relay.info.description=${RELAY_DESCRIPTION:-Stores flexmydomain events only: domain listings, proofs, portfolios, escrow views and flex-board zap receipts. Anyone can read. Anything else is refused.}" \
      --set "relay.info.pubkey=$admin" \
      --set "relay.info.contact=${RELAY_CONTACT:-}" \
      relay &
    relay_pid=$!

    # The relay starts first, so a new database is created by it alone.
    if [[ "$FMD_MIRROR" == 1 ]]; then
      { sleep 5; mirror_stream "$stream_conf"; } &
      mirror_pids+=($!)
      { sleep 30; mirror_backfill; } &
      mirror_pids+=($!)
    fi

    # When the relay exits, stop the mirror too and exit with the relay's
    # status, so Docker's restart policy starts both again together.
    status=0
    wait "$relay_pid" || status=$?
    echo "fmd-relay: strfry relay exited with status $status" >&2
    stop_all "$status"
    ;;

  backfill)
    backfill
    ;;

  *)
    exec "${STRFRY[@]}" "$@"
    ;;
esac
