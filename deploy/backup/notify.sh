#!/usr/bin/env bash
# Mails OWNER_EMAIL through the app's own SMTP_URL (Gmail), with curl: no
# mail server on this machine, and nothing that depends on the app's build
# working -- a broken release must not also silence the backup alarm.
#
#   notify.sh failure <unit>          "<unit> FAILED" with the end of its journal
#   notify.sh send <subject> < body   any message
#
# The SMTP password never appears on a command line (visible in `ps`): curl
# reads it from a config file in a private temporary directory.

set -Eeuo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
load_app_env

# %XX -> byte. Backslashes are doubled first so printf %b decodes only the
# %XX escapes and nothing the value happened to contain.
urldecode() { local s="${1//\\/\\\\}"; printf '%b' "${s//%/\\x}"; }

send_mail() {
  local subject="$1" body="$2"
  [[ "$SMTP_URL" =~ ^(smtps?)://([^:@/]+):([^@/]+)@([^:/]+)(:([0-9]+))?/?$ ]] \
    || die "SMTP_URL is not smtp(s)://user:password@host[:port]"
  local scheme="${BASH_REMATCH[1]}" user pass host="${BASH_REMATCH[4]}" port="${BASH_REMATCH[6]}"
  user="$(urldecode "${BASH_REMATCH[2]}")"
  pass="$(urldecode "${BASH_REMATCH[3]}")"
  if [[ -z "$port" ]]; then if [[ "$scheme" == smtps ]]; then port=465; else port=587; fi; fi
  local from_addr="$EMAIL_FROM"
  [[ "$EMAIL_FROM" =~ \<([^\>]+)\> ]] && from_addr="${BASH_REMATCH[1]}"

  local tmp; tmp="$(mktemp -d)"; chmod 700 "$tmp"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  # curl config syntax: a quoted value, with \ and " escaped.
  local esc="${user}:${pass}"; esc="${esc//\\/\\\\}"; esc="${esc//\"/\\\"}"
  printf 'user = "%s"\n' "$esc" > "$tmp/curl.conf"
  {
    printf 'From: %s\r\n' "$EMAIL_FROM"
    printf 'To: %s\r\n' "$OWNER_EMAIL"
    printf 'Subject: %s\r\n' "$subject"
    printf 'Date: %s\r\n' "$(date -R)"
    printf 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
    printf '%s\n' "$body" | sed 's/$/\r/'
  } > "$tmp/message"
  local tls=(--ssl-reqd)
  # Plain smtp:// upgrades with STARTTLS when offered (port 587). Only a
  # loopback test server may skip TLS.
  [[ "$scheme" == smtp && "$host" == 127.0.0.1 ]] && tls=()
  curl --silent --show-error --max-time 60 "${tls[@]}" \
    --url "$scheme://$host:$port" -K "$tmp/curl.conf" \
    --mail-from "$from_addr" --mail-rcpt "$OWNER_EMAIL" \
    --upload-file "$tmp/message"
}

case "${1:-}" in
  failure)
    unit="${2:?unit name}"
    body="$(printf 'The unit %s failed on %s at %s UTC.\n\nLast 60 log lines:\n\n' \
      "$unit" "$FLYLEAF_HOST" "$(date -u '+%Y-%m-%d %H:%M')"
      journalctl -u "$unit" -n 60 --no-pager 2>&1 || true
      printf '\nSee docs/deploy.md, "When a backup fails".\n')"
    send_mail "[Flyleaf] FAILED: $unit on $FLYLEAF_HOST" "$body"
    log "mailed $OWNER_EMAIL: $unit failed"
    ;;
  send)
    subject="${2:?subject}"
    send_mail "$subject" "$(cat)"
    log "mailed $OWNER_EMAIL: $subject"
    ;;
  *) die "usage: $0 failure <unit> | send <subject> < body" ;;
esac
