#!/usr/bin/env bash
# Disaster restore: rebuild the live database from the catalog backup plus a
# user-data backup. For a NEW machine (or a database deliberately started
# over); it refuses a database that has users in it.
#
#   sudo /opt/flyleaf/deploy/backup/restore-full.sh \
#        --catalog /srv/flyleaf/import/flyleaf-catalog-<stamp> \
#        --backup  newest | daily | monthly | /path/flyleaf-<stamp>.tar.age  [--yes]
#
# Before: provision.sh, the private backup key back in /etc/flyleaf/backup.agekey,
# `rclone config` (to fetch from Drive), and release.sh of the SAME release the
# backup names (its manifest says which), so the schema matches. The catalog
# directory comes from Drive's catalog/ folder (backup-catalog.sh) or the laptop.
#
# Order, and why:
#   1. catalog base (restore-catalog.sh): schema, catalog rows, migrations;
#   2. catalog delta, upserted: the works this server created or changed,
#      which user rows point at;
#   3. user data, data only, triggers off: rows arrive as they were, counters
#      included, without the counter triggers counting them a second time;
#   4. migrate again: it recounts works.reader_count from the restored reads;
#   5. verify: row counts and checksums against the manifest, then EVERY
#      foreign key (they were not checked during step 3).

set -Eeuo pipefail
trap 'echo "restore-full.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib/restore-common.sh
. "$DEPLOY_DIR/lib/restore-common.sh"
require_root
load_app_env

CATALOG="" BACKUP="" YES=0
while (($#)); do
  case "$1" in
    --catalog) CATALOG="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) die "usage: $0 --catalog DIR --backup newest|daily|monthly|FILE [--yes]" ;;
  esac
done
[[ -n "$CATALOG" && -n "$BACKUP" ]] || die "both --catalog and --backup are required"
has_systemd() { [[ -d /run/systemd/system ]]; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$BACKUP_DIR/work/restore-$STAMP"
CWORK="$PG_BACKUP_MOUNT/restore-$STAMP"
mkdir -p "$WORK"; chmod 755 "$WORK"
trap 'rm -rf "$WORK"' EXIT
started=$SECONDS

case "$BACKUP" in
  newest) BACKUP="$(fetch_newest recent "$WORK")" ;;
  daily|monthly) BACKUP="$(fetch_newest "$BACKUP" "$WORK")" ;;
esac
[[ -r "$BACKUP" ]] || die "no backup file at $BACKUP"
unpack_backup "$BACKUP" "$WORK/unpacked"
M="$WORK/unpacked/manifest.txt"
log "backup $(basename "$BACKUP"): made $(manifest_field "$M" created_at) on $(manifest_field "$M" host), release $(manifest_field "$M" release), $(manifest_field "$M" migrations) migrations"

if [[ $YES == 0 ]]; then
  [[ -t 0 ]] || die "not a terminal: pass --yes"
  read -r -p "Rebuild database '$PG_DB' from this backup? Type RESTORE: " answer
  [[ "$answer" == RESTORE ]] || die "cancelled"
fi

# ---- 1. catalog base ------------------------------------------------------------
bash "$DEPLOY_DIR/catalog/restore-catalog.sh" "$CATALOG" --no-services
now_migrations="$(pg_value "$PG_DB" "SELECT count(*) FROM drizzle.__drizzle_migrations")"
if [[ "$now_migrations" != "$(manifest_field "$M" migrations)" ]]; then
  log "WARNING: this release has $now_migrations migrations, the backup was taken at $(manifest_field "$M" migrations)."
  log "         Deploy the backup's release ($(manifest_field "$M" release)) first if the data load below fails."
fi
if has_systemd; then systemctl stop flyleaf-api flyleaf-worker 2>/dev/null || true; fi

# ---- 2. catalog delta (upsert) ---------------------------------------------
pk_columns() {
  pg_value "$PG_DB" "SELECT string_agg(quote_ident(a.attname), ',' ORDER BY array_position(c.conkey, a.attnum))
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.$1'::regclass AND c.contype = 'p'"
}
bad=0 seen=0
while read -r _ table expected; do
  seen=$((seen + 1))
  csv="$WORK/unpacked/delta/$table.csv"
  cols="$(csv_columns "$csv")"
  pk="$(pk_columns "$table")"
  [[ -n "$pk" ]] || die "$table has no primary key to upsert on"
  # Every non-key column takes the backup's value.
  set_list="$(tr ',' '\n' <<<"$cols" | tr -d ' ' | grep -vxF -f <(tr ',' '\n' <<<"$pk") \
    | sed 's/.*/&=EXCLUDED.&/' | paste -sd, - || true)"
  # A table that is all key gets a no-op update, not DO NOTHING, so RETURNING
  # counts rows that were already there and the check below stays exact.
  [[ -n "$set_list" ]] || set_list="${pk%%,*}=EXCLUDED.${pk%%,*}"
  conflict="DO UPDATE SET $set_list"
  applied="$(pg -d "$PG_DB" -Atq \
    -c "CREATE TEMP TABLE stage AS SELECT $cols FROM public.\"$table\" WITH NO DATA" \
    -c "COPY stage ($cols) FROM STDIN WITH (FORMAT csv, HEADER)" \
    -c "WITH up AS (INSERT INTO public.\"$table\" ($cols) SELECT $cols FROM stage ON CONFLICT ($pk) $conflict RETURNING 1) SELECT count(*) FROM up" \
    < "$csv" | tail -1)"
  if [[ "$applied" == "$expected" ]]; then log "delta $table: $applied rows applied"; else log "delta $table: $applied applied, manifest $expected  MISMATCH"; bad=1; fi
done < <(awk '$1 == "delta"' "$M")
[[ "$seen" == "$(awk '$1 == "delta"' "$M" | wc -l)" ]] || bad=1
((bad == 0)) || die "the catalog delta did not apply cleanly"

# ---- 3. user data ---------------------------------------------------------------
# Everything in the dump's data section except drizzle's journal, which the
# catalog restore and the migrations already wrote.
docker exec "$PG_CONTAINER" pg_restore -l "$CWORK/unpacked/user-data.dump" \
  | grep -v ' drizzle ' > "$WORK/data.list"
log "loading user data (triggers off; foreign keys are checked afterwards)"
docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" --data-only --disable-triggers \
  --no-owner --no-privileges --exit-on-error -L "$CWORK/data.list" "$CWORK/unpacked/user-data.dump"

# ---- 4. migrate again (reader_count backfill) ----------------------------------
if [[ -n "${MIGRATE_CMD:-}" ]]; then bash -c "$MIGRATE_CMD"; else run_as_app /usr/local/bin/node dist/migrate.js; fi

# ---- 5. verify ------------------------------------------------------------------
log "comparing with the backup's manifest"
compare_with_manifest "$M" "$PG_DB" || bad=1
log "checking every foreign key"
if fk_check_queries "$PG_DB" all | run_fk_checks "$PG_DB"; then log "  every reference resolves"; else bad=1; fi
pg_value "$PG_DB" "SELECT refresh_search_suggestions()" >/dev/null 2>&1 || true
pg -d "$PG_DB" -q -c "ANALYZE"
((bad == 0)) || die "restored, but the checks above failed: do not start the API until they are understood"

if has_systemd && [[ -e "$FLYLEAF_HOME/current" ]]; then
  systemctl start flyleaf-api flyleaf-worker
fi
log "restore complete in $((SECONDS - started)) s. Next: check https://$FLYLEAF_HOST/readyz, then run backup.sh once by hand."
