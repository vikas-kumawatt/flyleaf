#!/usr/bin/env bash
# Creates /etc/flyleaf/flyleaf.env from deploy/env.production.example, and
# renders it into /etc/flyleaf/app.env.
#
#   sudo deploy/configure-env.sh                    ask for each value (input hidden for secrets)
#   sudo deploy/configure-env.sh --answers FILE     read them from FILE (must be mode 600)
#   sudo deploy/configure-env.sh --render           only re-render app.env (provision.sh does this)
#
# Generated here, never typed: JWT_SECRET, the three database passwords,
# MINIO_ROOT_PASSWORD, the bucket-scoped S3 key pair, and the backup
# encryption key pair (/etc/flyleaf/backup.agekey).
#
# Asked for (or read from the answers file, one KEY=value per line, no quotes):
#   FLYLEAF_HOST         e.g. flyleaf-abc.centralindia.cloudapp.azure.com
#   OWNER_EMAIL          gets backup failures and drill reports
#   GMAIL_ADDRESS        the Gmail account that sends the app's mail
#   GMAIL_APP_PASSWORD   its 16-letter app password (spaces are removed)
#   EXPO_ACCESS_TOKEN    optional; empty unless the Expo project enforces it
#
# Idempotent: an existing flyleaf.env keeps every value it already has. Only
# lines still holding a <placeholder> are filled. Nothing secret is printed.

set -Eeuo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"

TEMPLATE="$DEPLOY_DIR/env.production.example"
AGE_KEY="$FLYLEAF_ETC/backup.agekey"

# KEY='value' replacing the line that assigns KEY. The value travels through
# the environment, so no character in it is ever interpreted by awk or sed.
set_var() {
  local file="$1" key="$2" value="$3"
  [[ "$value" != *"'"* && "$value" != *$'\n'* ]] || die "$key: a value may not contain a single quote or a newline"
  grep -q "^${key}=" "$file" || die "$key is not in $file"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
    index($0, k "=") == 1 { print k "='\''" v "'\''"; next }
    { print }
  ' "$file" > "$file.tmp"
  chmod 600 "$file.tmp"
  mv -f "$file.tmp" "$file"
}

# True if KEY's line still holds a <placeholder> (angle brackets, no @:
# 'Flyleaf <me@gmail.com>' is a finished EMAIL_FROM).
is_placeholder() {
  grep -qE "^$2=.*<[^>@]*>" "$1"
}

# Answers file: KEY=value lines, read without executing anything.
declare -A ANSWERS=()
read_answers() {
  local file="$1" line key
  require_private_file "$file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "answers file: bad line (not KEY=value)"
    ANSWERS[$key]="${line#*=}"
  done < "$file"
}

# ask KEY "prompt" secret|plain [optional]
ask() {
  local key="$1" prompt="$2" kind="$3" optional="${4:-}" value=""
  if [[ -v "ANSWERS[$key]" ]]; then
    printf '%s' "${ANSWERS[$key]}"
    return
  fi
  [[ -t 0 ]] || die "$key is needed and there is no terminal to ask on (use --answers FILE)"
  while :; do
    if [[ "$kind" == secret ]]; then
      read -r -s -p "$prompt: " value; echo >&2
    else
      read -r -p "$prompt: " value
    fi
    [[ -n "$value" || -n "$optional" ]] && break
    echo "  required" >&2
  done
  printf '%s' "$value"
}

valid_host() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; }
valid_email() { [[ "$1" =~ ^[^@[:space:]\']+@[^@[:space:]\']+\.[^@[:space:]\']+$ ]]; }
urlencode_user() { local s="$1"; s="${s//%/%25}"; s="${s//@/%40}"; s="${s//:/%3A}"; s="${s//+/%2B}"; printf '%s' "$s"; }

create_or_fill() {
  local env="$FLYLEAF_ENV_FILE"
  install -d -m 700 "$FLYLEAF_ETC"
  if [[ ! -f "$env" ]]; then
    install -m 600 "$TEMPLATE" "$env"
    log "created $env from the template"
  fi
  require_private_file "$env"

  # Generated secrets: hex where they end up inside a URL.
  is_placeholder "$env" JWT_SECRET && set_var "$env" JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  is_placeholder "$env" POSTGRES_PASSWORD && set_var "$env" POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  is_placeholder "$env" OWNER_DB_PASSWORD && set_var "$env" OWNER_DB_PASSWORD "$(openssl rand -hex 24)"
  is_placeholder "$env" APP_DB_PASSWORD && set_var "$env" APP_DB_PASSWORD "$(openssl rand -hex 24)"
  is_placeholder "$env" MINIO_ROOT_PASSWORD && set_var "$env" MINIO_ROOT_PASSWORD "$(openssl rand -hex 24)"
  is_placeholder "$env" S3_ACCESS_KEY_ID && set_var "$env" S3_ACCESS_KEY_ID "flyleaf-app-$(openssl rand -hex 4)"
  is_placeholder "$env" S3_SECRET_ACCESS_KEY && set_var "$env" S3_SECRET_ACCESS_KEY "$(openssl rand -hex 20)"

  # This runs before provision.sh (docs/deploy.md step 3b), which is what
  # otherwise installs age, and a fresh Ubuntu image does not have it.
  if ! command -v age-keygen >/dev/null; then
    log "installing age (for the backup key)"
    DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends age >/dev/null
  fi
  if [[ ! -f "$AGE_KEY" ]]; then
    (umask 077 && age-keygen -o "$AGE_KEY" 2>/dev/null)
    log "created the backup key $AGE_KEY -- copy it OFF this machine (docs/deploy.md step 9)"
  fi
  if is_placeholder "$env" BACKUP_AGE_RECIPIENT; then
    set_var "$env" BACKUP_AGE_RECIPIENT "$(age-keygen -y "$AGE_KEY")"
  fi

  local v
  if is_placeholder "$env" FLYLEAF_HOST; then
    v="$(ask FLYLEAF_HOST 'Host name (e.g. flyleaf-abc.centralindia.cloudapp.azure.com)' plain)"
    v="${v,,}"
    valid_host "$v" || die "FLYLEAF_HOST: not a host name: $v"
    set_var "$env" FLYLEAF_HOST "$v"
  fi
  if is_placeholder "$env" OWNER_EMAIL; then
    v="$(ask OWNER_EMAIL 'Your email (backup failures go here)' plain)"
    valid_email "$v" || die "OWNER_EMAIL: not an email address"
    set_var "$env" OWNER_EMAIL "$v"
  fi
  if is_placeholder "$env" SMTP_URL; then
    local gmail pass
    gmail="$(ask GMAIL_ADDRESS 'Gmail address that sends the mail' plain)"
    valid_email "$gmail" || die "GMAIL_ADDRESS: not an email address"
    pass="$(ask GMAIL_APP_PASSWORD 'Gmail app password (16 letters; input hidden)' secret)"
    pass="${pass// /}"
    [[ "$pass" =~ ^[A-Za-z]{16}$ ]] || die "GMAIL_APP_PASSWORD: expected 16 letters (spaces ignored)"
    set_var "$env" SMTP_URL "smtps://$(urlencode_user "$gmail"):${pass}@smtp.gmail.com:465"
    set_var "$env" EMAIL_FROM "Flyleaf <${gmail}>"
  fi
  if [[ -v "ANSWERS[EXPO_ACCESS_TOKEN]" ]] || { [[ -t 0 ]] && grep -q "^EXPO_ACCESS_TOKEN=''" "$env" && [[ ! -f "$FLYLEAF_STATE/expo-asked" ]]; }; then
    v="$(ask EXPO_ACCESS_TOKEN 'Expo access token (Enter to leave empty; input hidden)' secret optional)"
    set_var "$env" EXPO_ACCESS_TOKEN "$v"
    install -d -m 700 "$FLYLEAF_STATE" && touch "$FLYLEAF_STATE/expo-asked"
  fi

  local left
  left="$(grep -oE '^[A-Z_][A-Z0-9_]*=.*<[^>@]*>' "$env" | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -z "$left" ]] || die "still placeholders in $env: $left"
  log "$env is complete"
}

# flyleaf.env (bash, may reference other values) -> app.env (every value
# literal). Run in a clean subshell so nothing from this shell leaks in.
render() {
  local env="$FLYLEAF_ENV_FILE" out="$FLYLEAF_APP_ENV"
  require_private_file "$env"
  local keys
  keys="$(grep -oE '^[A-Z_][A-Z0-9_]*=' "$env" | tr -d '=' | sort -u)"
  local content
  # shellcheck disable=SC2086  # one argument per key, on purpose
  content="$(env -i PATH="$PATH" bash "$DEPLOY_DIR/lib/render-env.sh" "$env" $keys)" || die "could not render $out from $env"
  # Only a complete render replaces the old file.
  printf '%s\n' "$content" | write_private "$out"
  log "rendered $out"
}

case "${1:-}" in
  --render) render ;;
  --answers) [[ -n "${2:-}" ]] || die "--answers needs a file"; read_answers "$2"; create_or_fill; render ;;
  "") create_or_fill; render ;;
  *) die "usage: $0 [--answers FILE | --render]" ;;
esac
