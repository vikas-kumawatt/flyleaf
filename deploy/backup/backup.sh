#!/usr/bin/env bash
# One backup (architecture §11 rule 1, adapted to $0). Run every 6 hours by
# flyleaf-backup.timer; safe to run by hand: sudo /opt/flyleaf/deploy/backup/backup.sh
#
# WHAT IS IN IT
#   user-data.dump   pg_dump of everything EXCEPT the catalog's rows: every
#                    table's schema, every non-catalog table's data. The
#                    catalog tables are config/catalog-tables.txt.
#   delta/*.csv      the catalog rows this server created or changed since
#                    the catalog was restored from the laptop: works written
#                    by Open Library gap-fill or touched by a dedupe merge
#                    (both sides), with their editions, authorship, authors,
#                    external ids and provenance. Not replayed: rows a merge
#                    DELETED (the loser's authorship), which restore leaves
#                    on the tombstone, where nothing reads them. The catalog itself is backed up once
#                    (backup-catalog.sh), but user rows point at these works,
#                    so without the delta a restore would leave them dangling.
#   manifest.txt     row counts per table, checksums of core tables, file
#                    hashes, the migration count and release: what the
#                    restore drill and a real restore verify against.
# All three are read in ONE snapshot (pg_export_snapshot), so the counts
# describe exactly the rows in the dump while the app keeps writing.
#
# WHERE IT GOES
#   local:  /var/backups/flyleaf/local, newest 2 kept (a fast restore after a
#           bad deploy without waiting for a download)
#   remote: $BACKUP_REMOTE/recent   every run, newest 8 kept (48 hours)
#           $BACKUP_REMOTE/daily    first run of each UTC day, newest 30
#           $BACKUP_REMOTE/monthly  first run of each UTC month, newest 12
# Encrypted with age to BACKUP_AGE_RECIPIENT before it leaves this script;
# the private key is /etc/flyleaf/backup.agekey (and, by step 9 of
# docs/deploy.md, the owner's password manager).
#
# Any failure exits non-zero, and flyleaf-backup.service's OnFailure mails
# the owner. Disk use over 70% mails a warning on every run until fixed.

set -Eeuo pipefail
trap 'echo "backup.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
load_app_env
: "${BACKUP_REMOTE:?BACKUP_REMOTE is not set}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is not set}"

# Core user tables whose CONTENT is checksummed, not just counted: the drill
# proves these came back byte for byte. Each checksum sorts the whole table,
# so the list stays short.
CHECKSUM_TABLES=(users profiles reads reviews shelves shelf_items follows)
KEEP_RECENT=8 KEEP_DAILY=30 KEEP_MONTHLY=12 KEEP_LOCAL=2
DISK_WARN_PERCENT=70

install -d -m 700 "$FLYLEAF_STATE" "$BACKUP_DIR/work" "$BACKUP_DIR/local"
exec 9> "$FLYLEAF_STATE/backup.lock"
flock -n 9 || die "another backup is running"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="flyleaf-$STAMP"
WORK="$BACKUP_DIR/work/$NAME"           # this host
CWORK="$PG_BACKUP_MOUNT/$NAME"          # the same directory, inside the container
OUT="$BACKUP_DIR/local/$NAME.tar.age"
mkdir -p "$WORK/delta"
chmod 777 "$WORK" "$WORK/delta"          # psql in the container writes here
cleanup() { rm -rf "$WORK"; [[ -n "${SNAP_PID:-}" ]] && kill "$SNAP_PID" 2>/dev/null; return 0; }
trap cleanup EXIT

wait_for_pg
CATALOG=()
mapfile -t CATALOG < <(catalog_tables all)
is_catalog() { local t; for t in "${CATALOG[@]}"; do [[ "$t" == "$1" ]] && return 0; done; return 1; }
USER_TABLES=()
while read -r t; do is_catalog "$t" || USER_TABLES+=("$t"); done < <(public_tables "$PG_DB")
((${#USER_TABLES[@]} > 0)) || die "no user tables found in $PG_DB"

# Rows newer than this are the delta. Written by restore-catalog.sh; absent
# means no catalog was ever transferred, and every catalog row is delta.
BASE_AT='1970-01-01T00:00:00Z'
if [[ -r "$FLYLEAF_STATE/catalog-base.env" ]]; then
  BASE_AT="$(sed -n "s/^CATALOG_BASE_AT='\{0,1\}\([^']*\)'\{0,1\}$/\1/p" "$FLYLEAF_STATE/catalog-base.env")"
  [[ -n "$BASE_AT" ]] || die "$FLYLEAF_STATE/catalog-base.env has no CATALOG_BASE_AT"
fi

# ---- 1. one snapshot for everything ---------------------------------------
# A psql session holds a REPEATABLE READ transaction open and exports its
# snapshot; pg_dump and the queries below adopt it, so they all see the
# database at the same instant.
coproc SNAP { docker exec -i "$PG_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB"; }
printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" >&"${SNAP[1]}"
read -r -t 30 SNAPSHOT <&"${SNAP[0]}" || die "could not export a snapshot"
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]] || die "unexpected snapshot id: $SNAPSHOT"

in_snapshot() {  # in_snapshot SQL... : runs each statement inside the snapshot
  local args=(-c "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" -c "SET TRANSACTION SNAPSHOT '$SNAPSHOT'")
  local s; for s in "$@"; do args+=(-c "$s"); done
  args+=(-c "COMMIT")
  pg -d "$PG_DB" -Atq -F ' ' "${args[@]}"
}

log "dumping user data ($NAME, ${#USER_TABLES[@]} tables)"
exclude=()
for t in "${CATALOG[@]}"; do exclude+=("--exclude-table-data=public.$t"); done
# pg-boss's schema is left out: the worker recreates it, and the jobs in it
# are transient (an import queued at the moment of a disaster is re-queued
# by its owner).
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" --snapshot="$SNAPSHOT" \
  -Fc --compress=zstd:6 --no-owner --no-privileges --exclude-schema=pgboss \
  "${exclude[@]}" -f "$CWORK/user-data.dump"

# ---- 2. counts and checksums, same snapshot --------------------------------
count_sql="$(for t in "${USER_TABLES[@]}"; do
  printf "SELECT 'count', %s, count(*) FROM public.%s UNION ALL " "'$t'" "\"$t\""
done)"
count_sql="${count_sql% UNION ALL }"
sum_sql=""
for t in "${CHECKSUM_TABLES[@]}"; do
  sum_sql+="SELECT 'checksum', '$t', md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM public.\"$t\" x UNION ALL "
done
sum_sql="${sum_sql% UNION ALL }"

# ---- 3. the catalog delta, same snapshot -----------------------------------
# Generated columns (search_vector, log_count) are not copied: they are
# recomputed on insert.
cols() {
  pg_value "$PG_DB" "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '$1' AND is_generated = 'NEVER'"
}
# Works created or changed since the base, and the survivors of merges made
# since then: a merge bumps only the loser's updated_at, but moves editions,
# external ids and log counts onto the survivor (catalog/dedupe.ts).
W="SELECT id FROM public.works WHERE created_at > '$BASE_AT'::timestamptz OR updated_at > '$BASE_AT'::timestamptz
   UNION SELECT merged_into_id FROM public.works WHERE updated_at > '$BASE_AT'::timestamptz AND merged_into_id IS NOT NULL"
A="SELECT author_id FROM public.work_authors WHERE work_id IN ($W)"
E="SELECT id FROM public.editions WHERE work_id IN ($W)"
ENTITY="(entity_type = 'work' AND entity_id IN ($W)) OR (entity_type = 'author' AND entity_id IN ($A)) OR (entity_type = 'edition' AND entity_id IN ($E))"
declare -A DELTA=(
  [works]="id IN ($W)"
  [editions]="work_id IN ($W)"
  [authors]="id IN ($A)"
  [work_authors]="work_id IN ($W)"
  [external_ids]="$ENTITY"
  [field_provenance]="$ENTITY"
)
delta_stmts=()
for t in works editions authors work_authors external_ids field_provenance; do
  delta_stmts+=("COPY (SELECT $(cols "$t") FROM public.$t WHERE ${DELTA[$t]}) TO STDOUT WITH (FORMAT csv, HEADER)")
done

log "counting, checksumming and copying the catalog delta (since $BASE_AT)"
in_snapshot "$count_sql" "$sum_sql" > "$WORK/counts.txt"
i=0
for t in works editions authors work_authors external_ids field_provenance; do
  in_snapshot "${delta_stmts[$i]}" > "$WORK/delta/$t.csv"
  # Counted by the server in the same snapshot: catalog text can hold quoted
  # newlines, so the CSV's line count is not its row count.
  echo "delta $t $(in_snapshot "SELECT count(*) FROM public.$t WHERE ${DELTA[$t]}")" >> "$WORK/counts.txt"
  i=$((i + 1))
done
migrations="$(in_snapshot "SELECT count(*) FROM drizzle.__drizzle_migrations")"
db_time="$(in_snapshot "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")"

# Release the snapshot.
printf '%s\n' "COMMIT;" '\q' >&"${SNAP[1]}"
wait "$SNAP_PID" 2>/dev/null || true
SNAP_PID=""

# ---- 4. manifest --------------------------------------------------------------
release="unknown"
[[ -r "$FLYLEAF_HOME/current/REVISION" ]] && release="$(cat "$FLYLEAF_HOME/current/REVISION")"
{
  echo "format flyleaf-backup-1"
  echo "created_at $db_time"
  echo "host $FLYLEAF_HOST"
  echo "release $release"
  echo "migrations $migrations"
  echo "catalog_base_at $BASE_AT"
  echo "server_version $(pg_value "$PG_DB" 'SHOW server_version')"
  cat "$WORK/counts.txt"
} > "$WORK/manifest.txt"
rm -f "$WORK/counts.txt"
(cd "$WORK" && find . -type f ! -name manifest.txt -printf '%P\n' | sort | while read -r f; do
  echo "sha256 $f $(sha256sum "$f" | cut -d' ' -f1)"
done) >> "$WORK/manifest.txt"

# ---- 5. pack, encrypt, prove it opens -------------------------------------
tar --zstd -C "$WORK" -cf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
chmod 600 "$OUT"
# Decrypting needs the private key, which lives on this machine; a backup
# that cannot be read back is caught here, not during a disaster.
if [[ -r "$FLYLEAF_ETC/backup.agekey" ]]; then
  age -d -i "$FLYLEAF_ETC/backup.agekey" "$OUT" | tar --zstd -tf - >/dev/null \
    || die "the encrypted backup does not decrypt and list"
fi
size="$(du -h "$OUT" | cut -f1)"
log "encrypted backup: $OUT ($size)"

# ---- 6. off the machine ----------------------------------------------------
rc() { rclone --drive-use-trash=false "$@"; }   # pruned files leave the quota now, not in 30 days
rc copyto "$OUT" "$BACKUP_REMOTE/recent/$NAME.tar.age"
day="${STAMP:0:8}" month="${STAMP:0:6}"
if ! rc lsf --files-only "$BACKUP_REMOTE/daily" 2>/dev/null | grep -q "^flyleaf-$day"; then
  rc copyto "$BACKUP_REMOTE/recent/$NAME.tar.age" "$BACKUP_REMOTE/daily/$NAME.tar.age"
  log "kept as the daily backup for $day"
fi
if ! rc lsf --files-only "$BACKUP_REMOTE/monthly" 2>/dev/null | grep -q "^flyleaf-$month"; then
  rc copyto "$BACKUP_REMOTE/recent/$NAME.tar.age" "$BACKUP_REMOTE/monthly/$NAME.tar.age"
  log "kept as the monthly backup for $month"
fi

# Newest N of each folder stay. Names sort by time.
prune_remote() {
  local dir="$1" keep="$2" f
  rc lsf --files-only "$BACKUP_REMOTE/$dir" | grep '^flyleaf-.*\.tar\.age$' | sort -r | tail -n +"$((keep + 1))" \
    | while read -r f; do rc deletefile "$BACKUP_REMOTE/$dir/$f" < /dev/null; log "pruned $dir/$f"; done
}
prune_remote recent "$KEEP_RECENT"
prune_remote daily "$KEEP_DAILY"
prune_remote monthly "$KEEP_MONTHLY"
find "$BACKUP_DIR/local" -maxdepth 1 -name 'flyleaf-*.tar.age' -printf '%f\n' | sort -r \
  | tail -n +"$((KEEP_LOCAL + 1))" | while read -r f; do rm -f "$BACKUP_DIR/local/$f"; done

# ---- 7. disk, and the dead-man's switch ---------------------------------------
used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if ((used > DISK_WARN_PERCENT)); then
  df -h / "$FLYLEAF_DATA" | bash "$DEPLOY_DIR/backup/notify.sh" send \
    "[Flyleaf] disk ${used}% full on $FLYLEAF_HOST" || log "could not mail the disk warning"
fi
if [[ -n "${BACKUP_PING_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$BACKUP_PING_URL" >/dev/null || log "could not ping BACKUP_PING_URL"
fi
log "backup done: $NAME ($size), disk ${used}%"
