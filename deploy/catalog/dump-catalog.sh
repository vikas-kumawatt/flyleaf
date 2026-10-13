#!/usr/bin/env bash
# Dumps the CATALOG ONLY from a Flyleaf database. Runs INSIDE the Postgres
# container (postgres:18-alpine ships bash), so pg_dump is the server's own
# version: Export-Catalog.ps1 copies this in and runs it on the laptop, and
# deploy/test/ runs the very same file in a sandbox.
#
#   dump-catalog.sh --out DIR --list catalog-tables.txt [--db flyleaf]
#                   [--include-optional] [--compress zstd:6]
#
# WHAT GOES, WHAT STAYS (config/catalog-tables.txt has the list):
#   - the schema of EVERY table, function, trigger and index, so migrations
#     on the server start from the same point as the laptop;
#   - the rows of the catalog tables, and drizzle's migration journal
#     (schema `drizzle`), so `migrate` knows what has already run;
#   - NO rows from anything else: users, reads, reviews, shelves, follows,
#     activity, events, bench_* personas, rate limits, uploads, imports,
#     moderation, work_stats (ratings aggregated from users), merges and the
#     dedupe queue (they record moves of user rows). A table not in the list
#     is left behind by default, so a new user table can never leak.
#   - pg-boss's schema not at all; the worker creates its own.
# raw_payloads (Open Library's raw JSON, kept for reprocessing) is `optional`
# in the list and stays behind unless --include-optional.
#
# The dump, the row counts and the probes all read one snapshot, so the
# manifest describes exactly what is in the dump even if the laptop's API is
# running.
#
# Output in DIR: catalog.dump (pg_dump custom format) and manifest.txt.

set -Eeuo pipefail
trap 'echo "dump-catalog.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR

OUT="" LIST="" DB="flyleaf" INCLUDE_OPTIONAL=0 COMPRESS="zstd:6"
while (($#)); do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --list) LIST="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --include-optional) INCLUDE_OPTIONAL=1; shift ;;
    --compress) COMPRESS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$OUT" && -r "$LIST" ]] || { echo "usage: $0 --out DIR --list FILE [--db NAME] [--include-optional]" >&2; exit 2; }
PGUSER="${POSTGRES_USER:-flyleaf}"
export PGUSER

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
q() { psql -X -v ON_ERROR_STOP=1 -d "$DB" -Atq "$@"; }

# ---- what to take -----------------------------------------------------------
SELECTED=() SKIPPED_OPTIONAL=()
while read -r name flag _; do
  name="${name%$'\r'}"; flag="${flag%$'\r'}"
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ "$flag" == optional && $INCLUDE_OPTIONAL == 0 ]]; then
    SKIPPED_OPTIONAL+=("$name")
  else
    SELECTED+=("$name")
  fi
done < "$LIST"
((${#SELECTED[@]})) || die "no tables in $LIST"

mapfile -t PUBLIC < <(q -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
in_list() { local x="$1"; shift; local y; for y in "$@"; do [[ "$x" == "$y" ]] && return 0; done; return 1; }
for t in "${SELECTED[@]}"; do
  in_list "$t" "${PUBLIC[@]}" || die "catalog table '$t' does not exist in $DB (is the list out of date?)"
done
EXCLUDED=()
for t in "${PUBLIC[@]}"; do in_list "$t" "${SELECTED[@]}" || EXCLUDED+=("$t"); done

# Schemas other than public, drizzle (kept: the migration journal) and
# pgboss (dropped): their rows are left behind, and named in the manifest.
mapfile -t OTHER_SCHEMAS < <(q -c "SELECT nspname FROM pg_namespace
  WHERE nspname NOT IN ('public', 'drizzle', 'pgboss', 'information_schema')
    AND nspname NOT LIKE 'pg\_%' ORDER BY 1")

# pg_dump writes user mappings with their options, and an fdw password is
# one. Refuse rather than ship a credential.
mappings="$(q -c "SELECT count(*) FROM pg_user_mappings")"
[[ "$mappings" == 0 ]] || die "$DB has $mappings foreign-server user mapping(s); pg_dump would include their passwords. Drop them first."

mkdir -p "$OUT"
rm -f "$OUT/catalog.dump" "$OUT/manifest.txt"

# Room for the dump? Its size is unknown until it exists; the tables' data
# (heap + TOAST, no indexes) is an upper bound before compression.
names="$(printf "'%s'," "${SELECTED[@]}")"
data_bytes="$(q -c "SELECT coalesce(sum(pg_table_size(c.oid)), 0) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN (${names%,})")"
free_bytes="$(( $(df -Pk "$OUT" | awk 'NR == 2 { print $4 }') * 1024 ))"
say "catalog data to dump: $data_bytes bytes before compression; free where the dump is written: $free_bytes bytes"
((free_bytes > data_bytes)) || say "WARNING: less free space than uncompressed data. The dump is compressed, so it may still fit; if it fails with 'No space left on device', free space in Docker's disk first."

# ---- one snapshot -------------------------------------------------------------
coproc SNAP { psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB"; }
printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" >&"${SNAP[1]}"
read -r -t 30 SNAPSHOT <&"${SNAP[0]}" || die "could not export a snapshot"
in_snapshot() {
  local args=(-c "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" -c "SET TRANSACTION SNAPSHOT '$SNAPSHOT'")
  local s; for s in "$@"; do args+=(-c "$s"); done
  q -F ' ' "${args[@]}" -c "COMMIT"
}

say "snapshot $SNAPSHOT; dumping ${#SELECTED[@]} catalog tables from $DB (${#EXCLUDED[@]} tables schema only)"
for t in "${EXCLUDED[@]}"; do say "  rows left behind: $t"; done

exclude=()
for t in "${EXCLUDED[@]}"; do exclude+=("--exclude-table-data=public.\"$t\""); done
for s in "${OTHER_SCHEMAS[@]}"; do exclude+=("--exclude-table-data=\"$s\".*"); done

started=$SECONDS
pg_dump -d "$DB" --snapshot="$SNAPSHOT" -Fc --compress="$COMPRESS" --no-owner --no-privileges \
  --exclude-schema=pgboss "${exclude[@]}" -f "$OUT/catalog.dump"
dump_seconds=$((SECONDS - started))

say "counting rows (same snapshot)"
count_sql=""
for t in "${SELECTED[@]}"; do count_sql+="SELECT 'count', '$t', count(*) FROM public.\"$t\" UNION ALL "; done
count_sql="${count_sql% UNION ALL }"
counts="$(in_snapshot "$count_sql")"
probes="$(in_snapshot \
  "SELECT 'probe works_reader_count_nonzero', count(*) FROM works WHERE reader_count <> 0" \
  "SELECT 'probe works_created_by_user', count(*) FROM works WHERE created_by_user_id IS NOT NULL" \
  "SELECT 'probe works_merged', count(*) FROM works WHERE merged_into_id IS NOT NULL")"
migrations="$(in_snapshot "SELECT count(*) FROM drizzle.__drizzle_migrations")"
created_at="$(in_snapshot "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")"

printf '%s\n' "COMMIT;" '\q' >&"${SNAP[1]}"
wait "$SNAP_PID" 2>/dev/null || true

size_bytes="$(stat -c %s "$OUT/catalog.dump")"
{
  echo "format flyleaf-catalog-1"
  echo "created_at $created_at"
  echo "source_db $DB"
  echo "server_version $(q -c 'SHOW server_version')"
  echo "migrations $migrations"
  echo "compression $COMPRESS"
  echo "dump_seconds $dump_seconds"
  echo "dump_bytes $size_bytes"
  echo "tables_with_rows ${SELECTED[*]}"
  echo "tables_schema_only ${EXCLUDED[*]}"
  echo "optional_left_behind ${SKIPPED_OPTIONAL[*]:-}"
  echo "other_schemas_schema_only ${OTHER_SCHEMAS[*]:-}"
  printf '%s\n' "$counts" "$probes"
  echo "sha256 catalog.dump $(sha256sum "$OUT/catalog.dump" | cut -d' ' -f1)"
} > "$OUT/manifest.txt"

say "done in ${dump_seconds}s: catalog.dump $size_bytes bytes"
cat "$OUT/manifest.txt" >&2
