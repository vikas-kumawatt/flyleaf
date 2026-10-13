# shellcheck shell=bash
# Shared by every server-side script in deploy/. Sourced, never run.
#
# Paths can be overridden from the environment so deploy/test/ can run the
# same scripts against a throwaway container in a sandbox; on the server the
# defaults are what provision.sh creates.

: "${FLYLEAF_ETC:=/etc/flyleaf}"
: "${FLYLEAF_ENV_FILE:=$FLYLEAF_ETC/flyleaf.env}"   # the source of truth, edited by people
: "${FLYLEAF_APP_ENV:=$FLYLEAF_ETC/app.env}"       # rendered from it; what systemd and compose read
: "${FLYLEAF_HOME:=/opt/flyleaf}"
: "${FLYLEAF_STATE:=/var/lib/flyleaf}"
: "${FLYLEAF_DATA:=/srv/flyleaf}"
: "${BACKUP_DIR:=/var/backups/flyleaf}"
: "${IMPORT_DIR:=$FLYLEAF_DATA/import}"
: "${PG_CONTAINER:=flyleaf-pg}"
: "${PG_USER:=flyleaf}"
: "${PG_DB:=flyleaf}"
# Where BACKUP_DIR and IMPORT_DIR appear inside the Postgres container
# (compose.production.yml mounts them). pg_dump writes to a real file there,
# not to a pipe, so the archive has data offsets and pg_restore can reorder.
: "${PG_BACKUP_MOUNT:=/backups}"
: "${PG_IMPORT_MOUNT:=/import}"

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CATALOG_LIST="$DEPLOY_DIR/config/catalog-tables.txt"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || die "run as root: sudo $0"
}

# Every catalog table, or only the ones always transferred (`required`).
catalog_tables() {
  local which="${1:-all}"
  local name flag
  while read -r name flag _; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    [[ "$which" == required && "$flag" == optional ]] && continue
    printf '%s\n' "$name"
  done < "$CATALOG_LIST"
}

# Loads the app environment (rendered, literal values) into this shell.
load_app_env() {
  [[ -r "$FLYLEAF_APP_ENV" ]] || die "$FLYLEAF_APP_ENV is missing: run deploy/provision.sh first"
  set -a
  # shellcheck disable=SC1090
  . "$FLYLEAF_APP_ENV"
  set +a
}

# psql inside the Postgres container. Extra arguments go to psql.
pg() {
  docker exec -i "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PG_USER" "$@"
}

# One value from a query, against $1 (a database name). No stdin (-i): this
# is called inside `while read` loops, and a docker exec that holds stdin
# swallows the rest of the loop's input -- the loop then quietly checks one
# row and stops.
pg_value() {
  local db="$1"; shift
  docker exec "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$db" -Atq -c "$*"
}

pg_ready() {
  docker exec "$PG_CONTAINER" pg_isready -q -U "$PG_USER" -d "$PG_DB"
}

wait_for_pg() {
  for _ in $(seq 1 60); do
    pg_ready && return 0
    sleep 2
  done
  die "Postgres in $PG_CONTAINER did not become ready"
}

# Every table in the public schema, one per line.
public_tables() {
  pg_value "${1:-$PG_DB}" "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"
}

# Writes a file with mode 600 regardless of umask. Content on stdin.
write_private() {
  local path="$1" tmp
  tmp="$(mktemp "$(dirname "$path")/.tmp.XXXXXX")"
  chmod 600 "$tmp"
  cat > "$tmp"
  mv -f "$tmp" "$path"
}

# Refuses a secrets file that others can read.
require_private_file() {
  local path="$1" mode
  [[ -f "$path" ]] || die "$path does not exist"
  mode="$(stat -c '%a' "$path")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || die "$path has mode $mode; it holds secrets, so chmod 600 it first"
}

# Runs a command as the app user, in the current release's apps/api, with
# the app environment -- the same environment systemd gives the services.
# RELEASE_DIR overrides which release (release.sh migrates the NEW one).
run_as_app() {
  local dir="${RELEASE_DIR:-$FLYLEAF_HOME/current}/apps/api"
  [[ -d "$dir" ]] || die "no release at $dir"
  ( load_app_env && cd "$dir" && runuser -u flyleaf -- "$@" )
}
