#!/usr/bin/env bash
# Export every relay event to a dated .jsonl.gz and keep the newest BACKUP_KEEP.
# Run from cron on the host. Cron's PATH is minimal, so include docker's dir:
#
#   PATH=/usr/local/bin:/usr/bin:/bin
#   15 3 * * * /opt/flexmydomain/services/relay/backup.sh >> /var/log/fmd-relay-backup.log 2>&1
#
# Restore into a fresh relay:
#   gunzip -c backups/strfry-<stamp>.jsonl.gz \
#     | docker compose exec -T strfry /app/strfry --config=/etc/strfry.conf import
#
# Convenience only. Everything here is also on the public relays and a backfill
# rebuilds it.
set -euo pipefail
cd "$(dirname "$0")"

dir=${BACKUP_DIR:-./backups}
keep=${BACKUP_KEEP:-14}
mkdir -p "$dir"

out="$dir/strfry-$(date -u +%Y%m%dT%H%M%SZ).jsonl.gz"
# A failed export must not leave a truncated file that looks like a backup.
trap 'rm -f "$out.partial"' EXIT
# --verbosity=-1 drops strfry's start-up banner, keeps warnings and errors.
docker compose exec -T strfry /app/strfry --config=/etc/strfry.conf --verbosity=-1 export | gzip -9 > "$out.partial"
mv "$out.partial" "$out"

# The glob only matches the dated exports above.
ls -1t "$dir"/strfry-*.jsonl.gz | tail -n +"$((keep + 1))" | xargs -r rm --
echo "$(date -u +%FT%TZ) backup: $out ($(du -h "$out" | cut -f1))"
