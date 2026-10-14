# Deploying Flyleaf to one small server

The runbook for the deploy session: one Azure VM (Ubuntu 24.04, 4 GB RAM, 64 GB disk) running everything, with the VM's free DNS name and automatic HTTPS. Written to be followed from a phone through Claude Code Remote Control, one step at a time.

- **The kit:** `deploy/` (scripts, units, templates). Every script explains itself in its header.
- **Architecture:** §11 (deployment, operational rules, observability), §12 (when to outgrow this).
- **Tested:** `deploy/test/sandbox-e2e.sh` (66 checks: compose stack, database roles, catalog transfer, backups, drill, disaster restore, and the API and worker running as the least-privileged role) and `deploy/test/provision-container.sh` (provisioning twice + a real release in Ubuntu 24.04). What a sandbox could not test is listed at the end.

**Times** are rough estimates for planning a sitting, not measurements, except where marked *unknown until run*: the catalog's size and transfer times have never been measured.

---

## How to read each step

| Mark | Meaning |
|---|---|
| **Who: Claude** | Claude runs it, on the laptop or over SSH. Paste the step number. |
| **Who: YOU** | You type it yourself, in a terminal Claude cannot see (the laptop's own terminal, or an SSH app on the phone). Used only where a secret is typed or shown, so it never passes through the Claude session. |
| ⏱ | Rough time |
| ✅ | How to know it worked |
| ↩ | How to undo it |

Placeholders used throughout: `<label>` is the DNS label you choose (step 1), `<region>` the Azure region (`centralindia`), `<host>` = `<label>.<region>.cloudapp.azure.com`, `<admin>` = `flyleafadmin` (the VM's login user).

---

## 0. Before the session: have these ready

| What | Why | Where |
|---|---|---|
| Azure for Students subscription, active, with credit left | the VM | <https://www.microsoftazuresponsorships.com/Balance> shows the balance |
| Azure CLI on the laptop, signed in | step 1–2 | `winget install Microsoft.AzureCLI`, then `az login` |
| A Gmail account with 2-Step Verification ON, and an **app password** for it | the app's email (verification, password reset), backup alerts | Google Account → Security → 2-Step Verification → App passwords. 16 letters. |
| A Google account for Drive (can be the same) with free space | off-site backups | the free tier's quota is shared with Gmail; check free space at <https://one.google.com/storage> |
| A password manager entry ready for the **backup key** | without it, every backup is unreadable after losing the VM | step 9 |
| Access to the GitHub repo's Settings → Deploy keys | the server pulls code with a read-only key | step 5 |
| An UptimeRobot account (free) | outside-in monitoring | <https://uptimerobot.com>, step 10 |
| An SSH client you can type into that Claude cannot see | secrets (steps 3, 7b, 9) | the laptop's own terminal, or a phone SSH app with the VM's key |
| The laptop: Docker Desktop with `flyleaf-pg` running and the full `flyleaf` catalog database | step 6 | `docker ps` |
| Optional: an Expo access token | only if the Expo project enforces push security | expo.dev → Account settings → Access tokens |

**Decide the DNS label now:** lowercase letters, digits, hyphens, unique in the region, e.g. `flyleaf-vk`. It becomes `flyleaf-vk.centralindia.cloudapp.azure.com`.

---

## 1. Azure: region, size, price ⏱ 10 min · Who: Claude (laptop, PowerShell)

```powershell
az account show --output table          # the Azure for Students subscription must be the default
az account set --subscription "Azure for Students"   # if it is not

# Azure for Students limits the regions you may use. The list:
az policy assignment list --query "[].parameters.listOfAllowedLocations.value" --output json
```

Use `centralindia` if it is in that list. If not, the nearest allowed of `southindia`, `westindia`, `southeastasia`. If the command prints nothing, try `centralindia` in step 2: a refusal says `RequestDisallowedByPolicy`.

```powershell
$LOC = 'centralindia'
# A 2 vCPU / 4 GiB burstable size the region offers you. An empty Restrictions column means available.
az vm list-skus --location $LOC --resource-type virtualMachines --query "[?name=='Standard_B2s' || name=='Standard_B2als_v2' || name=='Standard_B2ls_v2'].{size:name, restrictions:restrictions[0].reasonCode}" --output table

# What each costs per hour in this region (Azure's public price list, pay-as-you-go, USD):
$f = "armRegionName eq '$LOC' and priceType eq 'Consumption' and serviceName eq 'Virtual Machines' and (armSkuName eq 'Standard_B2s' or armSkuName eq 'Standard_B2als_v2' or armSkuName eq 'Standard_B2ls_v2')"
(Invoke-RestMethod "https://prices.azure.com/api/retail/prices?`$filter=$f").Items |
  Where-Object { $_.productName -notmatch 'Windows' -and $_.skuName -notmatch 'Spot|Low Priority' } |
  Select-Object armSkuName, retailPrice, unitOfMeasure | Format-Table
```

Pick the cheapest available Linux size of the three (multiply the hourly price by ~730 for a month), and check it against the credit left. Add the disk (Standard SSD, 64 GiB: the E6 size) and a Standard public IP, both also priced in that API (`serviceName eq 'Storage'` and `serviceName eq 'Virtual Network'`).

- ✅ a region and a size you are allowed to use, and a monthly figure you are happy with.
- ↩ nothing was created.

---

## 2. Create the VM ⏱ 10 min · Who: Claude (laptop, PowerShell)

```powershell
$RG = 'flyleaf-rg'; $VM = 'flyleaf-vm'; $LOC = 'centralindia'
$LABEL = 'flyleaf-vk'            # your DNS label
$SIZE = 'Standard_B2s'           # from step 1

# A key just for this server (Enter twice: no passphrase, or set one and use ssh-agent).
ssh-keygen -t ed25519 -f "$HOME\.ssh\flyleaf_azure" -C "flyleaf-azure"

az group create --name $RG --location $LOC --output table

az vm create `
  --resource-group $RG --name $VM --location $LOC `
  --image Canonical:ubuntu-24_04-lts:server:latest `
  --size $SIZE `
  --admin-username flyleafadmin `
  --ssh-key-values "$HOME\.ssh\flyleaf_azure.pub" `
  --public-ip-sku Standard `
  --public-ip-address-dns-name $LABEL `
  --os-disk-size-gb 64 `
  --storage-sku StandardSSD_LRS `
  --nsg-rule SSH `
  --output table

# 80 and 443 in (Caddy). SSH (22) was opened by --nsg-rule SSH.
az network nsg rule create --resource-group $RG --nsg-name "${VM}NSG" --name allow-web `
  --priority 1010 --direction Inbound --access Allow --protocol Tcp `
  --source-address-prefixes Internet --destination-port-ranges 80 443 --output table

# Auto-shutdown OFF: a server that stops every evening is not a server.
# (An error that the schedule does not exist means it was already off.)
az vm auto-shutdown --resource-group $RG --name $VM --off

# The name and address:
az vm show --resource-group $RG --name $VM --show-details --query "{fqdn:fqdns, ip:publicIps, size:hardwareProfile.vmSize}" --output table
```

Optional, tighter: allow SSH only from your current address (home addresses change; you would then update the rule):
`az network nsg rule update -g $RG --nsg-name "${VM}NSG" -n default-allow-ssh --source-address-prefixes "$((Invoke-RestMethod https://api.ipify.org))/32"`

- ✅ `ssh -i $HOME\.ssh\flyleaf_azure flyleafadmin@<host>` logs in. `nslookup <host>` returns the public IP.
- ✅ Disk: `ssh … df -h /` shows about 62 GB.
- ↩ `az group delete --name flyleaf-rg` removes the VM, disk, IP, NSG and the DNS label. Billing for them stops.

If `--image` is rejected, list the current Ubuntu 24.04 images: `az vm image list --publisher Canonical --offer ubuntu-24_04-lts --sku server --all --output table`.

---

## 3. Copy the kit and write the configuration ⏱ 10 min

**3a · Who: Claude** (laptop)

```powershell
scp -i $HOME\.ssh\flyleaf_azure -r .\deploy flyleafadmin@<host>:~/
```

**3b · Who: YOU** (your own terminal: this prompts for the Gmail app password)

```
ssh -i ~/.ssh/flyleaf_azure -t flyleafadmin@<host> sudo bash ~/deploy/configure-env.sh
```

It generates every other secret (JWT_SECRET, database and MinIO passwords, the storage key, the backup key pair) and asks for: the host name (`<host>`), your email, the Gmail address, its app password (hidden), and the Expo token (Enter to skip).

Alternative without typing on the server: write a file on the laptop with these lines, `scp` it, `chmod 600` it, and run `sudo bash ~/deploy/configure-env.sh --answers ~/answers`, then delete it.

```
FLYLEAF_HOST=<host>
OWNER_EMAIL=you@example.com
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
EXPO_ACCESS_TOKEN=
```

- ✅ `sudo ls -l /etc/flyleaf` (Claude may run this) shows `flyleaf.env`, `app.env` and `backup.agekey`, all `-rw-------`.
- ↩ `sudo rm -rf /etc/flyleaf` and run it again. Nothing uses it yet.

---

## 4. Provision ⏱ 15–25 min · Who: Claude (SSH)

```
ssh -i ~/.ssh/flyleaf_azure flyleafadmin@<host> sudo bash ~/deploy/provision.sh
```

What it does, in order: 2 GB swap file · apt packages · unattended security upgrades (reboot at 21:30 UTC = 03:00 IST when needed) · Docker (official repo) · Caddy (official repo) · Node 22 (nodejs.org, checksum verified) · user `flyleaf` and directories · installs the kit at `/opt/flyleaf/deploy` · renders `/etc/flyleaf/app.env` · maps `<host>` to 127.0.0.1 in `/etc/hosts` · SSH keys-only · UFW (22, 80, 443) · journald capped at 500 MB · Postgres 18 + MinIO containers · the database roles (below) · the storage bucket and a key limited to it · Caddyfile · systemd units · a read-only deploy key, printed at the end.

Every step checks before it changes anything: running it again is safe, and is how any later change to `/etc/flyleaf/flyleaf.env` is applied.

- ✅ It ends with `provision: done` and prints a deploy key (`ssh-ed25519 …`).
- ✅ `sudo docker ps` shows `flyleaf-pg` and `flyleaf-minio` healthy, both on `127.0.0.1` only. `sudo ufw status` shows 22, 80, 443.
- ✅ `curl -sI http://<host>` from the laptop gets an answer from Caddy (a redirect to https).
- ↩ Re-run after fixing whatever the error names. To start the machine over: step 2's `az group delete`, then steps 2–4.

---

## 5. First release ⏱ 10–15 min · Who: Claude (SSH), after YOU add the deploy key

**5a · YOU:** GitHub → the repo → Settings → Deploy keys → Add deploy key. Paste the key step 4 printed, title `flyleaf-vm`, leave **Allow write access OFF**. (Lost it? `sudo cat /opt/flyleaf/.ssh/id_ed25519.pub`.)

**5b · Claude:**

```
sudo /opt/flyleaf/deploy/release.sh            # main, or name a branch/tag/commit
```

It clones, builds `apps/api` (`npm ci`, the api-client, `tsc`, then drops dev dependencies), runs the migrations on the empty database, points `/opt/flyleaf/current` at the build, starts `flyleaf-api` and `flyleaf-worker`, and waits for `/readyz`. If the new build is not healthy within 60 s it switches back by itself.

- ✅ `release.sh` ends with `released <commit>` and `healthy through Caddy: https://<host>/readyz`.
- ✅ From the phone's browser: `https://<host>/healthz` shows `{"status":"ok"}` with a valid padlock (Let's Encrypt). The first certificate can take a minute after the first request.
- ✅ `sudo /opt/flyleaf/deploy/app.sh ping`, then `journalctl -u flyleaf-worker -n 5` shows `job handled`.
- ↩ `sudo /opt/flyleaf/deploy/release.sh --rollback` (code only). Before any users exist, also fine: `sudo systemctl stop flyleaf-api flyleaf-worker`.

**Do not use the app yet: no searches, no sign-ups, no admin account until step 6 is done.** A search fetches books from Open Library into the catalog and an account is a user row, and the catalog restore only accepts an empty database. (If it happens: "Starting the database over" below.)

---

## 6. The catalog: laptop → server ⏱ unknown until run

The catalog leaves the laptop **without** any user data: only the tables in `deploy/config/catalog-tables.txt` keep their rows.

| Rows travel (catalog) | Schema only, rows stay on the laptop |
|---|---|
| `works`, `editions`, `authors`, `work_authors`, `pending_work_authors`, `series`, `series_entries`, `subjects`, `work_subjects`, `external_ids`, `field_provenance`, `search_suggestions`, and drizzle's migration journal | everything else: `users`, `profiles`, tokens, `reads`, `progress_events`, `reviews`, likes and comments, `follows`, `blocks`, `mutes`, `activity`, `events`, shelves, imports and exports, uploads, notifications, push tokens, moderation, goals, rate limits, admin accounts and audit log, `work_stats` and `catalog_rating_stats` (ratings aggregated from users), `work_merges` and the dedupe tables (they record moves of user rows), `ingest_runs`, any other schema, and all bench data |
| `raw_payloads` only with `-IncludeRawPayloads` (Open Library's raw JSON, for reprocessing; the largest table) | |

Why this split: the catalog is Open Library data (CC0) and the same for everyone; everything else was written by, or computed from, people using the app, including the laptop's `bench_*` personas. A table not in the list is left behind by default, so a new user table can never leak. `apps/api/src/test/deploy-kit.test.ts` fails if a catalog table gains a reference to user data.

**6a · Who: Claude (laptop, PowerShell, repo root)**

```powershell
.\deploy\catalog\Export-Catalog.ps1
```

It runs `pg_dump` inside `flyleaf-pg` (so the dump is Postgres 18's own format), copies the file out, checks its SHA-256 and prints the size, time and row counts. It checks the Docker VM's free space first and warns if the uncompressed data is larger. Output: `.\catalog-export\flyleaf-catalog-<stamp>\` (`catalog.dump`, `manifest.txt`; git-ignored).

**6b · Who: Claude (laptop)** — copy it up. Time depends on the dump's size and the home connection's upload speed:

```powershell
scp -i $HOME\.ssh\flyleaf_azure -r .\catalog-export\flyleaf-catalog-<stamp> flyleafadmin@<host>:/srv/flyleaf/import/
```

`/srv/flyleaf/import` belongs to the admin user (provision.sh), so no sudo is needed for the copy.

**6c · Who: Claude (SSH)**

```
sudo /opt/flyleaf/deploy/catalog/restore-catalog.sh /srv/flyleaf/import/flyleaf-catalog-<stamp>
```

Checks the SHA-256, stops the API and worker, recreates the (empty) database, restores, zeroes `reader_count` (it counted laptop reads), compares every table's row count with the manifest, rebuilds search suggestions, runs the migrations, `ANALYZE`, starts the API and worker. It refuses a database that has any user or any work in it.

- ✅ It prints a table of counts, all `ok`, and `catalog restored in N s`.
- ✅ `curl -fsS "https://<host>/v1/search?q=earthsea"` returns books.
- ↩ Before anyone has signed up: run it again with a new dump after "Starting the database over" below. After users exist: there is no undo by design; the catalog is then changed only by the app and the admin console.

Note the size and the three times in this file afterwards; they are unknown until this first run. Then step 7.

---

## 7. Smoke test and the first admin ⏱ 10 min · Who: Claude, then YOU for 7b

```
curl -fsS https://<host>/readyz
curl -fsS "https://<host>/v1/search?q=earthsea" | head -c 300     # books from the catalog
sudo systemctl status flyleaf-api flyleaf-worker caddy --no-pager | grep -E 'Active|Main PID'
sudo docker stats --no-stream
free -h; df -h /
```

- ✅ `ready`; all three units `active (running)`; memory and disk look like the budget in `deploy/compose.production.yml`.
- ↩ nothing to undo.

**7b · YOU: the first admin.** The password is typed at a hidden prompt, and the TOTP secret and backup codes are printed once, so run it in your own terminal:

```
sudo /opt/flyleaf/deploy/app.sh admin create --email <ops address> --role admin
```

Enrol the TOTP secret in an authenticator and store the backup codes in the password manager. The admin console is at `https://<host>/admin/login`.

---

## 8. Point the app at the server ⏱ depends on the build path · Who: YOU + Claude

The app's address comes from the EAS build profile: `FLYLEAF_API_URL` in `apps/mobile/eas.json` (preview and production: `https://<host>`; development: the laptop), through `app.config.ts` into `extra.apiUrl`. **`docs/mobile-release.md`** is the whole beta checklist: Firebase and the FCM V1 key for push, the preview APK, and App Links. The emailed links go to `https://<host>/verify-email` and `/reset-password`. The beta's intent filters list `<host>` beside `flyleaf.app`, so once `ANDROID_APP_PACKAGE` and `ANDROID_CERT_SHA256` are set here (mobile-release.md step 7), those links and the public pages open the app. Until then they open the web pages, which work.

- ✅ Sign up from the phone, receive the verification email (Gmail), verify, log a book.
- ↩ nothing on the server to undo.

---

## 9. Backups on ⏱ 20 min · Who: YOU for 9a–9b, Claude for 9c–9f

Per architecture §11, adapted to $0:

| | What | When | Kept |
|---|---|---|---|
| user data | everything except the catalog's rows, plus a **catalog delta** (works this server added from Open Library or changed in a merge, with their authors and ids) | every 6 h, 00/06/12/18 UTC | 8 newest (48 h) in `recent/`, first of each day 30 days in `daily/`, first of each month 12 months in `monthly/`; newest 2 on the VM |
| catalog | the dump from step 6 | once (it is reproducible from the laptop or Open Library) | until replaced |
| encryption | `age`, to the key pair in `/etc/flyleaf/backup.agekey` | | |
| where | Google Drive, folder `flyleaf-backups`, through `rclone` | | |
| failure | mail to OWNER_EMAIL with the log tail (`flyleaf-notify@`) | at once | |
| drill | newest backup **from Drive**, into a scratch database, every count and 7 content checksums compared, every user-to-user reference checked | 2nd of each month, 08:00 UTC, report mailed | |

Why the delta: user rows point at works the server fetched from Open Library after the transfer (gap-fill). Without those works, a restore would leave reads pointing at nothing. `restore-full.sh` puts back catalog + delta + user data and then checks every foreign key.

**9a · YOU: the backup key, off the machine.** Without this copy the backups cannot be read after losing the VM.

```
sudo cat /etc/flyleaf/backup.agekey
```

Copy all three lines into the password manager entry (`# created…`, `# public key…`, `AGE-SECRET-KEY-1…`). Clear the terminal.

**9b · YOU: connect Google Drive.** The VM has no browser, so rclone's sign-in happens on the laptop:

1. On the laptop: `winget install Rclone.Rclone`, then `rclone authorize "drive"`. A browser opens; sign in to the Google account for backups; the terminal prints a token (`{"access_token":…}`).
2. On the VM: `sudo rclone config` → `n` (new remote) → name **`gdrive`** → storage `drive` → client id and secret: Enter (defaults) → scope `1` (full access) → service account: Enter → advanced config `n` → auto config `n` → paste the token from step 1 → shared drive `n` → `y` to keep → `q`.
3. Check: `sudo rclone mkdir gdrive:flyleaf-backups && sudo rclone about gdrive:`.

The remote name and folder are `BACKUP_REMOTE` in `/etc/flyleaf/flyleaf.env` (`gdrive:flyleaf-backups`).

**9c · Claude:** turn the timers on (provision.sh does that once the remote exists):

```
sudo /opt/flyleaf/deploy/provision.sh
systemctl list-timers 'flyleaf-*'
```

**9d · Claude:** one backup, one drill, by hand:

```
sudo systemctl start flyleaf-backup.service && journalctl -u flyleaf-backup -n 20 --no-pager
sudo /opt/flyleaf/deploy/backup/restore-drill.sh --mail
```

**9e · Claude:** the catalog's one copy (checks Drive's free space first, streams, verifies by MD5):

```
sudo /opt/flyleaf/deploy/backup/backup-catalog.sh /srv/flyleaf/import/flyleaf-catalog-<stamp>
```

If Drive lacks room for it, it stops and says so; the laptop's database and the dump on the laptop are then the catalog's only copies (decision below).

**9f · Claude:** prove the alarm works: `sudo systemctl start flyleaf-notify@test.service` → a "FAILED: test" mail arrives at OWNER_EMAIL.

- ✅ `rclone lsf gdrive:flyleaf-backups/recent` lists one `.tar.age`; the drill mail says `PASSED`; the test alarm arrived.
- ↩ `sudo systemctl disable --now flyleaf-backup.timer flyleaf-restore-drill.timer` stops them. Files on Drive can be deleted from the Drive web page.

Optional dead-man's switch (a mail when backups *stop*, which a failure mail cannot cover): a free <https://healthchecks.io> check with a 6-hour period and 1-hour grace; put its ping URL in `BACKUP_PING_URL` in `/etc/flyleaf/flyleaf.env` and re-run `provision.sh`.

---

## 10. Outside-in monitoring ⏱ 10 min · Who: YOU (web)

UptimeRobot (free plan), <https://dashboard.uptimerobot.com>:

1. **Add New Monitor** → type **Keyword** → URL `https://<host>/readyz` → keyword `ready`, alert when **not exists** → interval **5 minutes** → name `flyleaf readyz`.
2. Second monitor, type **HTTP(s)**: `https://<host>/healthz` (the process is up even when the database is not; the pair tells the two apart).
3. Alert contact: your email (and the mobile app's push, if installed).
4. If the plan offers SSL certificate expiry alerts, turn them on (architecture §11: expiring within 14 days).

**Deviation from architecture §11:** §11 asks for an external pinger every 60 s. UptimeRobot's free plan checks every 5 minutes, so an outage can go unnoticed for up to about 5 minutes, plus the alert delay. Accepted for now (owner decision, to stay at $0); a paid plan or another pinger closes the gap without changes here.

`/readyz` is also what Caddy checks every 15 s: while it fails, Caddy answers 503 at once instead of letting requests hang.

- ✅ Both monitors green. `sudo systemctl stop flyleaf-api` → the readyz monitor alerts within its interval; `sudo systemctl start flyleaf-api` → it recovers.
- ↩ pause or delete the monitors.

---

## 11. Close the session ⏱ 10 min · Who: Claude

```
sudo reboot
# a minute later:
curl -fsS https://<host>/readyz && ssh … 'systemctl is-active flyleaf-api flyleaf-worker caddy docker; sudo docker ps --format "{{.Names}} {{.Status}}"; swapon --show; systemctl list-timers "flyleaf-*" --no-pager'
```

- ✅ Everything comes back by itself after a reboot.
- ✅ Cost: Azure portal → Cost Management → Cost analysis, scope `flyleaf-rg`, and the credit balance page. Check again after a week: the first full week is the real figure.
- Record here: the catalog dump's size, export, upload and restore times; the backup size and duration (`journalctl -u flyleaf-backup`).

---

## Database roles

The API and the worker never connect as a superuser or as the schema's owner. `deploy/db/roles.sql`, applied by `provision.sh`, by every `release.sh` and by both restore scripts (`sudo /opt/flyleaf/deploy/db-roles.sh` by hand), sets up three roles:

| Role | Used by | Can |
|---|---|---|
| `flyleaf` | backups, restores, `db-roles.sh` (through `docker exec`, never over the network by the app) | everything: the container's superuser (`POSTGRES_PASSWORD`) |
| `flyleaf_owner` | migrations (`MIGRATION_DATABASE_URL`: `release.sh`, `app.sh migrate`, the restore scripts) | owns the database, the `public` and `drizzle` schemas and every table and function in them; runs DDL. Not a superuser, cannot create databases or roles. `pg_trgm` and `unaccent` are trusted extensions, so it can create them as the database's owner |
| `flyleaf_app` | the API and the worker (`DATABASE_URL`), and `app.sh admin/ping/dedupe` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the app's tables, sequences, `EXECUTE` on its functions. Nothing else: no table, index, function, schema, temporary table, database or extension; no `DROP`, `ALTER`, `TRUNCATE`; cannot read the migration journal, `SET ROLE` to the owner, or `COPY … TO PROGRAM` |

**One exception, deliberately:** `flyleaf_app` owns the `pgboss` schema. pg-boss manages its own tables at run time: `create_queue()` creates a partition table per queue, and its maintenance adds and drops `queue_stats` partitions. So the role that runs pg-boss must own that schema. It holds job-queue state only, which backups leave out. `roles.sql` creates the schema in advance and `PGBOSS_CREATE_SCHEMA=false` stops pg-boss from trying to create it, because Postgres checks the database-wide CREATE right before `IF NOT EXISTS`.

Tables that later migrations create are usable by the app at once: `ALTER DEFAULT PRIVILEGES` grants them, and `release.sh` re-applies the grants after every migration anyway. The three passwords are generated by `configure-env.sh` and live in `/etc/flyleaf/flyleaf.env`.

Check it any time: `sudo docker exec flyleaf-pg psql -U flyleaf -d flyleaf -c '\du'`. Tested by `deploy/test/sandbox-e2e.sh` §10: 18 kinds of DDL refused for `flyleaf_app`; then the compiled API and worker, connected as `flyleaf_app`, run register, reads, a review, follows, the feed, shelves, a presigned upload, an import and an export processed by the worker, and all 14 scheduled jobs, with no permission error in either log.

## Routine operations

| Task | Command (on the VM) |
|---|---|
| Ship a new version | `sudo /opt/flyleaf/deploy/release.sh [branch/tag/commit]` |
| Undo the last version (code only) | `sudo /opt/flyleaf/deploy/release.sh --rollback` |
| What is running | `sudo /opt/flyleaf/deploy/release.sh --status` |
| Re-apply the database roles and grants | `sudo /opt/flyleaf/deploy/db-roles.sh` |
| Logs | `journalctl -u flyleaf-api -f` · `-u flyleaf-worker` · `-u caddy` · `sudo docker logs flyleaf-pg` |
| Restart | `sudo systemctl restart flyleaf-api flyleaf-worker` |
| Change a setting | edit `sudo nano /etc/flyleaf/flyleaf.env`, then `sudo /opt/flyleaf/deploy/provision.sh` |
| Node security patch (newest 22.x) | `sudo /opt/flyleaf/deploy/provision.sh` |
| Upgrade Postgres/MinIO image | change `POSTGRES_IMAGE`/`MINIO_IMAGE` in flyleaf.env, then `provision.sh` (a Postgres **major** upgrade needs `pg_upgrade`; not covered here) |
| Backup now | `sudo systemctl start flyleaf-backup.service` |
| Drill now | `sudo /opt/flyleaf/deploy/backup/restore-drill.sh` |
| MinIO console | laptop: `ssh -L 9001:127.0.0.1:9001 …`, then <http://localhost:9001> (root user from flyleaf.env) |
| Update the kit itself | `scp -r deploy …:~/` then `sudo bash ~/deploy/provision.sh` (it reinstalls itself into `/opt/flyleaf/deploy`) |

Migrations are forward-only (§11 rule 5): `--rollback` runs the previous code against the newer schema, which the additive-migration style keeps safe. A release whose migration is not backward-compatible should say so in its PR.

## When a backup fails

The mail has the log tail. In order:

1. `journalctl -u flyleaf-backup -n 100 --no-pager`
2. `sudo rclone about gdrive:` — Drive full, or the token expired (re-run step 9b's `rclone config`, choose the existing remote, and refresh the token).
3. `df -h /` — the VM's disk (the backup also mails at 70%).
4. `sudo docker ps` — Postgres up?
5. Run it by hand: `sudo /opt/flyleaf/deploy/backup/backup.sh`. Fix, and confirm the next scheduled run (`systemctl list-timers 'flyleaf-*'`).

## Disaster: rebuilding on a new machine

1. Step 2 for a new VM (the old DNS label is free again once the old IP is deleted; otherwise choose a new one), and step 3a.
2. **Before** step 3b, put the backup key back, so configure-env.sh uses it instead of making a new pair: `sudo install -d -m 700 /etc/flyleaf && sudo nano /etc/flyleaf/backup.agekey` (paste the three lines from the password manager), then `sudo chmod 600 /etc/flyleaf/backup.agekey`.
3. Steps 3b, 4 and 5. In 5b deploy the release the backup was taken with (`release.sh <commit>`): the backup's `manifest.txt` names it, and `restore-full.sh` prints it. Then step 9b (rclone).
4. The catalog: download and decrypt the copy from `gdrive:flyleaf-backups/catalog/` into `/srv/flyleaf/import/<dir>` (`rclone copy …`, then `age -d -i /etc/flyleaf/backup.agekey X.tar.age | tar -x -C /srv/flyleaf/import/<dir>`), or export a fresh one from the laptop (step 6).
5. `sudo /opt/flyleaf/deploy/backup/restore-full.sh --catalog /srv/flyleaf/import/<dir> --backup newest`
   It restores the catalog, upserts the catalog delta, loads the user data with triggers off, re-runs the migrations (which recount `reader_count`), compares every count and checksum with the backup's manifest, and checks **every** foreign key. It refuses a database that already has users.
6. `sudo systemctl start flyleaf-backup.service`, and re-check monitoring.

## Starting the database over (only before real users)

```
sudo systemctl stop flyleaf-api flyleaf-worker
sudo docker exec flyleaf-pg psql -U flyleaf -d postgres -c 'DROP DATABASE flyleaf WITH (FORCE)'
sudo /opt/flyleaf/deploy/db-roles.sh         # creates it again, owned by flyleaf_owner, with the app role's grants
sudo rm -f /var/lib/flyleaf/catalog-base.env
sudo /opt/flyleaf/deploy/app.sh migrate      # as flyleaf_owner; or restore a catalog (step 6c), which needs the empty database
sudo systemctl start flyleaf-api flyleaf-worker
```

## Moving to a real domain

1. DNS: an `A` record for the domain → the VM's public IP (`az vm show … --query publicIps`), or a `CNAME` → `<host>`.
2. `FLYLEAF_HOST='your.domain'` in `/etc/flyleaf/flyleaf.env`, then `sudo /opt/flyleaf/deploy/provision.sh`. That re-renders Caddy (new certificate), `APP_BASE_URL`, `S3_ENDPOINT`, CORS and `/etc/hosts`, and restarts the services.
3. App Links: `ANDROID_APP_PACKAGE`/`ANDROID_CERT_SHA256` (and iOS) in flyleaf.env stay as set for the beta (same signing key). Add the domain to `apps/mobile/app.json`'s intent filters and associated domains beside the others, set `FLYLEAF_API_URL` in `apps/mobile/eas.json` to it, and rebuild (`docs/mobile-release.md`, Next builds).
4. Uploads in flight during the switch fail once (their signed URLs name the old host) and succeed when retried.

---

## Not tested in the sandbox

The kit was exercised in a Linux sandbox (Docker, Postgres 18, the MinIO build in `MINIO_IMAGE`, Ubuntu 24.04 containers). These could not be, and are first proven in the deploy session:

- **Azure itself**: the CLI commands, the region policy, the image URN, NSG, auto-shutdown, prices.
- **systemd** behaviour: the units' start, restart backoff, timers, `OnFailure` mail, reboot. (`systemd-analyze` validated the timer schedules; the units were installed but no systemd runs in a container.)
- **UFW** (needs a kernel firewall) and the **real Caddy** from Caddy's repo with **Let's Encrypt** (the config was validated with Ubuntu's Caddy 2.6.2; certificates need a public name).
- **Gmail SMTP** (mail was sent to a local SMTP sink, without authentication) and **Google Drive** via rclone (an rclone `local` remote stood in; Drive's MD5 check and trash behaviour are the real thing's).
- **The deploy key** against GitHub (the sandbox cannot reach github.com on port 22; the host-key fingerprint was checked offline).
- **Windows PowerShell 5.1**: `Export-Catalog.ps1` ran under PowerShell 7.4 on Linux against a Postgres 18 container, not under 5.1 on Windows.
- **Real sizes**: the catalog was a 5-work fixture. Dump size, restore time and memory use at 3.2M works are unknown until run.
