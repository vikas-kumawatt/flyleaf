#!/usr/bin/env bash
# The restore drill (architecture §11 rule 2: "an untested backup is not a
# backup"). Monthly via flyleaf-restore-drill.timer; by hand any time:
#
#   sudo /opt/flyleaf/deploy/backup/restore-drill.sh [--file X.tar.age] [--keep] [--mail]
#
# 1. downloads the newest backup from Google Drive (recent/), unless --file:
#    the copy that would matter after losing this machine is the off-site one;
# 2. decrypts it with /etc/flyleaf/backup.agekey and checks every file's SHA-256;
# 3. restores it into a scratch database, flyleaf_drill (tables and data; no
#    indexes, triggers or foreign keys, which a row check does not need);
# 4. loads the catalog delta into the scratch copy's empty catalog tables;
# 5. compares every user table's row count, and the content checksums of
#    the core tables, with the manifest written at backup time;
# 6. checks every foreign key between user tables, using the live database's
#    constraint definitions (user rows that point at the catalog are checked
#    by restore-full.sh, which has the catalog);
# 7. drops flyleaf_drill (--keep leaves it for a look) and reports. --mail
#    sends the report to OWNER_EMAIL, passed or failed.
#
# Touches nothing else: the live database is only read (for constraint
# definitions), and the API keeps serving.

set -Eeuo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib/restore-common.sh
. "$DEPLOY_DIR/lib/restore-common.sh"
load_app_env

FILE="" KEEP=0 MAIL=0
while (($#)); do
  case "$1" in
    --file) FILE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --mail) MAIL=1; shift ;;
    *) die "usage: $0 [--file X.tar.age] [--keep] [--mail]" ;;
  esac
done
DRILL_DB="${DRILL_DB:-flyleaf_drill}"
[[ "$DRILL_DB" != "$PG_DB" ]] || die "DRILL_DB must not be the live database"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$BACKUP_DIR/work/drill-$STAMP"
CWORK="$PG_BACKUP_MOUNT/drill-$STAMP"
REPORT="$(mktemp)"
mkdir -p "$WORK"; chmod 755 "$WORK"

drill() {
  wait_for_pg
  if [[ -n "$FILE" ]]; then
    echo "$FILE" > "$WORK/source"
  else
    log "downloading the newest off-site backup"
    FILE="$(fetch_newest recent "$WORK")"
    echo "$BACKUP_REMOTE/recent/$(basename "$FILE")" > "$WORK/source"
  fi
  log "drill on $(cat "$WORK/source") ($(du -h "$FILE" | cut -f1))"
  unpack_backup "$FILE" "$WORK/unpacked"
  M="$WORK/unpacked/manifest.txt"
  log "backup made $(manifest_field "$M" created_at), release $(manifest_field "$M" release), $(manifest_field "$M" migrations) migrations; files intact"

  log "restoring into scratch database $DRILL_DB"
  pg -d postgres -q -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DRILL_DB\""
  docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$DRILL_DB" --no-owner --no-privileges \
    --exit-on-error --section=pre-data --section=data "$CWORK/unpacked/user-data.dump"

  log "loading the catalog delta"
  bad=0 seen=0
  while read -r _ table expected; do
    seen=$((seen + 1))
    csv="$WORK/unpacked/delta/$table.csv"
    cols="$(csv_columns "$csv")"
    pg -d "$DRILL_DB" -q -c "COPY public.\"$table\" ($cols) FROM STDIN WITH (FORMAT csv, HEADER)" < "$csv"
    actual="$(pg_value "$DRILL_DB" "SELECT count(*) FROM public.\"$table\"")"
    if [[ "$actual" == "$expected" ]]; then log "  delta $table: $actual rows"; else log "  delta $table: $actual rows, manifest says $expected  MISMATCH"; bad=1; fi
  done < <(awk '$1 == "delta"' "$M")
  [[ "$seen" == "$(awk '$1 == "delta"' "$M" | wc -l)" ]] || { log "  loaded $seen delta tables of the manifest's"; bad=1; }

  log "comparing with the manifest"
  compare_with_manifest "$M" "$DRILL_DB" || bad=1

  log "checking foreign keys between user tables"
  if fk_check_queries "$PG_DB" user-only | run_fk_checks "$DRILL_DB"; then
    log "  every user-to-user reference resolves"
  else
    bad=1
  fi

  ((bad == 0)) || die "the restored copy does not match the backup's manifest"
  log "drill passed"
}

started=$SECONDS
# The drill's whole log is both shown (journal) and kept for the report. A
# pipeline, so the report is complete when it is read.
set +e
( set -e; drill ) 2>&1 | tee "$REPORT" >&2
code=${PIPESTATUS[0]}
set -e

if [[ $KEEP == 0 ]]; then
  pg -d postgres -q -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
fi
SOURCE="$(cat "$WORK/source" 2>/dev/null || echo unknown)"
rm -rf "$WORK"
verdict=PASSED; ((code == 0)) || verdict=FAILED
{
  printf 'Restore drill %s on %s, %s UTC, %s s.\nBackup: %s\n\n' \
    "$verdict" "$FLYLEAF_HOST" "$(date -u '+%Y-%m-%d %H:%M')" "$((SECONDS - started))" "$SOURCE"
  cat "$REPORT"
} > "$REPORT.full"
log "restore drill $verdict"
if [[ $MAIL == 1 ]]; then
  bash "$DEPLOY_DIR/backup/notify.sh" send "[Flyleaf] restore drill $verdict on $FLYLEAF_HOST" < "$REPORT.full" \
    || log "could not mail the drill report"
fi
rm -f "$REPORT" "$REPORT.full"
exit "$code"
