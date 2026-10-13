# deploy/

Everything needed to run Flyleaf on one small Linux server. **The runbook is [`docs/deploy.md`](../docs/deploy.md)**; start there. Every script explains itself in its header.

| File | Runs on | What |
|---|---|---|
| `env.production.example` | — | The production environment, as a template. No secrets: `configure-env.sh` fills them in on the server |
| `configure-env.sh` | server | Creates `/etc/flyleaf/flyleaf.env` (generates secrets, asks for the rest, or reads a mode-600 answers file) and renders `app.env` |
| `provision.sh` | server | Idempotent setup: swap, packages, unattended upgrades, Docker, Caddy, Node, firewall, Postgres + MinIO, units |
| `compose.production.yml` | server | Postgres 18 and MinIO, sized for 4 GB, loopback only |
| `Caddyfile.template` | server | HTTPS for the host name; `/<bucket>/…` to MinIO, the rest to the API |
| `systemd/` | server | API, worker, backup and drill timers, failure mail |
| `release.sh` | server | Build a commit, migrate, switch, health-check, roll back on failure |
| `db-roles.sh`, `db/roles.sql` | server | The database roles: `flyleaf_owner` owns the schema and runs migrations, `flyleaf_app` (API, worker) has rows only, no DDL |
| `app.sh` | server | The app's own CLIs (admin accounts, ping, dedupe) as the app user |
| `catalog/Export-Catalog.ps1` | laptop | Dump the catalog only (no user data) from the local `flyleaf` database |
| `catalog/dump-catalog.sh` | laptop's Postgres container | What the .ps1 runs inside `flyleaf-pg` |
| `catalog/restore-catalog.sh` | server | Restore that dump into the empty database, verify counts, migrate |
| `config/catalog-tables.txt` | both | Which tables are "the catalog". Everything else is user data |
| `backup/backup.sh` | server, every 6 h | User data + catalog delta, encrypted with age, to Google Drive via rclone; 30 daily / 12 monthly |
| `backup/backup-catalog.sh` | server, once | The catalog's one encrypted off-site copy |
| `backup/restore-drill.sh` | server, monthly | Newest off-site backup into a scratch database; counts, checksums, foreign keys |
| `backup/restore-full.sh` | server, disaster | Catalog + delta + user data into a fresh database, then every check |
| `backup/notify.sh` | server | Mail to the owner through the app's Gmail SMTP |
| `test/` | sandbox with Docker | `sandbox-e2e.sh` (with `app-role-path.mjs`) and `provision-container.sh`: the kit end to end. Not in CI (Docker, minutes) |

Shell scripts pass `shellcheck` (`.shellcheckrc` here); `apps/api/src/test/deploy-kit.test.ts` keeps `catalog-tables.txt` and the env template in step with the schema and the providers, and runs in CI.
