#!/usr/bin/env bash
# Creates or updates the database roles (deploy/db/roles.sql): flyleaf_owner
# owns the schema and runs migrations, flyleaf_app is what the API and the
# worker connect as. Idempotent. provision.sh, release.sh and the restore
# scripts run it; by hand:
#
#   sudo /opt/flyleaf/deploy/db-roles.sh
#
# The passwords come from /etc/flyleaf/app.env and reach psql on stdin, never
# as arguments (visible in `ps`).

set -Eeuo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
apply_db_roles
log "database roles applied: flyleaf_owner (schema, migrations), flyleaf_app (API, worker)"
