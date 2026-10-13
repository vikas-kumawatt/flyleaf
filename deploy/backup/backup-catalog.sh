#!/usr/bin/env bash
# The catalog's one off-site backup. The catalog is reproducible (the laptop
# keeps its database, and Open Library's dumps can be re-ingested), so it is
# copied once, not every 6 hours; the rows this server adds to it later ride
# along in every backup.sh run as the catalog delta.
#
#   sudo /opt/flyleaf/deploy/backup/backup-catalog.sh /srv/flyleaf/import/flyleaf-catalog-<stamp>
#
# Encrypts the directory restore-catalog.sh used (catalog.dump + manifest.txt)
# to the same age key as the other backups and STREAMS it to
# $BACKUP_REMOTE/catalog/: no second copy on this disk. Checks first that
# Google Drive has room, and afterwards that what arrived is byte-identical
# (MD5, which Drive computes itself). Run again for a new catalog dump.

set -Eeuo pipefail
trap 'echo "backup-catalog.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
load_app_env

DIR="${1:?usage: $0 <catalog directory with catalog.dump and manifest.txt>}"
[[ -r "$DIR/catalog.dump" && -r "$DIR/manifest.txt" ]] || die "$DIR needs catalog.dump and manifest.txt"
created="$(awk '$1 == "created_at" { print $2 }' "$DIR/manifest.txt" | tr -d ':-')"
NAME="flyleaf-catalog-${created:-unknown}.tar.age"
DEST="$BACKUP_REMOTE/catalog/$NAME"

size="$(du -cb "$DIR/catalog.dump" "$DIR/manifest.txt" | tail -1 | cut -f1)"
free="$(rclone about "${BACKUP_REMOTE%%:*}:" --json 2>/dev/null | sed -n 's/.*"free":[[:space:]]*\([0-9]*\).*/\1/p')"
if [[ -n "$free" ]]; then
  log "catalog: $size bytes; free on the remote: $free bytes"
  ((free > size + size / 10)) || die "not enough room on ${BACKUP_REMOTE%%:*}: for the catalog (need ~$size bytes, $free free). See docs/deploy.md, \"Backups\"."
else
  log "the remote does not report free space; continuing"
fi

if rclone lsf "$BACKUP_REMOTE/catalog/" 2>/dev/null | grep -qx "$NAME"; then
  log "$DEST already exists; nothing to do"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkfifo "$tmp/stream"
md5sum < "$tmp/stream" | cut -d' ' -f1 > "$tmp/md5" &
md5_pid=$!
log "encrypting and uploading to $DEST"
tar -C "$DIR" -cf - catalog.dump manifest.txt \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  | tee "$tmp/stream" \
  | rclone rcat "$DEST"
wait "$md5_pid"
local_md5="$(cat "$tmp/md5")"
remote_md5="$(rclone md5sum "$DEST" 2>/dev/null | cut -d' ' -f1)"
if [[ -z "$remote_md5" ]]; then
  log "the remote reports no MD5; checked the size only"
  [[ "$(rclone size --json "$DEST" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')" -gt 0 ]] || die "upload is empty"
elif [[ "$remote_md5" != "$local_md5" ]]; then
  die "uploaded file differs (md5 $remote_md5, sent $local_md5)"
fi
install -d -m 700 "$FLYLEAF_STATE"
echo "CATALOG_BACKUP='$DEST'" | write_private "$FLYLEAF_STATE/catalog-backup.env"
log "catalog backed up: $DEST (md5 $local_md5)"
