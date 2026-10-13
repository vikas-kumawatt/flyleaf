#!/usr/bin/env bash
# SC2031: the provision.sh steps run in subshells on purpose. SC2016: literal $ for pwsh.
# SC1090: the rendered env file is a path known only at run time.
# shellcheck disable=SC2031,SC2016,SC1090
# End-to-end test of the deploy kit in a sandbox with Docker. Not part of CI
# (it needs a Docker daemon, about 5 minutes, and the images below); run it
# after changing anything in deploy/:
#
#   bash deploy/test/sandbox-e2e.sh
#
# It runs the REAL scripts against the REAL production compose file; only
# paths move into a temp directory, the off-site remote is an rclone `local`
# remote, and mail goes to an SMTP sink on 127.0.0.1:2525 if one is listening.
#
#   1. shellcheck, configure-env (answers file), the Caddyfile (caddy validate)
#   2. compose.production.yml up: settings, loopback-only ports, MinIO key scoped to its bucket
#   3. "laptop": a second Postgres with tests/fixture.sql (catalog + users + bench + junk schemas);
#      Export-Catalog.ps1 under pwsh (or dump-catalog.sh directly without pwsh)
#   4. privacy: no user/bench/telemetry/scratch/pg-boss row is anywhere in the dump
#   5. restore-catalog.sh into the server (after a first-release empty schema), counts, refusals
#   6. app activity (users, reads, a gap-filled work, a merge), backup.sh, retention pruning
#   7. restore-drill.sh passes; a tampered manifest and a damaged archive fail it
#   8. restore-full.sh into a fresh database: counts, checksums, every FK, the gap-filled work
#   9. backup-catalog.sh: encrypted catalog copy on the remote, verified
#
# Needs: docker, node + apps/api's node_modules, age, rclone, zstd; pwsh and
# caddy are used when present. Leaves nothing running (--keep to inspect).

set -Eeuo pipefail
trap 'echo "sandbox-e2e.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$REPO/deploy"
KEEP=0; [[ "${1:-}" == --keep ]] && KEEP=1
: "${POSTGRES_TEST_IMAGE:=postgres:18-alpine}"
: "${MINIO_TEST_IMAGE:=pgsty/minio:RELEASE.2026-08-04T00-00-00Z}"
SHELLCHECK="${SHELLCHECK:-shellcheck}"

T="$(mktemp -d /tmp/flyleaf-kit-e2e.XXXXXX)"
LAPTOP=flyleaf-kit-laptop
PASS=0
ok() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
section() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# expect_fail WHAT PATTERN CMD...: CMD must fail, and say PATTERN while doing so.
expect_fail() {
  local what="$1" pattern="$2"; shift 2
  if "$@" >"$T/last.log" 2>&1; then cat "$T/last.log"; fail "$what: should have failed"; fi
  grep -qE "$pattern" "$T/last.log" || { cat "$T/last.log"; fail "$what: failed, but not with /$pattern/"; }
  ok "$what -> refused: $(grep -m1 -E "$pattern" "$T/last.log" | sed 's/^[0-9:]* //; s/^ *//' | cut -c1-90)"
}

# Every script reads these instead of the server paths.
export FLYLEAF_ETC="$T/etc" FLYLEAF_ENV_FILE="$T/etc/flyleaf.env" FLYLEAF_APP_ENV="$T/etc/app.env"
export FLYLEAF_HOME="$T/home" FLYLEAF_STATE="$T/state" FLYLEAF_DATA="$T/data"
export BACKUP_DIR="$T/backups" IMPORT_DIR="$T/import" RCLONE_CONFIG="$T/rclone.conf"
mkdir -p "$FLYLEAF_HOME" "$FLYLEAF_DATA/postgres" "$FLYLEAF_DATA/minio" "$BACKUP_DIR/work" "$BACKUP_DIR/local" "$IMPORT_DIR" "$T/remote"
chmod 755 "$FLYLEAF_DATA/postgres"

compose() { docker compose -p flyleaf-kit-test -f "$KIT/compose.production.yml" --env-file "$FLYLEAF_APP_ENV" "$@"; }
cleanup() {
  if [[ $KEEP == 1 ]]; then echo "kept: $T (compose project flyleaf-kit-test, container $LAPTOP)"; return; fi
  compose down -v >/dev/null 2>&1 || true
  docker rm -f "$LAPTOP" >/dev/null 2>&1 || true
  docker run --rm -v "$T:/t" "$POSTGRES_TEST_IMAGE" sh -c 'rm -rf /t/data /t/backups /t/import' >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT

# --------------------------------------------------------------------------
section "1. static checks and configuration"
if (cd "$KIT" && "$SHELLCHECK" -x ./*.sh ./*/*.sh); then ok "shellcheck: every script in deploy/"; else fail "shellcheck"; fi
cat > "$T/answers" <<'EOF'
FLYLEAF_HOST=flyleaf-e2e.centralindia.cloudapp.azure.com
OWNER_EMAIL=owner@example.com
GMAIL_ADDRESS=sender@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
EXPO_ACCESS_TOKEN=
EOF
chmod 600 "$T/answers"
"$KIT/configure-env.sh" --answers "$T/answers" 2>/dev/null
if [[ "$(stat -c %a "$FLYLEAF_APP_ENV")" == 600 && "$(stat -c %a "$FLYLEAF_ETC/backup.agekey")" == 600 ]]; then ok "configure-env: env files and age key are mode 600"; else fail "configure-env: env files and age key are mode 600"; fi
# Test overrides: local images, the local rclone remote, the SMTP sink.
sed -i -e "s#^POSTGRES_IMAGE=.*#POSTGRES_IMAGE='$POSTGRES_TEST_IMAGE'#" \
       -e "s#^MINIO_IMAGE=.*#MINIO_IMAGE='$MINIO_TEST_IMAGE'#" \
       -e "s#^BACKUP_REMOTE=.*#BACKUP_REMOTE='e2e:$T/remote/flyleaf-backups'#" \
       -e "s#^SMTP_URL=.*#SMTP_URL='smtp://sender%40gmail.com:pw@127.0.0.1:2525'#" "$FLYLEAF_ENV_FILE"
"$KIT/configure-env.sh" --render 2>/dev/null
printf '[e2e]\ntype = local\n' > "$RCLONE_CONFIG"
set -a; . "$FLYLEAF_APP_ENV"; set +a
if [[ "$S3_ENDPOINT" == "https://$FLYLEAF_HOST" && "$APP_BASE_URL" == "https://$FLYLEAF_HOST" && "$DATABASE_URL" == "postgres://flyleaf_app:$APP_DB_PASSWORD@127.0.0.1:5432/flyleaf" && "$MIGRATION_DATABASE_URL" == "postgres://flyleaf_owner:$OWNER_DB_PASSWORD@127.0.0.1:5432/flyleaf" && "$APP_DB_PASSWORD" != "$OWNER_DB_PASSWORD" ]]; then ok "derived values: URLs from FLYLEAF_HOST; the app connects as flyleaf_app, migrations as flyleaf_owner"; else fail "derived values"; fi

if command -v caddy >/dev/null; then
  # shellcheck source=../provision.sh
  (. "$KIT/provision.sh"; render_caddyfile) > "$T/Caddyfile"
  if caddy validate --config "$T/Caddyfile" --adapter caddyfile >/dev/null 2>&1; then ok "Caddyfile renders and validates ($(caddy version | cut -d' ' -f1))"; else fail "Caddyfile renders and validates ($(caddy version | cut -d' ' -f1))"; fi
  if grep -q "^flyleaf-e2e.centralindia.cloudapp.azure.com {" "$T/Caddyfile" && grep -q "path /flyleaf-files /flyleaf-files/\*" "$T/Caddyfile"; then ok "Caddyfile: host and storage path rendered"; else fail "Caddyfile: host and storage path rendered"; fi
else
  echo "  (caddy not installed: Caddyfile not validated)"
fi

# --------------------------------------------------------------------------
section "2. production compose stack"
compose up -d --wait >/dev/null 2>&1 || { compose logs; fail "compose up"; }
ok "postgres and minio healthy"
. "$KIT/lib/common.sh"
s="$(pg_value postgres "SELECT string_agg(name || '=' || setting || coalesce(unit, ''), ' ' ORDER BY name) FROM pg_settings WHERE name IN ('shared_buffers','max_connections','work_mem','maintenance_work_mem','autovacuum_work_mem','max_wal_size','effective_cache_size')")"
if [[ "$s" == *"max_connections=60"* && "$s" == *"shared_buffers=655368kB"* && "$s" == *"max_wal_size=2048MB"* ]]; then ok "postgres settings: $s"; else fail "postgres settings: $s"; fi
if [[ "$(docker inspect -f '{{.HostConfig.ShmSize}} {{.HostConfig.Memory}}' flyleaf-pg)" == "536870912 2147483648" ]]; then ok "postgres: shm 512 MB, memory limit 2 GB"; else fail "postgres: shm 512 MB, memory limit 2 GB"; fi
if [[ "$(docker inspect -f '{{.HostConfig.Memory}}' flyleaf-minio)" == 536870912 ]]; then ok "minio: memory limit 512 MB"; else fail "minio: memory limit 512 MB"; fi
ports="$(docker port flyleaf-pg; docker port flyleaf-minio)"
grep -qv '^.* -> 127\.0\.0\.1:' <<<"$ports" && { echo "$ports"; fail "a port is published beyond loopback"; }
ok "every published port is on 127.0.0.1 only"
if [[ -d "$FLYLEAF_DATA/postgres/18/docker" ]]; then ok "PGDATA is in the bind mount ($FLYLEAF_DATA/postgres/18/docker)"; else fail "PGDATA is in the bind mount ($FLYLEAF_DATA/postgres/18/docker)"; fi
if (. "$KIT/provision.sh"; step_dbroles; step_dbroles) 2>/dev/null; then ok "database roles applied twice (idempotent)"; else fail "dbroles step"; fi
roles="$(pg_value postgres "SELECT string_agg(rolname || ':' || rolsuper || rolcreatedb || rolcreaterole, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('flyleaf_owner', 'flyleaf_app')")"
if [[ "$roles" == "flyleaf_app:falsefalsefalse flyleaf_owner:falsefalsefalse" ]]; then ok "owner and app roles: no superuser, createdb or createrole ($roles)"; else fail "roles: $roles"; fi
if [[ "$(pg_value postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'flyleaf'")" == flyleaf_owner ]]; then ok "database flyleaf owned by flyleaf_owner"; else fail "database owner"; fi
if (. "$KIT/provision.sh"; step_storage; step_storage) 2>/dev/null; then ok "storage step runs twice (idempotent)"; else fail "storage step runs twice (idempotent)"; fi
key_ok="$(MC_HOST_app="http://$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY@127.0.0.1:9000" docker exec -e MC_HOST_app flyleaf-minio sh -c \
  'echo hi > /tmp/o && mc cp -q /tmp/o app/flyleaf-files/probe >/dev/null && echo put-ok; mc mb app/other-bucket >/dev/null 2>&1 && echo mb-allowed || echo mb-denied')"
if [[ "$key_ok" == $'put-ok\nmb-denied' ]]; then ok "app key: can write its bucket, cannot create others"; else fail "app key: can write its bucket, cannot create others"; fi

# --------------------------------------------------------------------------
section "3. laptop: a database with catalog, users, bench and junk; the export"
docker rm -f "$LAPTOP" >/dev/null 2>&1 || true
docker run -d --name "$LAPTOP" -e POSTGRES_USER=flyleaf -e POSTGRES_PASSWORD=flyleaf -e POSTGRES_DB=flyleaf \
  -p 127.0.0.1:55432:5432 "$POSTGRES_TEST_IMAGE" >/dev/null
for _ in $(seq 1 30); do docker exec "$LAPTOP" pg_isready -q -U flyleaf -d flyleaf 2>/dev/null && break; sleep 1; done
sleep 2
(cd "$REPO/apps/api" && DATABASE_URL=postgres://flyleaf:flyleaf@127.0.0.1:55432/flyleaf npm run --silent migrate >/dev/null)
docker exec -i "$LAPTOP" psql -X -q -v ON_ERROR_STOP=1 -U flyleaf -d flyleaf < "$KIT/test/fixture.sql"
ok "laptop database migrated and loaded with the fixture"
EXPORT="$IMPORT_DIR/flyleaf-catalog-e2e"
if command -v pwsh >/dev/null; then
  pwsh -NoProfile -File "$KIT/catalog/Export-Catalog.ps1" -Container "$LAPTOP" -OutDir "$T/ps-out" > "$T/ps.log" 2>&1 || { cat "$T/ps.log"; fail "Export-Catalog.ps1"; }
  mv "$T"/ps-out/flyleaf-catalog-* "$EXPORT"
  ok "Export-Catalog.ps1 (pwsh $(pwsh -NoProfile -c '$PSVersionTable.PSVersion.ToString()')) exported and verified the hash"
else
  docker cp "$KIT/catalog/dump-catalog.sh" "$LAPTOP:/tmp/dump-catalog.sh"
  docker cp "$KIT/config/catalog-tables.txt" "$LAPTOP:/tmp/catalog-tables.txt"
  docker exec "$LAPTOP" bash /tmp/dump-catalog.sh --out /tmp/out --list /tmp/catalog-tables.txt 2>/dev/null
  docker cp "$LAPTOP:/tmp/out/." "$EXPORT"
  ok "dump-catalog.sh exported (pwsh not installed: the .ps1 wrapper was not run)"
fi
M="$EXPORT/manifest.txt"
if grep -q '^count works 5$' "$M" && grep -q '^count editions 3$' "$M" && grep -q '^count authors 3$' "$M"; then ok "manifest counts: 5 works, 3 editions, 3 authors"; else fail "manifest counts: 5 works, 3 editions, 3 authors"; fi
if grep -q '^optional_left_behind raw_payloads$' "$M"; then ok "raw_payloads left behind unless -IncludeRawPayloads"; else fail "raw_payloads left behind unless -IncludeRawPayloads"; fi
if grep -q '^probe works_reader_count_nonzero 2$' "$M"; then ok "probe: 2 works carry laptop reader counts"; else fail "probe: 2 works carry laptop reader counts"; fi

# --------------------------------------------------------------------------
section "4. privacy: what is inside the catalog dump"
docker exec "$LAPTOP" sh -c 'mkdir -p /tmp/chk' && docker cp "$EXPORT/catalog.dump" "$LAPTOP:/tmp/chk/catalog.dump"
data_tables="$(docker exec "$LAPTOP" pg_restore -l /tmp/chk/catalog.dump | awk '/ TABLE DATA /{print $(NF-2)"."$(NF-1)}' | sort | paste -sd' ' -)"
want_tables="$( (echo drizzle.__drizzle_migrations; catalog_tables required | sed 's/^/public./') | sort | paste -sd' ' -)"
[[ "$data_tables" == "$want_tables" ]] || fail "tables with rows in the dump: $data_tables; expected: $want_tables"
ok "rows only for: $data_tables"
docker exec "$LAPTOP" sh -c 'pg_restore -f - /tmp/chk/catalog.dump' > "$T/catalog.sql"
for secret in alice.private@example.com bench_reader_7 secret-hash PRIVATE-REVIEW-TEXT SCRATCH-NOTE PGBOSS-JOB search.performed '"title": "A Wizard'; do
  grep -qF "$secret" "$T/catalog.sql" && fail "the dump contains '$secret'"
done
ok "no user, bench, review, event, scratch, pg-boss or raw-payload row in the dump"
if grep -q 'CREATE TABLE public.users' "$T/catalog.sql" && grep -q 'Earthsea' "$T/catalog.sql"; then ok "schema of every table and the catalog rows are present"; else fail "schema of every table and the catalog rows are present"; fi
if ! grep -q 'CREATE SCHEMA pgboss' "$T/catalog.sql"; then ok "pg-boss schema left out entirely"; else fail "pg-boss schema left out entirely"; fi

# --------------------------------------------------------------------------
section "5. server: restore the catalog"
# Migrations run as flyleaf_owner, as release.sh runs them.
export MIGRATE_CMD="cd '$REPO/apps/api' && DATABASE_URL='$MIGRATION_DATABASE_URL' npm run --silent migrate >/dev/null"
bash -c "$MIGRATE_CMD"   # what a first release.sh does to the empty database
ok "first release migrated an empty database as flyleaf_owner (not a superuser)"
cp -r "$EXPORT" "$IMPORT_DIR/damaged" && printf 'x' >> "$IMPORT_DIR/damaged/catalog.dump"
expect_fail "restore-catalog: damaged dump" "catalog.dump is damaged" "$KIT/catalog/restore-catalog.sh" "$IMPORT_DIR/damaged"
"$KIT/catalog/restore-catalog.sh" "$EXPORT" > "$T/restore-catalog.log" 2>&1 || { cat "$T/restore-catalog.log"; fail "restore-catalog"; }
ok "restore-catalog.sh: sha256, restore, counts, migrate"
if [[ "$(pg_value flyleaf 'SELECT count(*) FROM works')" == 5 && "$(pg_value flyleaf 'SELECT count(*) FROM users')" == 0 ]]; then ok "5 works, 0 users"; else fail "5 works, 0 users"; fi
if [[ "$(pg_value flyleaf 'SELECT count(*) FROM works WHERE reader_count <> 0')" == 0 ]]; then ok "laptop reader counts reset"; else fail "laptop reader counts reset"; fi
if [[ "$(pg_value flyleaf 'SELECT count(*) FROM raw_payloads')" == 0 ]]; then ok "raw_payloads empty (left behind)"; else fail "raw_payloads empty (left behind)"; fi
if [[ "$(pg_value flyleaf "SELECT count(*) FROM search_suggestions")" -ge 1 ]]; then ok "search suggestions rebuilt"; else fail "search suggestions rebuilt"; fi
if grep -q "^CATALOG_BASE_AT='$(awk '$1=="created_at"{print $2}' "$M")'$" "$FLYLEAF_STATE/catalog-base.env"; then ok "catalog-base.env records the dump's time"; else fail "catalog-base.env records the dump's time"; fi
if [[ "$(pg_value flyleaf 'SELECT count(*) FROM drizzle.__drizzle_migrations')" == "$(awk '$1=="migrations"{print $2}' "$M")" ]]; then ok "migration journal came along (migrate had nothing to redo)"; else fail "migration journal came along (migrate had nothing to redo)"; fi
not_owned="$(pg_value flyleaf "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r','p','v','m','S') AND pg_get_userbyid(c.relowner) <> 'flyleaf_owner'")"
if [[ "$not_owned" == 0 && "$(pg_value flyleaf "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'pgboss'")" == flyleaf_app ]]; then
  ok "after the restore: every table owned by flyleaf_owner, pgboss by flyleaf_app"; else fail "ownership after restore ($not_owned not owned by flyleaf_owner)"; fi
expect_fail "restore-catalog: database already has a catalog" "already has rows in works" "$KIT/catalog/restore-catalog.sh" "$EXPORT"

# --------------------------------------------------------------------------
section "6. app activity, then backups"
pg -d flyleaf -q <<'SQL'
INSERT INTO users (id, email, password_hash, date_of_birth) VALUES
  ('11000000-0000-4000-8000-000000000001', 'prod.one@example.com', 'h', '1991-02-03'),
  ('11000000-0000-4000-8000-000000000002', 'prod.two@example.com', 'h', '1992-03-04');
INSERT INTO profiles (user_id, username) VALUES
  ('11000000-0000-4000-8000-000000000001', 'prodone'), ('11000000-0000-4000-8000-000000000002', 'prodtwo');
-- Gap-fill: a work this server fetched from Open Library, with its author.
INSERT INTO authors (id, ol_author_key, name) VALUES ('a1000000-0000-4000-8000-000000000001', 'OL77A', E'New, "Author"\nSecond line');
INSERT INTO works (id, ol_work_key, title) VALUES ('b1000000-0000-4000-8000-000000000001', 'OL77W', E'Gap-filled, with\n"newline" ✓');
INSERT INTO work_authors (work_id, author_id) VALUES ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001');
INSERT INTO external_ids (entity_type, entity_id, provider, external_id) VALUES ('work', 'b1000000-0000-4000-8000-000000000001', 'open_library', 'OL77W');
INSERT INTO field_provenance (entity_type, entity_id, field_name, provider) VALUES ('work', 'b1000000-0000-4000-8000-000000000001', 'title', 'open_library');
-- A dedupe merge on the server: an old work becomes a tombstone.
-- What catalog/dedupe.ts does: the loser is tombstoned (its updated_at
-- bumped), the survivor gains its log count (its updated_at NOT bumped).
UPDATE works SET merged_into_id = 'b0000000-0000-4000-8000-000000000002', updated_at = now() WHERE id = 'b0000000-0000-4000-8000-000000000005';
UPDATE works SET ol_log_count = ol_log_count + 700 WHERE id = 'b0000000-0000-4000-8000-000000000002';
INSERT INTO reads (user_id, work_id, status, rating) VALUES
  ('11000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'finished', 5.0),
  ('11000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'reading', NULL);
INSERT INTO follows (follower_id, followee_id) VALUES ('11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002');
INSERT INTO shelves (id, user_id, name, slug) VALUES ('31000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'To read', 'to-read');
INSERT INTO shelf_items (shelf_id, work_id) VALUES ('31000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001');
SQL
ok "server data: 2 users, reads, a gap-filled work + author, a merge"
"$KIT/backup/backup.sh" > "$T/backup1.log" 2>&1 || { cat "$T/backup1.log"; fail "backup.sh"; }
ok "backup.sh"
R="$T/remote/flyleaf-backups"
n_recent="$(find "$R/recent" -name '*.tar.age' | wc -l)"; n_daily="$(find "$R/daily" -name '*.tar.age' | wc -l)"; n_monthly="$(find "$R/monthly" -name '*.tar.age' | wc -l)"
if [[ "$n_recent $n_daily $n_monthly" == "1 1 1" ]]; then ok "remote: recent, daily and monthly each hold the first backup"; else fail "remote: recent, daily and monthly each hold the first backup"; fi
B="$(find "$R/recent" -name '*.tar.age' | head -1)"
if head -c 22 "$B" | grep -q 'age-encryption.org/v1'; then ok "the remote copy is age-encrypted"; else fail "the remote copy is age-encrypted"; fi
mkdir -p "$T/peek" && age -d -i "$FLYLEAF_ETC/backup.agekey" "$B" | tar --zstd -x -C "$T/peek"
if grep -q '^delta works 3$' "$T/peek/manifest.txt" && grep -q '^delta authors 2$' "$T/peek/manifest.txt" && grep -q '^delta work_authors 3$' "$T/peek/manifest.txt" && grep -q '^delta editions 1$' "$T/peek/manifest.txt"; then ok "delta: 3 works (gap-filled, merge loser and survivor), 2 authors, 3 authorships, the survivor's edition"; else grep '^delta' "$T/peek/manifest.txt"; fail "delta contents"; fi
if grep -q '^count users 2$' "$T/peek/manifest.txt" && grep -q '^checksum users ' "$T/peek/manifest.txt"; then ok "manifest: user counts and checksums"; else fail "manifest: user counts and checksums"; fi
for t in $(catalog_tables all); do grep -q "^count $t " "$T/peek/manifest.txt" && fail "catalog table $t counted as user data"; done
ok "no catalog table in the user-data counts"
# Retention: plant old backups, run again, expect the newest N.
for i in $(seq -w 1 12); do touch "$R/recent/flyleaf-202601${i}T000000Z.tar.age"; done
for i in $(seq 1 40); do touch "$R/daily/flyleaf-2025$(printf '%04d' "$i")T000000Z.tar.age"; done
for i in $(seq -w 1 14); do touch "$R/monthly/flyleaf-20$i""01T000000Z.tar.age"; done
"$KIT/backup/backup.sh" > "$T/backup2.log" 2>&1 || { cat "$T/backup2.log"; fail "second backup.sh"; }
n_recent="$(find "$R/recent" -name '*.tar.age' | wc -l)"; n_daily="$(find "$R/daily" -name '*.tar.age' | wc -l)"; n_monthly="$(find "$R/monthly" -name '*.tar.age' | wc -l)"
if [[ "$n_recent $n_daily $n_monthly" == "8 30 12" ]]; then ok "retention: 8 recent, 30 daily, 12 monthly ($n_recent $n_daily $n_monthly)"; else fail "retention: 8 recent, 30 daily, 12 monthly ($n_recent $n_daily $n_monthly)"; fi
if [[ "$(find "$BACKUP_DIR/local" -name '*.tar.age' | wc -l)" == 2 ]]; then ok "local: newest 2 kept"; else fail "local: newest 2 kept"; fi
newest_daily="$(find "$R/daily" -name '*.tar.age' -size +0 | wc -l)"
if [[ "$newest_daily" == 1 ]]; then ok "daily: one real backup for today, not two"; else fail "daily: one real backup for today, not two"; fi

# --------------------------------------------------------------------------
section "7. restore drill"
"$KIT/backup/restore-drill.sh" > "$T/drill.log" 2>&1 || { cat "$T/drill.log"; fail "restore drill"; }
if grep -q 'restore drill PASSED' "$T/drill.log" && grep -q 'every user-to-user reference resolves' "$T/drill.log"; then ok "restore-drill.sh passed (newest backup, from the remote)"; else fail "restore-drill.sh passed (newest backup, from the remote)"; fi
n_user_tables="$(awk '$1 == "count"' "$T/peek/manifest.txt" | wc -l)"
if grep -q "  $n_user_tables counts and 7 content checksums identical" "$T/drill.log"; then ok "drill compared all $n_user_tables user tables and 7 checksums"; else fail "drill compared all $n_user_tables user tables and 7 checksums"; fi
if [[ "$(grep -c '  delta .*: [0-9]* rows$' "$T/drill.log")" == 6 ]]; then ok "drill loaded all 6 delta tables"; else fail "drill loaded all 6 delta tables"; fi
if [[ "$(pg_value postgres "SELECT count(*) FROM pg_database WHERE datname = 'flyleaf_drill'")" == 0 ]]; then ok "scratch database dropped"; else fail "scratch database dropped"; fi
# Tampered: a manifest that claims a user too many.
mkdir -p "$T/tamper" && age -d -i "$FLYLEAF_ETC/backup.agekey" "$B" | tar --zstd -x -C "$T/tamper"
sed -i 's/^count users 2$/count users 3/' "$T/tamper/manifest.txt"
tar --zstd -C "$T/tamper" -cf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "$T/tampered.tar.age"
expect_fail "restore drill: a count that does not match" "users +3 +2  MISMATCH" "$KIT/backup/restore-drill.sh" --file "$T/tampered.tar.age"
# Damaged: one byte of the dump changed under an intact manifest.
mkdir -p "$T/damage" && age -d -i "$FLYLEAF_ETC/backup.agekey" "$B" | tar --zstd -x -C "$T/damage"
printf 'X' | dd of="$T/damage/user-data.dump" bs=1 seek=100 conv=notrunc 2>/dev/null
tar --zstd -C "$T/damage" -cf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "$T/damaged.tar.age"
expect_fail "restore drill: a damaged dump" "user-data.dump is damaged inside" "$KIT/backup/restore-drill.sh" --file "$T/damaged.tar.age"

# --------------------------------------------------------------------------
section "8. disaster: restore-full into a fresh database"
before_reads="$(pg_value flyleaf "SELECT md5(string_agg(r::text, '|' ORDER BY r::text)) FROM reads r")"
before_works="$(pg_value flyleaf "SELECT md5(string_agg(w.id::text || w.title || coalesce(w.merged_into_id::text, '-') || w.ol_log_count, '|' ORDER BY w.id)) FROM works w")"
latest="$(find "$BACKUP_DIR/local" -name '*.tar.age' | sort | tail -1)"
pg -d postgres -q -c 'DROP DATABASE flyleaf WITH (FORCE)'
bash "$KIT/db-roles.sh" 2>/dev/null   # the new machine's provision.sh
bash -c "$MIGRATE_CMD"   # the new machine's first release
"$KIT/backup/restore-full.sh" --catalog "$EXPORT" --backup "$latest" --yes > "$T/full.log" 2>&1 || { cat "$T/full.log"; fail "restore-full"; }
if grep -q 'every reference resolves' "$T/full.log" && grep -q "  $n_user_tables counts and 7 content checksums identical" "$T/full.log"; then ok "restore-full.sh: all $n_user_tables counts, 7 checksums, every foreign key"; else fail "restore-full.sh: all $n_user_tables counts, 7 checksums, every foreign key"; fi
if [[ "$(grep -c 'delta .*rows applied' "$T/full.log")" == 6 ]]; then ok "restore-full applied all 6 delta tables"; else fail "restore-full applied all 6 delta tables"; fi
if [[ "$(pg_value flyleaf "SELECT md5(string_agg(r::text, '|' ORDER BY r::text)) FROM reads r")" == "$before_reads" ]]; then ok "reads identical to before the disaster"; else fail "reads identical to before the disaster"; fi
if [[ "$(pg_value flyleaf "SELECT md5(string_agg(w.id::text || w.title || coalesce(w.merged_into_id::text, '-') || w.ol_log_count, '|' ORDER BY w.id)) FROM works w")" == "$before_works" ]]; then ok "works identical: laptop catalog + gap-filled work + both sides of the merge"; else fail "works identical: laptop catalog + gap-filled work + the merge"; fi
if [[ "$(pg_value flyleaf "SELECT reader_count FROM works WHERE id = 'b1000000-0000-4000-8000-000000000001'")" == 1 ]]; then ok "reader_count recounted from the restored reads"; else fail "reader_count recounted from the restored reads"; fi
expect_fail "restore-full: refuses a database with users" "already has rows in users" "$KIT/backup/restore-full.sh" --catalog "$EXPORT" --backup "$latest" --yes

# --------------------------------------------------------------------------
section "9. the catalog's off-site copy"
"$KIT/backup/backup-catalog.sh" "$EXPORT" > "$T/cat.log" 2>&1 || { cat "$T/cat.log"; fail "backup-catalog"; }
C="$(find "$R/catalog" -name 'flyleaf-catalog-*.tar.age' | head -1)"
if [[ -n "$C" ]] && age -d -i "$FLYLEAF_ETC/backup.agekey" "$C" | tar -t | sort | paste -sd' ' - | grep -qx 'catalog.dump manifest.txt'; then ok "catalog backup on the remote, encrypted, verified by MD5"; else fail "catalog backup on the remote, encrypted, verified by MD5"; fi
if "$KIT/backup/backup-catalog.sh" "$EXPORT" 2>&1 | grep -q 'already exists'; then ok "backup-catalog.sh is idempotent"; else fail "backup-catalog.sh is idempotent"; fi

# --------------------------------------------------------------------------
section "10. the app role: rows only, no DDL"
as_app_sql() {  # as_app_sql SQL: run as flyleaf_app over TCP, as the API connects
  PGPASSWORD="$APP_DB_PASSWORD" docker exec -e PGPASSWORD flyleaf-pg \
    psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U flyleaf_app -d flyleaf -Atq -c "$1"
}
refused=0
while IFS='|' read -r stmt want; do
  if out="$(as_app_sql "$stmt" 2>&1)"; then fail "flyleaf_app was allowed: $stmt"; fi
  grep -qiE "$want" <<<"$out" || fail "flyleaf_app: '$stmt' failed, but not with /$want/: $out"
  refused=$((refused + 1))
done <<'SQL'
CREATE TABLE public.evil (x int)|permission denied for schema public
CREATE TABLE evil (x int)|permission denied for schema public
DROP TABLE users|must be owner of table users
DROP TABLE works CASCADE|must be owner of table works
ALTER TABLE users ADD COLUMN evil int|must be owner of table users
CREATE INDEX evil_idx ON users (email)|must be owner of table users
TRUNCATE users|permission denied for table users
CREATE SCHEMA evil|permission denied for database flyleaf
DROP SCHEMA public CASCADE|must be owner of schema public
CREATE TEMP TABLE evil (x int)|permission denied to create temporary tables
CREATE DATABASE evil|permission denied to create database
DROP DATABASE flyleaf|must be owner of database flyleaf
CREATE FUNCTION public.evil() RETURNS int LANGUAGE sql AS 'SELECT 1'|permission denied for schema public
CREATE EXTENSION pgcrypto|permission denied
SET ROLE flyleaf_owner|permission denied to set role
ALTER ROLE flyleaf_app SUPERUSER|permission denied to alter role
COPY (SELECT 1) TO PROGRAM 'id'|permission denied to COPY to or from an external program
SELECT * FROM drizzle.__drizzle_migrations|permission denied for schema drizzle
SQL
ok "flyleaf_app refused all $refused: CREATE/DROP/ALTER/TRUNCATE tables, CREATE/DROP schema and database, temp tables, functions, extensions, SET ROLE, COPY TO PROGRAM"
if [[ "$(as_app_sql "SELECT count(*) > 0 FROM users")" == t ]] && as_app_sql "UPDATE users SET email = email WHERE false" >/dev/null; then
  ok "flyleaf_app can read and write rows"; else fail "flyleaf_app cannot use its tables"; fi
if as_app_sql "CREATE TABLE pgboss.probe (x int); DROP TABLE pgboss.probe" >/dev/null 2>&1; then
  ok "flyleaf_app can create in pgboss only (pg-boss manages that schema itself)"; else fail "pgboss schema not usable by flyleaf_app"; fi

# The compiled production start, as the app role.
if (cd "$REPO/apps/api" && DATABASE_URL="$DATABASE_URL" PGBOSS_CREATE_SCHEMA=false npm run --silent start:check) > "$T/startcheck.log" 2>&1; then
  ok "start:check as flyleaf_app: /readyz, worker ready, clean SIGTERM, dev adapters refused"; else cat "$T/startcheck.log"; fail "start:check as flyleaf_app"; fi

# The API's main paths and every job, with API and worker on flyleaf_app.
(cd "$REPO/apps/api" && DATABASE_URL="$MIGRATION_DATABASE_URL" npm run --silent seed -- ../../db/skeleton/books.csv) > "$T/seed.log" 2>&1 \
  || { cat "$T/seed.log"; fail "seed"; }
app_env=(env -u NODE_ENV -u STORAGE_DRIVER -u EMAIL_DRIVER -u PUSH_DRIVER -u S3_ENDPOINT -u HOST -u PORT -u TRUST_PROXY -u APP_BASE_URL
         DATABASE_URL="$DATABASE_URL" PGBOSS_CREATE_SCHEMA=false LOG_LEVEL=warn STORAGE_DISK_DIR="$T/uploads")
(cd "$REPO/apps/api" && exec "${app_env[@]}" node dist/server.js > "$T/api.log" 2>&1) & API_PID=$!
(cd "$REPO/apps/api" && exec "${app_env[@]}" node dist/worker.js > "$T/worker.log" 2>&1) & WORKER_PID=$!
for _ in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:3000/healthz >/dev/null 2>&1 && break; sleep 1; done
path_ok=0
APP_DATABASE_URL="$DATABASE_URL" ADMIN_DATABASE_URL="postgres://flyleaf:$POSTGRES_PASSWORD@127.0.0.1:5432/flyleaf" \
  node "$KIT/test/app-role-path.mjs" > "$T/path.log" 2>&1 && path_ok=1
kill "$API_PID" "$WORKER_PID" 2>/dev/null; wait "$API_PID" "$WORKER_PID" 2>/dev/null || true
if [[ $path_ok == 1 ]]; then ok "$(tail -1 "$T/path.log"): register, reads, review, follow, feed, shelves, upload, import and export through the worker, all 14 jobs"; else cat "$T/path.log"; tail -20 "$T/api.log" "$T/worker.log"; fail "app-role path"; fi
if ! grep -qE "permission denied|42501" "$T/api.log" "$T/worker.log"; then ok "no permission error in the API or worker logs"; else grep -E "permission denied|42501" "$T/api.log" "$T/worker.log" | head; fail "permission errors logged"; fi

printf '\n\033[32m%s checks passed\033[0m\n' "$PASS"
