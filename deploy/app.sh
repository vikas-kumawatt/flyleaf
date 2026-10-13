#!/usr/bin/env bash
# Runs one of the app's own commands on the server: as user flyleaf, in the
# current release, with the production environment -- exactly what the
# systemd units get.
#
#   sudo /opt/flyleaf/deploy/app.sh admin create --email ops@example.com --role admin
#   sudo /opt/flyleaf/deploy/app.sh admin disable --email ops@example.com
#   sudo /opt/flyleaf/deploy/app.sh migrate     as flyleaf_owner (release.sh already does this)
#   sudo /opt/flyleaf/deploy/app.sh ping        enqueue smoke.ping; the worker log shows it handled
#   sudo /opt/flyleaf/deploy/app.sh dedupe      enqueue a dedupe pass now
#
# Deliberately no SQL shell: architecture §11 rule 4, no ad-hoc SQL against
# production. A fix that needs raw SQL is a missing admin feature.

set -Eeuo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
require_root

cmd="${1:-}"; shift || true
case "$cmd" in
  admin) run_as_app /usr/local/bin/node dist/admin-cli.js "$@" ;;
  migrate) run_migrations ;;
  ping) run_as_app /usr/local/bin/node dist/worker.js --ping ;;
  dedupe) run_as_app /usr/local/bin/node dist/worker.js --dedupe ;;
  *) die "usage: $0 admin <create|disable> ... | migrate | ping | dedupe" ;;
esac
