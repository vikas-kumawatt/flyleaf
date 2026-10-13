#!/usr/bin/env bash
# Runs deploy/provision.sh (twice) and deploy/release.sh in a fresh Ubuntu
# 24.04 container, the closest a sandbox gets to the VM. Not part of CI.
#
#   bash deploy/test/provision-container.sh
#
# A container has no systemd, no kernel firewall and no Docker daemon of its
# own, so these steps are skipped and the rest is checked for real:
#   skipped:  firewall, services, storage (need a kernel/daemon of their own), deploykey
#             (needs github.com:22)
#   real:     swap file, apt, unattended-upgrades config, Docker packages,
#             Caddy (+ rendered Caddyfile validated), Node from nodejs.org
#             with its checksum, user and directories, env rendering,
#             /etc/hosts, sshd drop-in (sshd -t), journald, database roles
#             (on a Postgres 18 container, through the host's Docker), unit files; then
#             a second run that must change nothing; then release.sh: clone,
#             npm ci, build, prune, migrate against a real Postgres 18,
#             switch, and the compiled API answering /readyz.
#
# Behind an HTTPS-intercepting proxy, set PROXY_CA to its CA bundle (the
# sandbox's is /root/.ccr/ca-bundle.crt); the proxy variables are passed in.
#
# Needs: docker, the images ubuntu:24.04 and postgres:18-alpine. Commit first:
# release.sh builds the branch's HEAD from git.

set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${UBUNTU_IMAGE:=ubuntu:24.04}"
: "${POSTGRES_TEST_IMAGE:=postgres:18-alpine}"
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
PG=flyleaf-provision-pg
PGPASS="provision-test-$(openssl rand -hex 6)"
# Checked inside the box, whose script is single-quoted and so cannot hold one.
export ROLE_SQL="SELECT string_agg(rolname || ':' || rolsuper::text, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('flyleaf_app', 'flyleaf_owner')"

cleanup() { docker rm -f "$PG" flyleaf-provision-box >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# release.sh migrates against 127.0.0.1:5432 from inside the box (host network).
docker run -d --name "$PG" -e POSTGRES_USER=flyleaf -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=flyleaf \
  -p 127.0.0.1:5432:5432 "$POSTGRES_TEST_IMAGE" >/dev/null

proxy_env=()
for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  [[ -n "${!v:-}" ]] && proxy_env+=(-e "$v")
done
ca_mount=()
# Node (npm) ignores the system CA store: it gets the proxy CA explicitly.
[[ -n "${PROXY_CA:-}" ]] && ca_mount=(-v "$PROXY_CA:/proxy-ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/proxy-ca.crt)

# The box drives the host's Docker (the socket) for the steps that talk to
# Postgres: the dbroles step, and release.sh's migrations as flyleaf_owner.
docker run --rm --name flyleaf-provision-box --network host "${proxy_env[@]}" "${ca_mount[@]}" \
  -e BRANCH="$BRANCH" -e PGPASS="$PGPASS" -e PG_CONTAINER="$PG" -e ROLE_SQL \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO:/repo:ro" "$UBUNTU_IMAGE" bash -Eeuo pipefail -c '
  ok() { printf "  \033[32mok\033[0m %s\n" "$*"; }
  fail() { printf "  \033[31mFAIL\033[0m %s\n" "$*"; exit 1; }
  check() { local what="$1"; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }

  # -- what a fresh Azure Ubuntu image has and a container lacks ------------
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q >/dev/null
  apt-get install -y -q --no-install-recommends ca-certificates curl openssl age openssh-server git sudo >/dev/null
  if [[ -f /proxy-ca.crt ]]; then
    cp /proxy-ca.crt /usr/local/share/ca-certificates/proxy-ca.crt && update-ca-certificates >/dev/null 2>&1
  fi
  mkdir -p /run/sshd
  git config --system --add safe.directory "*"
  cp -a /repo/deploy /root/deploy
  # As if copied with scp from Windows: no executable bits (docs/deploy.md step 3a).
  find /root/deploy -name "*.sh" -exec chmod a-x {} +

  cat > /root/answers <<EOF
FLYLEAF_HOST=flyleaf-box.centralindia.cloudapp.azure.com
OWNER_EMAIL=owner@example.com
GMAIL_ADDRESS=sender@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
EXPO_ACCESS_TOKEN=
EOF
  chmod 600 /root/answers
  bash /root/deploy/configure-env.sh --answers /root/answers 2>/dev/null
  sed -i -e "s#^REPO_URL=.*#REPO_URL=\x27file:///repo\x27#" -e "s#^REPO_REF=.*#REPO_REF=\x27$BRANCH\x27#" \
         -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=\x27$PGPASS\x27#" /etc/flyleaf/flyleaf.env

  export PROVISION_SKIP=firewall,services,storage,deploykey CADDY_FROM_UBUNTU=1
  echo "-- provision.sh, first run"
  bash /root/deploy/provision.sh > /root/run1.log 2>&1 || { cat /root/run1.log; fail "provision.sh run 1"; }
  ok "provision.sh completed"
  grep -E "SKIPPED|node:|caddy:|units:" /root/run1.log | sed "s/^/     /"

  check "swap file /swapfile, mode 600, in fstab" bash -c "[[ \$(stat -c %a /swapfile) == 600 ]] && grep -q \"^/swapfile \" /etc/fstab"
  check "unattended-upgrades on, reboot at 21:30" grep -q "Automatic-Reboot-Time \"21:30\"" /etc/apt/apt.conf.d/52flyleaf-unattended-upgrades
  check "docker $(docker --version | cut -d" " -f3 | tr -d ,) + compose plugin installed" docker compose version
  check "docker logs rotate" grep -q "max-size" /etc/docker/daemon.json
  check "node $(/usr/local/bin/node -v), npm $(/usr/local/bin/npm -v)" bash -c "/usr/local/bin/node -v | grep -q ^v22\."
  check "caddy installed and Caddyfile valid" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  check "Caddyfile serves the host" grep -q "^flyleaf-box.centralindia.cloudapp.azure.com {" /etc/caddy/Caddyfile
  check "user flyleaf, nologin" bash -c "getent passwd flyleaf | grep -q /usr/sbin/nologin"
  check "kit installed at /opt/flyleaf/deploy" test -x /opt/flyleaf/deploy/backup/backup.sh
  check "app.env rendered, mode 600" bash -c "[[ \$(stat -c %a /etc/flyleaf/app.env) == 600 ]]"
  check "/etc/hosts sends the host name to loopback" grep -q "^127.0.0.1 flyleaf-box.centralindia.cloudapp.azure.com # flyleaf-managed$" /etc/hosts
  check "sshd: passwords off, config accepted" bash -c "grep -q \"^PasswordAuthentication no\" /etc/ssh/sshd_config.d/60-flyleaf.conf && sshd -t"
  check "journald capped" grep -q "SystemMaxUse=500M" /etc/systemd/journald.conf.d/60-flyleaf.conf
  check "7 unit files installed" bash -c "[[ \$(ls /etc/systemd/system/flyleaf-* | wc -l) == 7 ]]"
  check "data directories" test -d /srv/flyleaf/postgres -a -d /srv/flyleaf/minio -a -d /var/backups/flyleaf/work
  roles_ok() { [[ "$(docker exec "$PG_CONTAINER" psql -U flyleaf -d postgres -Atc "$ROLE_SQL")" == "flyleaf_app:false flyleaf_owner:false" ]]; }
  check "database roles: flyleaf_owner and flyleaf_app, neither a superuser" roles_ok

  echo "-- provision.sh, second run (must change nothing)"
  snap() { find /etc/flyleaf /etc/caddy /etc/apt/apt.conf.d /etc/docker /etc/ssh/sshd_config.d /etc/systemd/system /etc/sysctl.d /etc/hosts /etc/fstab /usr/local/bin -type f -o -type l | sort | xargs md5sum 2>/dev/null; }
  snap > /root/before
  bash /root/deploy/provision.sh > /root/run2.log 2>&1 || { cat /root/run2.log; fail "provision.sh run 2"; }
  snap > /root/after
  check "second run: no file changed" diff /root/before /root/after
  check "second run: node not reinstalled" grep -q "is the newest 22.x" /root/run2.log
  check "second run: swap left alone" bash -c "! grep -q mkswap /root/run2.log"

  echo "-- release.sh $BRANCH"
  /opt/flyleaf/deploy/release.sh > /root/release.log 2>&1 || { cat /root/release.log; fail "release.sh"; }
  ok "release.sh: cloned, built, migrated, switched"
  rel="$(readlink /opt/flyleaf/current)"
  check "current -> $rel" test -f "$rel/apps/api/dist/server.js"
  check "REVISION is the commit" bash -c "[[ \$(cat $rel/REVISION) == \$(basename $rel) ]]"
  check "dev dependencies pruned (no tsx, no vitest)" bash -c "[[ ! -e $rel/apps/api/node_modules/tsx && ! -e $rel/apps/api/node_modules/vitest ]]"
  check "build owned by flyleaf" bash -c "[[ \$(stat -c %U $rel/apps/api/dist/server.js) == flyleaf ]]"
  check "a second release.sh of the same commit is a no-op" bash -c "/opt/flyleaf/deploy/release.sh 2>&1 | grep -q \"already the current release\""

  echo "-- the compiled API, started like flyleaf-api.service starts it"
  ( set -a; . /etc/flyleaf/app.env; set +a; cd /opt/flyleaf/current/apps/api
    NODE_OPTIONS=--max-old-space-size=384 runuser -u flyleaf -- /usr/local/bin/node dist/server.js > /root/api.log 2>&1 & echo $! > /root/api.pid )
  for _ in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:3000/readyz >/dev/null 2>&1 && break; sleep 1; done
  if curl -fsS -m 2 -o /dev/null http://127.0.0.1:3000/readyz; then
    ok "API /readyz answers 200 as OS user flyleaf, DB role flyleaf_app, NODE_ENV=production"
  else
    tail -c 3000 /root/api.log; fail "API /readyz as flyleaf_app"
  fi
  echo
  kill "$(cat /root/api.pid)"
  echo "-- all provisioning checks passed"
'
