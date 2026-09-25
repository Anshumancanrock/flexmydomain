#!/usr/bin/env bash
# Entrypoint for the relay image. Roles:
#
#   relay     relay plus mirror (default)
#   backfill  one-off: fetch what the public relays have and this one lacks
#
# Anything else goes straight to strfry. Run maintenance in the running
# container with `exec`, never `run`:
#
#   docker compose exec strfry /app/entrypoint.sh scan '{"kinds":[30402]}'
#   docker compose exec strfry /app/entrypoint.sh backfill
#
# Why one container and `exec`: every strfry process opens the same LMDB, and
# LMDB tells live readers apart by PID. A second container (`run`, or another
# service) numbers PIDs from 1 again, can collide with one in here and then
# fails to open the db. Sharing a PID namespace doesn't help either. Docker
# won't order or retry the joining container's start, so after a reboot the
# mirror could stay down silently.
#
# Mirror: `strfry router` streams new events from the public relays, and a
# negentropy (NIP-77) backfill fetches what it missed, at start-up and every
# FMD_BACKFILL_HOURS. Both go through the client write policy, so the mirror
# can't pull in anything a client couldn't write.
set -euo pipefail

# Overridable so the script also runs outside the image.
STRFRY=("${STRFRY_BIN:-/app/strfry}" --config="${STRFRY_CONF:-/etc/strfry.conf}")
POLICY=${FMD_POLICY_BIN:-/app/fmd-write-policy}

die() { echo "fmd-relay: $*" >&2; exit 64; }
hex64='^[0-9a-f]{64}$'

# Validate config before anything starts. A malformed setting stops the
# container with a reason, never a silent fallback.

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

# Default: the five relays the site reads.
UPSTREAM_RELAYS=${UPSTREAM_RELAYS:-"wss://relay.damus.io wss://nos.lol wss://relay.primal.net wss://nostr.oxtr.dev wss://nostr.mom"}
relay_re='^wss?://[^[:space:]"]+$'
for url in $UPSTREAM_RELAYS; do
  [[ "$url" =~ $relay_re ]] || die "UPSTREAM_RELAYS: '$url' is not a ws:// or wss:// URL"
done

# Grouped by selecting tag, since each router stream opens one connection per
# upstream. Proofs are left out. No tag selects them, and listings and
# portfolios embed theirs anyway.
FILTERS=(
  '{"kinds":[30402,30078,6970],"#t":["flexmydomain"]}'
  '{"kinds":[5],"#k":["30402","30078"]}'
  '{"kinds":[1985],"#L":["fmd.trade"]}'
  '{"kinds":[30000,30009],"#d":["fmd:arbiters","fmd:watchlist","fmd-verified-sale","fmd-proven-holder"]}'
)
if [[ -n "$FMD_FLEX_RECIPIENT" ]]; then
  FILTERS+=("{\"kinds\":[9735],\"#p\":[\"$FMD_FLEX_RECIPIENT\"]}")
fi

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

# strfry's start-up banner. Otherwise it's most of each hourly backfill's log.
banner='^date +time|INFO\| (arguments:|Current dir:|stderr verbosity:|-----|CONFIG: |Setting up write policy|atexit)'

# One negentropy sync against one relay. Returns 0 if synced, 2 if the relay
# answered without negentropy (off or refused), 1 on no connection or timeout.
sync_from() {
  local line out pid refused=0 status=0
  echo "backfill: $1"
  # 300s is far more than a full sync takes. A silent relay must not stall the backfill.
  # --foreground lets Ctrl-C on a manual `exec ... backfill` reach strfry.
  coproc SYNC { exec timeout --foreground 300 "${STRFRY[@]}" sync "$1" --dir down --filter "$2" 2>&1 < /dev/null; }
  pid=$SYNC_PID
  exec {out}<&"${SYNC[0]}"   # a copy: bash closes SYNC's own when strfry exits
  while IFS= read -r line <&"$out"; do
    [[ "$line" =~ $banner ]] && continue
    echo "backfill: $line"
    # Without negentropy the relay answers NEG-OPEN with a NOTICE and strfry
    # sync waits forever (nos.lol does this). Kill it.
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

# Optional $1 is a unix time. Only events since then are fetched.
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
  # A dropped connection usually syncs on a retry 30s later.
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

mirror_stream() {
  while :; do
    "${STRFRY[@]}" router "$1" 2>&1 | sed -u 's/^/router: /' || true
    echo "router: stopped; starting it again in 15 seconds"
    sleep 15
  done
}

# First backfill fetches everything, later ones only the last 3 days (far more
# than any stream gap). Refused events are never stored, so each backfill
# downloads them again. Over all of history that only grows.
mirror_backfill() {
  backfill || true
  while (( FMD_BACKFILL_HOURS > 0 )); do
    sleep "$((FMD_BACKFILL_HOURS * 3600))"
    backfill "$(( $(date +%s) - 3 * 86400 ))" || true
  done
}

# Stop relay and mirror loops, then exit. We're PID 1, so the kernel kills
# anything left in the container once we exit.
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

    # Written before anything starts, so a failure stops the container instead
    # of running the relay without its mirror.
    stream_conf=${TMPDIR:-/tmp}/fmd-router.conf
    [[ "$FMD_MIRROR" == 0 ]] || router_conf > "$stream_conf"

    # Stay PID 1. Something has to restart the stream, reap orphans (PID 1
    # inherits them) and stop the mirror when the relay stops.
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

    # Relay starts first so it alone creates a fresh database.
    if [[ "$FMD_MIRROR" == 1 ]]; then
      { sleep 5; mirror_stream "$stream_conf"; } &
      mirror_pids+=($!)
      { sleep 30; mirror_backfill; } &
      mirror_pids+=($!)
    fi

    # Exit with the relay's status so Docker restarts both together.
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
