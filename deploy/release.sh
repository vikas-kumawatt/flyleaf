#!/usr/bin/env bash
# Ships a version of the code (architecture §11: migrate, restart, check
# /readyz, roll back on failure).
#
#   sudo /opt/flyleaf/deploy/release.sh [REF]      default: REPO_REF from flyleaf.env (main)
#   sudo /opt/flyleaf/deploy/release.sh --rollback  back to the release before this one
#   sudo /opt/flyleaf/deploy/release.sh --status
#
# 1. fetch REF and build it in /opt/flyleaf/releases/<commit> (npm ci, the
#    api-client, tsc, then npm prune --omit=dev). An already-built commit is reused.
# 2. run ITS migrations (node dist/migrate.js) as flyleaf_owner while the old
#    code still serves, then re-apply the app role's grants.
# 3. point /opt/flyleaf/current at it, restart the API and the worker.
# 4. wait for /readyz on loopback; if it does not come up, point `current`
#    back, restart, and exit non-zero. Then check https://<host>/readyz
#    through Caddy (warns only: the release itself is fine).
#
# ROLLBACK IS CODE ONLY. Migrations are forward-only (architecture §11 rule
# 5) and are not undone, so the previous release runs against the newer
# schema. Additive migrations, the house style, keep that safe; a release
# whose migration is not backward-compatible says so in its PR.

set -Eeuo pipefail
trap 'echo "release.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"

REPO="$FLYLEAF_HOME/repo"
RELEASES="$FLYLEAF_HOME/releases"
CURRENT="$FLYLEAF_HOME/current"
KEEP_RELEASES=3
has_systemd() { [[ -d /run/systemd/system ]]; }
as_app() { runuser -u flyleaf -- "$@"; }

switch_to() {  # atomic: a new symlink renamed over the old one
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}

restart_and_check() {
  has_systemd || { log "no systemd: not restarting, no health check"; return 0; }
  systemctl restart flyleaf-api flyleaf-worker
  local url="http://127.0.0.1:${PORT}/readyz"
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      sleep 5   # and still up a moment later: a crash loop answers once
      if curl -fsS -m 2 "$url" >/dev/null 2>&1 && systemctl is-active --quiet flyleaf-worker; then
        log "healthy: $url"
        return 0
      fi
    fi
    sleep 1
  done
  log "NOT healthy after 60 s. Last API log lines:"
  journalctl -u flyleaf-api -n 20 --no-pager >&2 || true
  return 1
}

public_check() {
  has_systemd || return 0
  if curl -fsS -m 10 "https://${FLYLEAF_HOST}/readyz" >/dev/null 2>&1; then
    log "healthy through Caddy: https://${FLYLEAF_HOST}/readyz"
  else
    log "WARNING: https://${FLYLEAF_HOST}/readyz fails though the API is up: check Caddy (journalctl -u caddy) and the certificate"
  fi
}

status() {
  echo "current:  $(readlink "$CURRENT" 2>/dev/null || echo none)"
  echo "previous: $(cat "$FLYLEAF_STATE/previous-release" 2>/dev/null || echo none)"
  echo "built:"; find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' 2>/dev/null
  if has_systemd; then systemctl --no-pager --lines=0 status flyleaf-api flyleaf-worker || true; fi
}

rollback() {
  local prev; prev="$(cat "$FLYLEAF_STATE/previous-release" 2>/dev/null || true)"
  [[ -n "$prev" && -d "$prev" ]] || die "no previous release recorded"
  local now; now="$(readlink "$CURRENT")"
  log "rolling back: $(basename "$now") -> $(basename "$prev") (code only; migrations stay)"
  switch_to "$prev"
  echo "$now" > "$FLYLEAF_STATE/previous-release"
  restart_and_check || die "the previous release is not healthy either; see journalctl -u flyleaf-api"
  public_check
}

build() {  # build <commit> <dir>
  local sha="$1" dir="$2"
  rm -rf "$dir"
  install -d -o flyleaf -g flyleaf "$dir"
  as_app git -C "$REPO" archive "$sha" | as_app tar -x -C "$dir"
  echo "$sha" | as_app tee "$dir/REVISION" >/dev/null
  log "building $sha (npm ci, api-client, tsc)"
  (
    cd "$dir/apps/api"
    # --include=dev: this shell has the app environment, and with
    # NODE_ENV=production npm ci would leave out TypeScript itself.
    as_app npm ci --include=dev --no-audit --no-fund --no-update-notifier --loglevel=error
    # The same first step as scripts/ci.mjs: the API's tests import the
    # client's build, and tsc compiles them with everything else.
    as_app npm exec --offline -- tsc -p ../../packages/api-client/tsconfig.json
    as_app npm run build --silent
    as_app npm prune --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
  )
  as_app touch "$dir/.built"
}

release() {
  local ref="${1:-$REPO_REF}"
  if [[ ! -d "$REPO/.git" ]]; then
    log "cloning $REPO_URL"
    as_app git clone --quiet --no-checkout "$REPO_URL" "$REPO"
  fi
  as_app git -C "$REPO" fetch --quiet --prune --tags origin
  local sha
  sha="$(as_app git -C "$REPO" rev-parse --verify --quiet "origin/$ref^{commit}" \
        || as_app git -C "$REPO" rev-parse --verify --quiet "$ref^{commit}")" \
    || die "no such branch, tag or commit: $ref"
  local dir="$RELEASES/$sha"
  local prev; prev="$(readlink "$CURRENT" 2>/dev/null || true)"
  if [[ "$prev" == "$dir" ]]; then
    log "$sha is already the current release; nothing to do (systemctl restart flyleaf-api to restart)"
    return 0
  fi
  if [[ -f "$dir/.built" ]]; then log "reusing the build of $sha"; else build "$sha" "$dir"; fi

  log "migrating with $sha (as flyleaf_owner)"
  RELEASE_DIR="$dir" run_migrations

  switch_to "$dir"
  [[ -n "$prev" ]] && echo "$prev" > "$FLYLEAF_STATE/previous-release"
  if ! restart_and_check; then
    if [[ -n "$prev" && -d "$prev" ]]; then
      log "rolling back to $(basename "$prev")"
      switch_to "$prev"
      echo "$dir" > "$FLYLEAF_STATE/previous-release"
      restart_and_check || log "the previous release is not healthy either"
    fi
    die "release $sha failed its health check (migrations, if any, stay applied)"
  fi
  public_check

  # Keep the current, the previous, and the newest few others.
  local keep_prev; keep_prev="$(cat "$FLYLEAF_STATE/previous-release" 2>/dev/null || true)"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- \
    | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
    [[ "$old" == "$dir" || "$old" == "$keep_prev" ]] && continue
    rm -rf "$old"
    log "removed old build $(basename "$old")"
  done
  log "released $sha"
}

require_root
load_app_env
install -d -m 700 "$FLYLEAF_STATE"
exec 9> "$FLYLEAF_STATE/release.lock"
flock -n 9 || die "another release is running"
case "${1:-}" in
  --rollback) rollback ;;
  --status) status ;;
  -*) die "usage: $0 [REF | --rollback | --status]" ;;
  *) release "${1:-}" ;;
esac
