#!/usr/bin/env bash
# Export every event on the relay to a dated, compressed JSONL file, and keep
# the newest BACKUP_KEEP of them. Run it from cron on the host, for example
# (cron's PATH is minimal, so name the directory docker lives in):
#
#   PATH=/usr/local/bin:/usr/bin:/bin
#   15 3 * * * /opt/flexmydomain/services/relay/backup.sh >> /var/log/fmd-relay-backup.log 2>&1
#
# Restore into a fresh relay with:
#   gunzip -c backups/strfry-<stamp>.jsonl.gz \
#     | docker compose exec -T strfry /app/strfry --config=/etc/strfry.conf import
#
# Everything on the relay also lives on the public relays, and a backfill
# rebuilds it, so these files are a convenience and never the only copy.
set -euo pipefail
cd "$(dirname "$0")"

dir=${BACKUP_DIR:-./backups}
keep=${BACKUP_KEEP:-14}
mkdir -p "$dir"

out="$dir/strfry-$(date -u +%Y%m%dT%H%M%SZ).jsonl.gz"
# A failed export must not leave a truncated file that looks like a backup.
trap 'rm -f "$out.partial"' EXIT
# --verbosity=-1: warnings and errors only, not strfry's start-up banner.
docker compose exec -T strfry /app/strfry --config=/etc/strfry.conf --verbosity=-1 export | gzip -9 > "$out.partial"
mv "$out.partial" "$out"

# Keep the newest BACKUP_KEEP; the glob matches only the dated exports above.
ls -1t "$dir"/strfry-*.jsonl.gz | tail -n +"$((keep + 1))" | xargs -r rm --
echo "$(date -u +%FT%TZ) backup: $out ($(du -h "$out" | cut -f1))"
