#!/usr/bin/env bash
# Restores a catalog dump (from Export-Catalog.ps1) into the server's EMPTY
# database, verifies it, then runs the migrations.
#
#   sudo /opt/flyleaf/deploy/catalog/restore-catalog.sh /srv/flyleaf/import/flyleaf-catalog-<stamp>
#        [--jobs 2] [--no-migrate] [--no-services]
#
# Refuses a database that has any user or any work in it. One that has only
# the empty schema from a first release (release.sh migrates) is recreated:
# the dump brings its own schema.
#
# Steps: check the dump's SHA-256 -> stop the API and worker -> recreate the
# database -> pg_restore -> reset what came from laptop users (reader counts)
# -> compare every table's row count with the manifest -> rebuild search
# suggestions -> record the catalog's timestamp for backup.sh's delta ->
# migrate with the current release -> ANALYZE -> start the API and worker.
#
# Time and size: unknown until run. pg_restore prints nothing while it loads
# a table and then builds its indexes; `docker stats flyleaf-pg` shows it working.

set -Eeuo pipefail
trap 'echo "restore-catalog.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"

JOBS=2 MIGRATE=1 SERVICES=1 DIR=""
while (($#)); do
  case "$1" in
    --jobs) JOBS="$2"; shift 2 ;;
    --no-migrate) MIGRATE=0; shift ;;
    --no-services) SERVICES=0; shift ;;
    -*) die "unknown option $1" ;;
    *) DIR="$1"; shift ;;
  esac
done
[[ -n "$DIR" ]] || die "usage: $0 <directory with catalog.dump and manifest.txt> [--jobs N] [--no-migrate]"
DIR="$(cd "$DIR" && pwd)"
IMPORT_REAL="$(cd "$IMPORT_DIR" && pwd)"
[[ "$DIR" == "$IMPORT_REAL"/* ]] || die "$DIR must be inside $IMPORT_DIR (the Postgres container sees only that)"
CDIR="$PG_IMPORT_MOUNT/${DIR#"$IMPORT_REAL"/}"
MANIFEST="$DIR/manifest.txt"
[[ -r "$MANIFEST" && -r "$DIR/catalog.dump" ]] || die "$DIR needs catalog.dump and manifest.txt"
field() { awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }' "$MANIFEST"; }
[[ "$(field format)" == flyleaf-catalog-1 ]] || die "not a flyleaf-catalog-1 manifest"

started=$SECONDS
log "checking the dump's SHA-256"
want="$(awk '$1 == "sha256" && $2 == "catalog.dump" { print $3 }' "$MANIFEST")"
have="$(sha256sum "$DIR/catalog.dump" | cut -d' ' -f1)"
[[ "$want" == "$have" ]] || die "catalog.dump is damaged: sha256 $have, manifest says $want (copy it again)"

wait_for_pg
has_systemd() { [[ -d /run/systemd/system ]]; }

# ---- an empty target, and nobody using it ---------------------------------
tables="$(pg_value postgres "SELECT count(*) FROM pg_database WHERE datname = '$PG_DB'")"
if [[ "$tables" == 1 ]]; then
  n_tables="$(pg_value "$PG_DB" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  if [[ "$n_tables" != 0 ]]; then
    for t in users works; do
      exists="$(pg_value "$PG_DB" "SELECT to_regclass('public.$t') IS NOT NULL")"
      if [[ "$exists" == t ]]; then
        rows="$(pg_value "$PG_DB" "SELECT count(*) FROM (SELECT 1 FROM public.$t LIMIT 1) x")"
        [[ "$rows" == 0 ]] || die "$PG_DB already has rows in $t. This restore is only for a fresh database; see docs/deploy.md, \"Starting the database over\"."
      fi
    done
  fi
fi
if [[ $SERVICES == 1 ]] && has_systemd; then
  log "stopping the API and worker"
  systemctl stop flyleaf-api flyleaf-worker 2>/dev/null || true
fi
log "recreating database $PG_DB (owner flyleaf_owner)"
pg -d postgres -q -c "DROP DATABASE IF EXISTS \"$PG_DB\" WITH (FORCE)"
apply_db_roles   # creates it again, owned by flyleaf_owner, with the app role's grants

# ---- restore --------------------------------------------------------------------
log "pg_restore with $JOBS jobs (dump made $(field created_at), $(field dump_bytes) bytes)"
# --role: every object is created as flyleaf_owner, so it owns the schema
# exactly as if its migrations had built it.
docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" --role=flyleaf_owner --no-owner --no-privileges \
  --exit-on-error -j "$JOBS" "$CDIR/catalog.dump"

# reader_count counted the laptop's users' reads, which did not come along.
# The migration step's backfill recounts from this server's (empty) reads
# only for works that have reads, so zero it here.
reset="$(pg_value "$PG_DB" "WITH u AS (UPDATE works SET reader_count = 0 WHERE reader_count <> 0 RETURNING 1) SELECT count(*) FROM u")"
log "reader_count reset on $reset works (laptop reads stay on the laptop)"

# ---- verify -------------------------------------------------------------------
log "verifying row counts against the manifest"
bad=0 seen=0
printf '  %-24s %14s %14s\n' table expected restored >&2
while read -r _ table expected; do
  seen=$((seen + 1))
  actual="$(pg_value "$PG_DB" "SELECT count(*) FROM public.\"$table\"")"
  mark=ok; [[ "$actual" == "$expected" ]] || { mark=MISMATCH; bad=1; }
  printf '  %-24s %14s %14s  %s\n' "$table" "$expected" "$actual" "$mark" >&2
done < <(awk '$1 == "count"' "$MANIFEST")
[[ $bad == 0 ]] || die "row counts differ from the manifest"
want="$(awk '$1 == "count"' "$MANIFEST" | wc -l)"
[[ "$seen" == "$want" && "$want" -gt 0 ]] || die "compared $seen of $want tables in the manifest"
for t in $(field tables_schema_only); do
  rows="$(pg_value "$PG_DB" "SELECT count(*) FROM (SELECT 1 FROM public.\"$t\" LIMIT 1) x")"
  [[ "$rows" == 0 ]] || die "$t should have come over empty and has rows"
done
log "every table matches; user tables are empty"

terms="$(pg_value "$PG_DB" "SELECT refresh_search_suggestions()" 2>/dev/null || echo "skipped")"
log "search suggestions rebuilt: $terms terms"

install -d -m 700 "$FLYLEAF_STATE"
write_private "$FLYLEAF_STATE/catalog-base.env" <<EOF
# Written by restore-catalog.sh. backup.sh treats catalog rows created or
# updated after this moment as this server's own, and backs them up.
CATALOG_BASE_AT='$(field created_at)'
CATALOG_DUMP_SHA256='$want'
CATALOG_SOURCE='$DIR'
EOF
cp "$MANIFEST" "$FLYLEAF_STATE/catalog-manifest.txt"

# ---- migrate ------------------------------------------------------------------
if [[ $MIGRATE == 1 ]]; then
  log "migrating (dump had $(field migrations) migrations applied)"
  if [[ -n "${MIGRATE_CMD:-}" ]]; then
    bash -c "$MIGRATE_CMD"
    apply_db_roles
  elif [[ -e "$FLYLEAF_HOME/current/apps/api/dist/migrate.js" ]]; then
    run_migrations
  else
    die "no release at $FLYLEAF_HOME/current to migrate with: run deploy/release.sh, which migrates"
  fi
  after="$(pg_value "$PG_DB" "SELECT count(*) FROM drizzle.__drizzle_migrations")"
  log "migrations now: $after"
  while read -r _ table expected; do
    actual="$(pg_value "$PG_DB" "SELECT count(*) FROM public.\"$table\"")"
    [[ "$actual" == "$expected" ]] || log "  note: a migration changed $table: $expected -> $actual rows"
  done < <(awk '$1 == "count"' "$MANIFEST")
fi

[[ $MIGRATE == 1 ]] || apply_db_roles
log "ANALYZE"
pg -d "$PG_DB" -q -c "ANALYZE"

if [[ $SERVICES == 1 ]] && has_systemd && [[ -e "$FLYLEAF_HOME/current" ]]; then
  systemctl start flyleaf-api flyleaf-worker
  log "API and worker started"
fi
log "catalog restored in $((SECONDS - started)) s"
