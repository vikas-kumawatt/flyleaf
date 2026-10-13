#!/usr/bin/env bash
# Provision (or re-provision) the Flyleaf server. Idempotent: every step checks
# before it changes anything, so running it again is how you apply a change to
# /etc/flyleaf/flyleaf.env (a new host name, a new image tag) or pick up a
# newer Node 22.x.
#
#   sudo bash deploy/provision.sh            from a copy of this repo's deploy/ folder
#   sudo /opt/flyleaf/deploy/provision.sh    later runs (it installs itself there)
#
# What it sets up, in order (docs/deploy.md has the why):
#   swap  apt  upgrades  docker  caddy  node  user  kit  env  hosts  ssh
#   firewall  journald  services  dbroles  storage  proxy  units  deploykey
#
# PROVISION_SKIP=step,step skips steps by name. It exists so deploy/test/ can
# run this in a container without systemd or a kernel firewall; on a real
# server leave it unset. Skipped steps are announced, never silent.
#
# Ubuntu 24.04, run as root. Needs outbound HTTPS to the Ubuntu archive,
# download.docker.com, dl.cloudsmith.io (Caddy), nodejs.org and github.com.

set -Eeuo pipefail
trap 'echo "provision.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"

: "${SWAP_SIZE:=2G}"
: "${PROVISION_SKIP:=}"
# Caddy from Ubuntu's own archive (an older 2.x) instead of Caddy's apt repo.
# For sandboxes that cannot reach dl.cloudsmith.io; the real server uses the repo.
: "${CADDY_FROM_UBUNTU:=0}"
COMPOSE_DIR="$FLYLEAF_HOME/compose"
APP_USER=flyleaf

# GitHub's published SSH host key fingerprint (docs.github.com, "GitHub's SSH
# key fingerprints"). The deploy key's known_hosts entry is checked against it
# rather than trusted on first use.
GITHUB_ED25519_FP='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'

has_systemd() { [[ -d /run/systemd/system ]]; }

step() {
  local name="$1"
  if [[ ",$PROVISION_SKIP," == *",$name,"* ]]; then
    log "== $name: SKIPPED (PROVISION_SKIP)"
    return 0
  fi
  log "== $name"
  "step_$name"
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@" >/dev/null
}

# Writes stdin to $1 only if it differs; returns 0 if the file changed.
install_if_changed() {
  local dest="$1" mode="${2:-644}" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    return 1
  fi
  install -D -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
  return 0
}

# --------------------------------------------------------------------------
step_swap() {
  # 4 GB of RAM runs Postgres, MinIO, the API, the worker, Caddy and an
  # occasional `npm ci` + tsc build. Swap is the margin that turns a memory
  # spike into slowness instead of the kernel OOM killer picking a process.
  if swapon --show=NAME --noheadings | grep -qx /swapfile; then
    log "swap: /swapfile already active"
  else
    if [[ ! -f /swapfile ]]; then
      fallocate -l "$SWAP_SIZE" /swapfile
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile || log "swap: swapon failed (containers cannot swap); the fstab entry still applies at boot"
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer dropping page cache over swapping out the API.
  if install_if_changed /etc/sysctl.d/99-flyleaf.conf <<'EOF'
vm.swappiness = 10
EOF
  then sysctl -q -p /etc/sysctl.d/99-flyleaf.conf || true
  fi
}

step_apt() {
  apt-get update -q >/dev/null
  apt_install ca-certificates curl gnupg git openssl xz-utils zstd age rclone \
    ufw unattended-upgrades apt-listchanges cron
}

step_upgrades() {
  # Security updates install themselves daily. A kernel or libc update needs a
  # reboot, done at 21:30 UTC (03:00 IST), after the 18:00 backup and away
  # from the 03:00-04:30 UTC nightly jobs. Postgres and MinIO come back with
  # Docker (restart: unless-stopped), the API and worker with systemd.
  install_if_changed /etc/apt/apt.conf.d/20auto-upgrades <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  install_if_changed /etc/apt/apt.conf.d/52flyleaf-unattended-upgrades <<'EOF' || true
// Flyleaf (deploy/provision.sh). The distro's 50unattended-upgrades already
// limits upgrades to the -security pocket; this adds the reboot policy.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "21:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
  if has_systemd; then
    systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
  fi
}

step_docker() {
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    local codename; codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q >/dev/null
    apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  # Container logs rotate; the default json-file driver grows without limit.
  if install_if_changed /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
  then
    if has_systemd; then systemctl restart docker; fi
  fi
  if has_systemd; then systemctl enable --now docker >/dev/null 2>&1; fi
}

step_caddy() {
  if command -v caddy >/dev/null; then
    log "caddy: $(caddy version | head -1)"
    return 0
  fi
  if [[ "$CADDY_FROM_UBUNTU" == 1 ]]; then
    apt_install caddy
  else
    apt_install debian-keyring debian-archive-keyring apt-transport-https
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q >/dev/null
    apt_install caddy
  fi
}

step_node() {
  # The official tarball, checked against nodejs.org's SHASUMS256.txt. The
  # newest release of NODE_MAJOR is installed when it is newer than what is
  # here, so re-running provision.sh is also how Node gets its patches.
  local major="${NODE_MAJOR:-22}" arch base latest current
  [[ -r "$FLYLEAF_ENV_FILE" ]] && major="$(sed -n "s/^NODE_MAJOR='\([0-9]*\)'.*/\1/p" "$FLYLEAF_ENV_FILE" | head -1)"
  major="${major:-22}"
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "node: unsupported architecture $(uname -m)" ;;
  esac
  base="https://nodejs.org/dist/latest-v${major}.x"
  local sums; sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  latest="$(grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.xz" <<<"$sums" | head -1)"
  [[ -n "$latest" ]] || die "node: no linux-$arch tarball listed at $base"
  current="$(/usr/local/bin/node -v 2>/dev/null || true)"
  if [[ "node-${current}-linux-${arch}.tar.xz" == "$latest" ]]; then
    log "node: $current is the newest $major.x"
    return 0
  fi
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$base/$latest" -o "$tmp/$latest"
  (cd "$tmp" && grep " $latest\$" <<<"$sums" | sha256sum -c --quiet -) || die "node: checksum mismatch for $latest"
  local dir="/usr/local/lib/nodejs/${latest%.tar.xz}"
  install -d /usr/local/lib/nodejs
  rm -rf "$dir"
  tar -xJf "$tmp/$latest" -C /usr/local/lib/nodejs
  rm -rf "$tmp"
  for bin in node npm npx; do ln -sfn "$dir/bin/$bin" "/usr/local/bin/$bin"; done
  log "node: installed $(/usr/local/bin/node -v) (was ${current:-none})"
  # A running API keeps the old binary until restarted.
  if has_systemd && systemctl is-active --quiet flyleaf-api; then
    systemctl restart flyleaf-api flyleaf-worker
  fi
}

step_user() {
  id "$APP_USER" >/dev/null 2>&1 \
    || useradd --system --home-dir "$FLYLEAF_HOME" --shell /usr/sbin/nologin "$APP_USER"
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$FLYLEAF_HOME" "$FLYLEAF_HOME/releases"
  install -d -m 700 "$FLYLEAF_ETC" "$FLYLEAF_STATE"
  # Postgres and MinIO data: bind mounts on the OS disk, outside Docker's own
  # directory, so `docker system prune` can never take them.
  install -d -m 700 "$FLYLEAF_DATA" "$FLYLEAF_DATA/postgres" "$FLYLEAF_DATA/minio"
  # The admin who runs sudo owns the import folder, so the catalog dump can
  # be scp'd straight into it (docs/deploy.md step 6).
  install -d -m 755 -o "${SUDO_USER:-root}" "$IMPORT_DIR"
  install -d -m 700 "$BACKUP_DIR" "$BACKUP_DIR/work" "$BACKUP_DIR/local"
}

step_kit() {
  # The timers run the copy in /opt/flyleaf/deploy, so a release (which
  # swaps /opt/flyleaf/current) never changes the backup scripts mid-run.
  local dest="$FLYLEAF_HOME/deploy"
  if [[ "$DEPLOY_DIR" != "$dest" ]]; then
    rm -rf "$dest.new"
    cp -a "$DEPLOY_DIR" "$dest.new"
    rm -rf "$dest"
    mv "$dest.new" "$dest"
  fi
  chown -R root:root "$dest"
  chmod -R go-w "$dest"
  find "$dest" -name '*.sh' -exec chmod 755 {} +
}

step_env() {
  if [[ ! -f "$FLYLEAF_ENV_FILE" ]]; then
    [[ -t 0 ]] || die "$FLYLEAF_ENV_FILE is missing. Run: sudo $DEPLOY_DIR/configure-env.sh"
    bash "$DEPLOY_DIR/configure-env.sh"
  fi
  require_private_file "$FLYLEAF_ENV_FILE"
  bash "$DEPLOY_DIR/configure-env.sh" --render
}

step_hosts() {
  # The API reaches MinIO at S3_ENDPOINT (https://<host>), which must stay the
  # public name because presigned URLs are signed for it. This sends the
  # API's own requests to Caddy on loopback instead of out through Azure's
  # public IP and back.
  load_app_env
  local tmp; tmp="$(mktemp)"
  grep -v '# flyleaf-managed$' /etc/hosts > "$tmp" || true
  printf '127.0.0.1 %s # flyleaf-managed\n' "$FLYLEAF_HOST" >> "$tmp"
  if ! cmp -s "$tmp" /etc/hosts; then cat "$tmp" > /etc/hosts; fi
  rm -f "$tmp"
}

step_ssh() {
  # Keys only. Azure's `vm create --generate-ssh-keys` already disables
  # passwords; this keeps it that way whatever the image ships.
  if install_if_changed /etc/ssh/sshd_config.d/60-flyleaf.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  then
    if sshd -t; then
      if has_systemd; then systemctl reload ssh 2>/dev/null || systemctl reload sshd; fi
    else
      rm -f /etc/ssh/sshd_config.d/60-flyleaf.conf
      die "sshd rejected the config; removed it and left SSH as it was"
    fi
  fi
}

step_firewall() {
  # 22, 80, 443 in; everything out. Postgres and MinIO publish on 127.0.0.1
  # only, which matters because Docker's published ports bypass UFW.
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status verbose | sed 's/^/  /' >&2
}

step_journald() {
  if install_if_changed /etc/systemd/journald.conf.d/60-flyleaf.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
  then
    if has_systemd; then systemctl restart systemd-journald; fi
  fi
}

compose() {
  docker compose -p flyleaf -f "$COMPOSE_DIR/compose.yml" --env-file "$FLYLEAF_APP_ENV" "$@"
}

step_services() {
  install -d -m 755 "$COMPOSE_DIR"
  install -m 644 "$DEPLOY_DIR/compose.production.yml" "$COMPOSE_DIR/compose.yml"
  # --wait: until both health checks pass. A changed image tag or setting
  # recreates the container; the data is in the bind mounts.
  compose up -d --wait --remove-orphans
}

step_dbroles() {
  # flyleaf_owner owns the schema and runs migrations; flyleaf_app (the API
  # and worker) reads and writes rows only. deploy/db/roles.sql has the why.
  apply_db_roles
  log "dbroles: flyleaf_owner (schema, migrations), flyleaf_app (API, worker: rows only)"
}

step_storage() {
  load_app_env
  # The bucket, and a key that can touch nothing else. mc ships in the image.
  docker exec -i flyleaf-minio sh -c 'cat > /tmp/flyleaf-app-policy.json' <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetBucketLocation",
               "s3:ListBucket", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
    "Resource": ["arn:aws:s3:::${S3_BUCKET}", "arn:aws:s3:::${S3_BUCKET}/*"]
  }]
}
EOF
  # Values pass through the environment (`-e NAME` with no value), never as
  # arguments: arguments are visible to every user in `ps`.
  MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000" \
  BUCKET="$S3_BUCKET" KEY="$S3_ACCESS_KEY_ID" SECRET="$S3_SECRET_ACCESS_KEY" \
  docker exec -i -e MC_HOST_local -e BUCKET -e KEY -e SECRET \
    flyleaf-minio sh -eu -c '
      mc mb --ignore-existing "local/$BUCKET" >/dev/null
      mc admin user add local "$KEY" "$SECRET" >/dev/null
      mc admin policy create local flyleaf-app /tmp/flyleaf-app-policy.json >/dev/null
      mc admin policy attach local flyleaf-app --user "$KEY" >/dev/null 2>&1 || true
      rm -f /tmp/flyleaf-app-policy.json'
  log "storage: bucket $S3_BUCKET, key $S3_ACCESS_KEY_ID limited to it"
}

render_caddyfile() {
  load_app_env
  sed -e "s|@FLYLEAF_HOST@|$FLYLEAF_HOST|g" \
      -e "s|@OWNER_EMAIL@|$OWNER_EMAIL|g" \
      -e "s|@S3_BUCKET@|$S3_BUCKET|g" \
      -e "s|@PORT@|$PORT|g" \
      "$DEPLOY_DIR/Caddyfile.template"
}

step_proxy() {
  if render_caddyfile | install_if_changed /etc/caddy/Caddyfile 644; then
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
      || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; die "Caddyfile invalid"; }
    if has_systemd; then systemctl reload-or-restart caddy; fi
  fi
  if has_systemd; then systemctl enable --now caddy >/dev/null 2>&1; fi
}

step_units() {
  local unit changed=0
  for unit in "$DEPLOY_DIR"/systemd/*; do
    # shellcheck disable=SC2094  # reads $unit, writes /etc/systemd/system/<name>
    install_if_changed "/etc/systemd/system/$(basename "$unit")" 644 < "$unit" && changed=1
  done
  has_systemd || { log "units: installed, not enabled (no systemd)"; return 0; }
  [[ $changed == 1 ]] && systemctl daemon-reload
  systemctl enable flyleaf-api.service flyleaf-worker.service >/dev/null 2>&1
  if [[ -e "$FLYLEAF_HOME/current" ]]; then
    systemctl restart flyleaf-api.service flyleaf-worker.service
  else
    log "units: no release yet; deploy/release.sh starts the API and worker"
  fi
  # Backups need the rclone remote (docs/deploy.md step 9). Until it exists the
  # timers stay off, or they would mail a failure every 6 hours.
  load_app_env
  if rclone --config /root/.config/rclone/rclone.conf listremotes 2>/dev/null | grep -qx "${BACKUP_REMOTE%%:*}:"; then
    systemctl enable --now flyleaf-backup.timer flyleaf-restore-drill.timer >/dev/null 2>&1
    log "units: backup and restore-drill timers on"
  else
    log "units: backup timers OFF until \`rclone config\` creates the remote '${BACKUP_REMOTE%%:*}' (docs/deploy.md step 9)"
  fi
}

step_deploykey() {
  load_app_env
  [[ "$REPO_URL" == git@* ]] || { log "deploykey: REPO_URL is not SSH; none needed"; return 0; }
  local ssh_dir="$FLYLEAF_HOME/.ssh"
  install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$ssh_dir"
  if [[ ! -f "$ssh_dir/id_ed25519" ]]; then
    runuser -u "$APP_USER" -- ssh-keygen -q -t ed25519 -N '' -C "flyleaf-deploy@$(hostname)" -f "$ssh_dir/id_ed25519"
  fi
  if ! grep -q '^github.com ' "$ssh_dir/known_hosts" 2>/dev/null; then
    local scanned fp
    scanned="$(ssh-keyscan -t ed25519 github.com 2>/dev/null)"
    fp="$(ssh-keygen -lf - <<<"$scanned" | awk '{print $2}')"
    [[ "$fp" == "$GITHUB_ED25519_FP" ]] || die "github.com host key fingerprint $fp is not GitHub's published $GITHUB_ED25519_FP"
    printf '%s\n' "$scanned" >> "$ssh_dir/known_hosts"
    chown "$APP_USER:$APP_USER" "$ssh_dir/known_hosts"
  fi
  log "deploykey: add this as a READ-ONLY deploy key (GitHub repo -> Settings -> Deploy keys):"
  sed 's/^/    /' "$ssh_dir/id_ed25519.pub" >&2
}

main() {
  require_root
  # shellcheck disable=SC1091
  if [[ -r /etc/os-release ]] && ! (. /etc/os-release && [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]); then
    log "WARNING: written for Ubuntu 24.04; this is $(. /etc/os-release && echo "$PRETTY_NAME")"
  fi
  local s
  for s in swap apt upgrades docker caddy node user kit env hosts ssh firewall journald \
           services dbroles storage proxy units deploykey; do
    step "$s"
  done
  log "provision: done. Next: sudo $FLYLEAF_HOME/deploy/release.sh (docs/deploy.md)"
}

# Sourcing defines the steps without running them (deploy/test/ does this).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
