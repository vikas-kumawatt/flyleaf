#!/usr/bin/env bash
# The one thing GitHub's deploy key can do (docs/deploy.md › Automatic
# deploys). Two modes:
#
#   As the forced command of flyleaf-ci's key (sshd runs it, whatever the
#   client asked for): reads SSH_ORIGINAL_COMMAND and accepts only
#     release <40-hex commit>   ->  sudo release.sh <commit>
#     status                    ->  sudo release.sh --status
#   Anything else is refused. sudoers allows the same two and nothing more.
#
#   sudo /opt/flyleaf/deploy/ci-deploy.sh --install 'ssh-ed25519 AAAA… flyleaf-ci'
#     (root, once) makes that public key flyleaf-ci's only key, pinned to
#     this script with `restrict` (no shell, no pty, no forwarding).
#
# The private half lives only in the GitHub secret FLYLEAF_DEPLOY_SSH_KEY.

set -Eeuo pipefail
CI_USER=flyleaf-ci
RELEASE=/opt/flyleaf/deploy/release.sh
SELF=/opt/flyleaf/deploy/ci-deploy.sh

die() { printf 'ci-deploy: %s\n' "$*" >&2; exit 2; }

install_key() {
  [[ $EUID -eq 0 ]] || die "run as root: sudo $0 --install '<public key>'"
  local key="$1"
  [[ "$key" != *$'\n'* ]] || die "one key, one line"
  [[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^\"]*)?$ ]] || die "expected an ssh-ed25519 public key"
  ssh-keygen -l -f - <<<"$key" >/dev/null 2>&1 || die "ssh-keygen does not read that as a public key"
  id "$CI_USER" >/dev/null 2>&1 || die "no user $CI_USER: run sudo /opt/flyleaf/deploy/provision.sh first"
  local home; home="$(getent passwd "$CI_USER" | cut -d: -f6)"
  install -d -m 700 -o "$CI_USER" -g "$CI_USER" "$home/.ssh"
  printf 'restrict,command="%s" %s\n' "$SELF" "$key" \
    | install -m 600 -o "$CI_USER" -g "$CI_USER" /dev/stdin "$home/.ssh/authorized_keys"
  printf 'ci-deploy: installed %s\n' "$(ssh-keygen -l -f - <<<"$key")" >&2
}

if [[ "${1:-}" == --install ]]; then
  install_key "${2:-}"
  exit 0
fi

cmd="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$cmd" =~ ^release\ ([0-9a-f]{40})$ ]]; then
  exec sudo -n "$RELEASE" "${BASH_REMATCH[1]}"
elif [[ "$cmd" == status ]]; then
  exec sudo -n "$RELEASE" --status
fi
die "refused: '${cmd:0:80}' (allowed: 'release <40-hex commit>' or 'status')"
