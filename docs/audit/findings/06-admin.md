# Audit 06 — Admin console (FN-90 … FN-93, D-04-2, Part 05 hand-over)

2026-09-26 · CI **green, in two parts** (see CI) · tests **1017 → 1091 API** (+74: new `admin-security.test.ts`; three inherited assertions updated to the spec, listed under Behaviour changes; nothing weakened, skipped or removed) · mobile 100, unchanged

Databases: correctness on PGlite; the ingestion-status timings and the catalog count plans on the full **`flyleaf`** (the question is behaviour at 3.2M works); the audit-log plans, the `MERGE_WORKS` cost and the estimate-accuracy check on **`flyleaf_dev`**. 8 GB machine, **timings indicative only**. Migration `0023_admin_hardening.sql` added and applied to both (a second `npm run migrate` is a no-op). `secure-design` was not triggered: this run was autonomous by instruction, and this part is itself the admin security review.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| FN-90 | separate admin auth, mandatory 2FA, "secure session cookies" | ❌ 2FA and token audience held; the cookie was written by page script (not HttpOnly/Secure), TOTP codes replayable, backup codes double-spendable, app accounts revealed, failures unaudited, a demoted or deleted admin kept access for 2 h, 2FA setup replaced the live secret before verification, no way to create the first admin, no rate limit | A-06-002, -005 … -012, -016, -020, -021, -030, RL1 |
| FN-91 | merge review UI, 1-click undo | ⚠️ role gating correct; the page's merge/dismiss/undo buttons could never authenticate (cookie path), inline handlers | A-06-004, -015, -029 |
| FN-92 | maturity override locked against re-ingest; ingestion dashboard | ❌ **the lock was never read**: the next dump merge overwrote the override (P0, §7.9 [LOCKED]); stored and reflected XSS on the maturity page (P0); ingestion status 152 s on the full catalog; two REST schemas missing from the spec | A-06-001, -003, -013, -019, -022, -025 |
| FN-93 | every action audited, IP and UA, `(created_at desc)` index | ⚠️ successful actions were audited; failures and denials were not, IP/UA only in the login payload, not append-only, the claimed index did not exist | A-06-008, -017, -018, -026 |
| (lead 1) | cookie set by page JavaScript | ❌ confirmed (P0) | A-06-002 |
| (lead 2) | cookie accepted on every route + `cors({ origin: true })` → CSRF? | ⚠️ server accepted the cookie on every path and origin; only browser cookie attributes (`Path=/admin`, `SameSite=Lax`) stopped CSRF, and they also stopped the console's own buttons | A-06-004, -014, -016 |
| Part 05 hand-over | CSP `'unsafe-inline'`, JS cookie, CORS | ✅ fixed | A-06-002, -014, -015 |
| D-04-2 | bundled common-password list | ✅ implemented | A-06-024 |
| A-04-011 hand-over | admin email/password normalisation | ✅ fixed | A-06-012 |

## Findings

### A-06-001 · P0 · Stored and reflected XSS on the maturity review page
- **Where:** `admin/catalog-routes.ts` `/admin/catalog/maturity` (and `adminNavbar`): `${w.title}`, `${w.subtitle}`, `${w.author_name}`, `${admin.email}` in text; `value="${searchQuery}"` from `?q=`; the title inside `onclick="openOverrideModal('…', '${w.title.replace(/'/g, "\\'")}', …)"` (a `"` or `\` breaks out).
- **Evidence (pre-fix run):** a work titled `"><img src=x onerror=alert(1)>` rendered raw (`expected … not to contain '<img src=x'`); `?q="><script>alert(6)</script>` reflected raw. Titles come from Open Library dumps and user-reported duplicates, so anyone who can get a title into the catalog could run script in an admin's session, and a crafted link was enough for the reflected case. With A-06-002 that script could read the admin token.
- **Spec:** PRD §42 #9, §27.5.
- **Fix:** one `escapeHtml` (`admin/html.ts`) on every interpolation in all four pages; the modal gets the title from a `data-` attribute and sets it with `textContent`; no inline handlers anywhere; scripts only in `<script nonce>` (A-06-015). Also escaped: `dump_type`, dates, ids and numbers on the other pages, even where the source is trusted.
- **Test:** `admin-security.test.ts` › `admin HTML escapes every value …` (6 pages incl. `?q=`), `the maturity page still shows the title, escaped`. Seen failing before the fix: yes.

### A-06-002 · P0 · The admin session cookie was set by page JavaScript
- **Where:** `admin/routes.ts:387` (`document.cookie = 'flyleaf_admin_session=' + token + '; path=/admin; max-age=7200; SameSite=Lax'`), the token arriving in the JSON body of `POST /v1/admin/auth/login`.
- **Evidence:** not `HttpOnly` (any script on an admin page could read a full 2-hour admin token), not `Secure`.
- **Fix:** the login page is a plain form (no script) posting to the new `POST /admin/login`, which sets the cookie server-side: `HttpOnly; Secure; SameSite=Strict; Max-Age=7200`, once for `Path=/admin` and once for `Path=/v1/admin` (A-06-004). The token never reaches page script. `Secure` is left off only for plain `http` on `localhost`/`127.0.0.1` outside production. A failed login re-renders the form with the escaped message and the same status (401/403). `POST /v1/admin/auth/login` still returns the token for API clients (header auth).
- **Test:** browser-session block: `the login page has no script …`, `a successful form login sets HttpOnly, Secure, SameSite=Strict cookies …`, `Secure is left off only for plain http on localhost …`, `a failed form login re-renders …`. Seen failing before the fix: yes.

### A-06-003 · P0 · A locked maturity override was overwritten by the next ingest
- **Where:** `catalog/ingest/writer.ts` `MERGE_WORKS` (`maturity = EXCLUDED.maturity`, and every other column, unconditionally); `catalog/gapfill.ts` `persist` (`title = EXCLUDED.title`). Neither read `field_provenance.is_locked`; only gap-fill's own provenance upsert did.
- **Evidence (pre-fix run, the real `MERGE_WORKS` on PGlite):** override `explicit → general` with a reason, re-merge the same dump record → `maturity: 'explicit'` (`expected { maturity: 'explicit', … } to deeply equal { maturity: 'general', … }`). Gap-fill replaced a locked title.
- **Spec:** PRD §7.9 [LOCKED] "`is_locked` … the ingest may not overwrite it"; §7.8 [LOCKED]; FN-92's own claim.
- **Fix:** the `DO UPDATE` of both statements sets the column list from one sub-select that reads the work's locked field names (`field_provenance` key `(entity_type, entity_id, field_name)`, one probe per updated row) and keeps every locked column; unlocked columns behave exactly as before (COALESCE rules unchanged). `field_name` is the column name.
- **Cost (flyleaf_dev, 50k-row re-ingest batch, rolled back, 3 alternating rounds):** old 11.7–15.1 s, new 13.0–14.9 s; +6–10 % buffer hits. Within this machine's noise; the `works` index updates dominate.
- **Not covered:** `MERGE_EDITIONS` / `MERGE_AUTHORS` ignore locks too. Nothing locks edition or author fields yet → A-06-027.
- **Test:** `a locked maturity override survives re-ingest` (3: dump merge keeps the lock and still updates the title; an unlocked work takes the dump value; gap-fill keeps a locked title). Seen failing before the fix: yes (2 of 3; the unlocked case passed before and after).

### A-06-004 · P1 · The console's merge, dismiss, undo and override buttons could never authenticate
- **Where:** the pages `fetch('/v1/admin/…')`; the cookie was `Path=/admin`, which a browser does not send to `/v1/admin/…` (RFC 6265 path-match).
- **Evidence:** every write from the UI arrived without credentials → 401. No test exercised the browser flow: all existing tests either used a bearer token or `app.inject`, which ignores cookie paths.
- **Fix:** a second cookie scoped to `/v1/admin` (A-06-002), and CSRF protection on it (A-06-016).
- **Test:** `the same write from the console origin succeeds …` (cookie + same Origin → 200). The path semantics themselves are the browser's; asserted through the two `Path` values.

### A-06-005 · P1 · A TOTP code could be used twice
- **Where:** `admin/auth.ts` `loginAdmin` / `totp.ts` `verifyTotp` (boolean only; nothing stored).
- **Evidence:** the same code logged in twice; after a code for step T+1 an older code for step T still worked.
- **Fix:** `matchTotpStep` returns the matched step; login accepts it only through `UPDATE admin_credentials SET last_totp_step = $step WHERE … (last_totp_step IS NULL OR last_totp_step < $step) RETURNING`, so the check and the write are one statement (no race). ±1 step drift unchanged; comparison stays `timingSafeEqual` on equal-length strings.
- **Test:** `a TOTP code is accepted once …`, `after a code is used, an OLDER code … is refused too`; RFC 6238 Appendix B vectors (6, last six digits of the SHA-1 vectors; these passed before too, new coverage). Seen failing before the fix: yes (the two replay tests).

### A-06-006 · P2 · A backup code could be spent twice by two concurrent logins
- **Evidence:** `Promise.allSettled` of two logins with one code → 2 fulfilled (read, then a separate `UPDATE`).
- **Fix:** `UPDATE … SET backup_codes = array_remove(backup_codes, $hash) WHERE … $hash = ANY(backup_codes) RETURNING`. Codes stay SHA-256 hashed (32 bits of entropy each; fine behind the password, and with RL1).
- **Test:** `a backup code cannot be spent twice by two concurrent logins`. Seen failing before the fix: yes.

### A-06-007 · P2 · Admin login revealed app accounts
- **Evidence:** an app account's email got `403 admin_access_denied "Admin access required."` **before** the password was checked; an unknown email got 401 without any argon2 work. With no rate limit, `/v1/admin/auth/login` was an app-account oracle.
- **Spec:** PRD §42 #13, §6.4.
- **Fix:** unknown and non-staff emails run the same dummy argon2 verify as app login (`verifyAgainstDummy`, now shared) and get the same `401 invalid_credentials` as a wrong password. `2fa_not_configured` (403) is only reachable after a correct staff password.
- **Test:** `an app account gets the same 401 as a wrong password, whatever the password`. Seen failing before the fix: yes.

### A-06-008 · P1 · Failed logins, 2FA failures and denied actions were not audited; IP and UA only inside the login payload
- **Fix:** `admin.login_failed` with `payload.reason` `password | totp | totp_replay | no_2fa | unknown_account`; for an unknown or non-staff email the row has **no actor and no email** (the attempt is recorded, the address is not: §42.1); `admin.2fa_verify_failed`; `admin.denied` for any 403 to a staff member on an admin path (an `onResponse` hook: method, route, role). `ip` and `user_agent` are columns on every entry (0023), taken from `req.ip` (honours `TRUST_PROXY` only, A-04-002; UA control characters stripped, 400 chars). `actor_id` became nullable; the list and the page `LEFT JOIN` users.
- **Secrets:** no entry carries a password, code, token or TOTP seed (asserted on the failure rows).
- **Shortcut:** the `admin.denied` write happens after the response; if it fails it is logged (`req.log.error`), it cannot change a sent response.
- **Test:** `every failed attempt is audited, with no secret in the entry`, `a moderator denied a write is audited`, `a maturity override records who, what, why, from where …`, `lists failed logins whose actor is unknown`. Seen failing before the fix: yes.

### A-06-009 · P1 · A demoted, disabled or deleted admin kept access for up to 2 hours; logout ended nothing
- **Where:** the auth hook trusted the JWT's `role` claim (`verifyAdminToken`, stateless).
- **Evidence:** role set to `moderator` → the old token still undid merges as `admin` (404, not 403); role `user` or `deleted_at` set → `/v1/admin/auth/me` 200.
- **Fix:** `lookupAdmin(db, token)`: one PK query per admin request (admin traffic is 1–3 people) that requires a live staff account with 2FA configured and the token's `sv` claim to equal `admin_credentials.session_version`, and returns the **current** role. Logout and `disableAdmin` increment the version, which ends every session of that admin. Admin credentials are now only looked at on `/admin/…` and `/v1/admin/…` paths.
- **Why a counter, not a timestamp:** a cut-off compared with the whole-second `iat` cannot tell a token issued just before logout from one issued just after.
- **Test:** `a demoted admin acts with the current role, a removed one not at all`, `a deleted admin, and one disabled from the CLI, is refused`, `logout clears both cookies and ends every session of that admin`. Seen failing before the fix: yes.

### A-06-010 · P2 · 2FA setup replaced the working secret and backup codes before they were verified
- **Evidence:** `setup2fa` overwrote `totp_secret`/`backup_codes` and set `totp_verified = false`; login ignored `totp_verified`. A lost setup response locked the admin out, and an unconfirmed secret was live at once.
- **Fix:** setup writes `pending_totp_secret`/`pending_backup_codes`; `verify2fa` checks a code against the pending secret and only then swaps both in (`no_pending_2fa` 400 without a pending setup).
- **Test:** `2FA setup does not replace the working secret until the new one is verified`. Seen failing before the fix: yes.
- **Left:** moderators cannot rotate their own 2FA (setup/verify are `requireAdmin`). Harmless today; noted.

### A-06-011 · P1 · No way to create the first admin
- **Evidence:** `createAdminUser` had no caller outside tests; the only way was raw SQL, which §27.5 forbids ("no direct database editing").
- **Fix:** `npm run admin -- create --email … [--role] [--username]` and `npm run admin -- disable --email …` (`src/admin-cli.ts`). The password comes from `ADMIN_PASSWORD`, a hidden prompt (asked twice) or stdin, never an argument. The TOTP secret, otpauth URI and backup codes are printed **once to stdout**, never through the application logger. Creation is one transaction (it was three statements, and a username clash silently left an admin without a profile via `ON CONFLICT DO NOTHING`).
- **Test:** `disableAdmin` via the revocation test. The CLI's argument/prompt handling is not tested (thin I/O wrapper); run by hand: see Behaviour changes.

### A-06-012 · P2 · Admin accounts bypassed the app's email and password rules (A-04-011 hand-over)
- **Evidence:** `createAdminUser` stored the email as given, hashed the password without NFC, applied no length or common-password rule; `loginAdmin` looked up `lower(email)` (no index, and a mixed-case admin email could coexist with a lowercase app account).
- **Fix:** `normaliseEmail`, `normalisePassword` and `passwordSchema` exported from `identity/` and used by both; lookup by the stored form (`users.email` unique index).
- **Test:** `admin accounts share the app normaliser and password rules` (5). Seen failing before the fix: yes.

### A-06-013 · P1 · The ingestion status took 152 s on the full catalog
- **Evidence (`flyleaf`, psql):** the catalog-totals query `COUNT(*)`-ed works, editions, authors, work_authors and raw_payloads: **152 s**, `shared hit=23.4M read=1.70M` (13 GB read). The maturity breakdown: **41 s cold / 2 s warm**, seq scan of `works`.
- **Fix:** totals from `pg_class.reltuples`, covers from `pg_stats.null_frac`, the maturity breakdown from `pg_stats` most-common-value frequencies; a table never analysed (`reltuples = -1`) is counted exactly. Locked overrides, pending authors and the dedupe queue stay exact (small). New response field `counts_are_estimates`; the page prefixes estimates with `≈`.
- **After:** `flyleaf`, the real function, 6 calls: **185 ms first, 16–22 ms warm**.
- **Accuracy (flyleaf_dev, statistics from 2026-09-24):** totals within 0.1 %, covers 0.08 %, maturity general +0.2 %, unclassified −0.06 %, mature −4.4 %, explicit −2.4 %. On `flyleaf` the statistics are stale (works `reltuples` 3.65M vs 3.20M exact; the stats counters were reset, so the last ANALYZE is unknown). Estimates are as fresh as the last ANALYZE. Only `npm run ingest -- --finalise` runs one (works, editions, authors, work_authors; not raw_payloads); a plain ingest pass ends without it → Part 15. I did not ANALYZE `flyleaf` here: it would change the planner inputs Part 02 tuned search on.
- **Test:** `ingestion status reads statistics, not full counts` (exact before ANALYZE, estimates after). Seen failing before the fix: yes (no flag).

### A-06-014 · P2 · CORS reflected any origin (A-05-022)
- **Fix:** `cors({ origin: config.corsOrigins })`: `CORS_ORIGINS` (comma-separated) or, by default, `APP_BASE_URL`'s origin only. The native app sends no `Origin`; the console is same-origin.
- **Test:** `CORS allows only configured origins`. Seen failing before the fix: yes.

### A-06-015 · P2 · Admin pages needed `script-src 'unsafe-inline'` (A-05-018)
- **Fix:** `sendAdminHtml` sets `default-src 'none'; script-src 'nonce-<16 random bytes>'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` and `Cache-Control: no-store` per response. Inline handlers became `addEventListener` on `data-` attributes; the login page has no script at all. The baseline for any other HTML is now script-free.
- **Shortcut:** `style-src` keeps `'unsafe-inline'`: the pages use hundreds of `style=""` attributes, CSS cannot execute script, and every value is escaped. Moving them to classes is cosmetic work for a 1–3-user console.
- **Test:** every page: `script-src` without `unsafe-inline`, every `<script>` tag carries the header's nonce, no `on*` attribute; `the nonce is new on every response`. `hooks-hardening` updated (see Behaviour changes). Seen failing before the fix: yes.

### A-06-016 · P2 · The server accepted the admin cookie on every path and from every origin (lead 2)
- **Analysis before the fix:** the hook read `flyleaf_admin_session` on any request. State-changing routes a browser would send the cookie to (`Path=/admin`): only `POST /admin/logout`, and `SameSite=Lax` kept it off cross-site POSTs. Every real action lived under `/v1/admin`, which the browser never sent the cookie to (hence A-06-004). So no working CSRF existed, but only because of browser cookie attributes, the same ones that broke the console.
- **Fix:** admin credentials (cookie, bearer, `X-Admin-Token`) count only on `/admin/…` and `/v1/admin/…`. For the cookie on an unsafe method the request must also carry an `Origin` whose host is this host; an absent Origin is refused (browsers send one on every POST). With `SameSite=Strict` that is two independent guards. Bearer and `X-Admin-Token` are not ambient and need neither. Every state-changing admin endpoint is POST (inventory checked; no GET writes).
- **Test:** `a cookie-authenticated write from another origin, or with no Origin, is refused` (incl. `https://admin.flyleaf.app.evil.example`), `ignores the cookie elsewhere and uses the lookup it is given`. Seen failing before the fix: yes.

### A-06-017 · P2 · The audit log was not append-only
- **Fix:** trigger `admin_audit_log_append_only` refuses UPDATE and DELETE (`insufficient_privilege`). No code path updates or deletes audit rows (checked).
- **Not guarded:** `TRUNCATE`, an owner-level operation no code issues; test resets rely on `TRUNCATE users … CASCADE`. **Recommendation:** run the API as a non-owner role without TRUNCATE (PRD §42 #14) → Part 15.
- **Test:** `is append-only: UPDATE and DELETE are refused by the database`. Seen failing before the fix: yes.

### A-06-018 · P2 · The audit-log listing sorted the whole table
- **Evidence (`flyleaf_dev`, 200k rows inserted in a rolled-back transaction):** unfiltered page: Parallel Seq Scan + top-N sort, **147 ms**, growing with the table; `subject_type` filter: bitmap + sort, 74 ms. The work detail's history filtered `subject_id` alone and could not use `(subject_type, subject_id)`. tasks.md claimed a `(created_at desc)` index that never existed.
- **Fix:** index `(created_at DESC, id DESC)` (0023); history query adds `subject_type = 'work'`.
- **After:** unfiltered **0.18 ms**, 5 buffers; `subject_type` 0.20 ms. The `action` filter already used its index (2 ms).

### A-06-019 · P2 · `openapi.yaml` lacked the REST audit-log and merges schemas
- **Evidence:** the spec strips `/v1`, so the HTML `GET /admin/audit-log` and `GET /admin/merges` (no schema) took the same path keys as the REST `GET /v1/admin/audit-log` and `/v1/admin/merges` and replaced them.
- **Fix:** every admin HTML route is `hide: true` (as Part 05 did for share pages). Regenerated: both REST operations appear with their parameters and schemas; the HTML entries are gone.
- **Test:** `contract.test.ts` (drift 0; every served route in the spec unless hidden).

### A-06-020 · P3 · Admin JWTs: `alg` not pinned, `exp` not required
- **Fix:** as for app tokens (A-04-004): `algorithms: ['HS256']`, `requiredClaims: ['exp', 'iat', 'sub']`.
- **Test:** `an admin token with another alg or without exp is refused`. Seen failing before the fix: yes.

### A-06-021 · P3 · A malformed admin cookie was a 500
- **Evidence:** `decodeURIComponent` of `flyleaf_admin_session=%E0` threw inside the auth hook, which must never reject.
- **Fix:** a malformed cookie is no session.
- **Test:** `a malformed session cookie is a guest, not a 500`. Seen failing without the fix: yes (mutation run: the fix reverted, the test fails).

### A-06-022 · P3 · `/admin/catalog/maturity?maturity=anything-else` was a 500
- **Fix:** an invalid filter shows the unfiltered list.
- **Test:** `an unknown maturity filter shows the unfiltered list`. Seen failing without the fix: yes (mutation run).

### A-06-023 · P2 · Weak tests
- No test drove the browser flow (cookie paths, CSRF), escaping, replay, revocation, the 2FA or login routes over HTTP, or re-ingest after an override; the route inventory listed `POST /v1/admin/auth/login`, `…/2fa/setup`, `…/2fa/verify` and `GET /v1/admin/catalog/works/:id` as untested. `admin-catalog.test.ts` asserted the lock row exists, never that it holds.
- **Fix:** `admin-security.test.ts` (74 tests), including the 15-route × 4-role matrix, HTML pages × {guest, app user, moderator, admin}, and an admin token on an app route (401).
- **Mutation checks:** see below.

### A-06-024 · P2 · D-04-2 implemented: bundled common-password list
- **Source:** SecLists `Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt` (the brief's "top-100000", renamed upstream), MIT, pinned to commit `c205c36a…` and SHA-256 `1472aafa…`; `scripts/generate-common-passwords.mjs` (`npm run passwords:generate`) checks both and writes `src/identity/common-passwords.data.ts` with source and licence in its header.
- **Filter:** entries ≥ 10 characters (the minimum; shorter ones never reach the list), stored NFC-lowercased with separators removed, the form `isCommonPassword` compares: **2,309** of 99,999, plus the 31 original hand-picked entries (Part 04 counted 32): **2,327** distinct. No network at signup.
- **Cost:** `Set` build ≈ **1.3 ms**, ≈ **150 KB** heap (+27 KB source string); a check ≈ 1.2 µs. Limits were 50 ms and 5 MB.
- **Used by:** signup, password reset (`passwordSchema`) and admin creation.
- **Known gap (by design of the separator rule):** `pass.word1` normalises to `password1`, which is under 10 characters and therefore not stored; it is accepted. The list catches the literal common passwords, not every decoration of short ones.
- **Test:** `the bundled list refuses listed passwords and accepts near misses`, `app signup refuses a listed password with 422`, `refuses a short or common admin password`. Seen failing before the fix: yes.

### A-06-025 · P2 · Admin catalog list: a full count on every page, a seq scan per search (deferred)
- **Evidence (`flyleaf`):** the maturity page's `count(*) … WHERE merged_into_id IS NULL` **4.3–5.8 s** per load; `?q=` is `title ILIKE … OR subtitle ILIKE … OR EXISTS(author)`, which defeats `works_title_trgm_idx`: Seq Scan, 208k buffers. `%`/`_` in `q` are not escaped (P3).
- **Plan:** a `UNION` of the title-trigram and author-trigram branches (subtitle dropped or given its own trigram index), an estimated or capped total ("1,000+"), LIKE-escaping. **→ Part 15** (about half a day with tests; admin-only traffic).

### A-06-026 · P2 · Merge, dismiss and undo are audited after they commit (deferred)
- `resolveQueueItem`/`undoMerge` run their own transactions; the route writes the audit row afterwards. A failed audit insert leaves an unaudited merge and a 500 for an action that happened. The maturity override is already atomic.
- **Plan:** pass an `audit(tx)` callback into both service functions and write the row inside their transaction. **→ Part 15.**

### A-06-027 · P2 · `MERGE_EDITIONS` and `MERGE_AUTHORS` ignore provenance locks (latent)
- Nothing locks edition or author fields yet; the §6.46 correction flow (and PRD §7.9's page-count example) will. Same fix as A-06-003. **→ whoever builds §6.46 corrections; tracked in Part 15.**

### A-06-029 · P1 · D-06-1 answered: merge, dismiss and undo carry a reason into the audit row
- **Before:** `resolve` took an optional reason (the console sent none); undo stored the fixed text "Reversed merge within 30-day window".
- **Rule implemented:** a pair a rule queued (stages 1-3) defaults to that rule (`stage 1: shared ISBN`, `stage 2: title + author`, `stage 3: probable fuzzy match`); a typed reason, a user-reported pair (stage 4, a manual merge: there is no other manual-merge path) and every undo need at least 10 characters after trimming, else **422 `reason_required`** (`field: reason`) with nothing written. The reason goes into the audit row (and, as before, into `dedupe_queue.dismiss_reason` / the merge record). Undo has a required JSON body `{ reason }`; the role check runs in `preValidation`, so a moderator still gets 403, not a 422 about the body. The console asks for the reason, prefilled with the rule. `api-client` `undoMerge(id, reason)`.
- **Interpretation (confirmed 26 Sep):** a typed reason on a rule-queued pair must also be 10+ characters (the untouched prefill always is); I read "manual merges" as stage 4.
- **Test:** `merge, dismiss and undo carry a reason into the audit log` (6: rule prefill stored, typed reason stored trimmed, short typed reason refused, stage 4 refused ×3 then stored, undo refused ×3 then stored, console prefill). Seen failing without the fix: yes (mutation runs).

### A-06-030 · P1 · D-06-2 answered: staff accounts cannot use the app login or refresh
- **Before:** an admin or moderator logged in to the app with the same password and no second factor.
- **Fix:** `IdentityService.login` verifies the password as before (same argon2 cost) and then refuses `role <> 'user'` with the **same 401 body** as a wrong password; the refresh `UPDATE` requires `role = 'user'`, so a token held from before a promotion fails with the generic 401 (no family revocation). PRD §27.5 "Separate authentication" row and the `admin-cli.ts` header now say staff use a separate personal account for the app.
- **Not changed:** forgot/reset-password still work for a staff email, so whoever controls a staff mailbox can set that account's password (they still need the TOTP). Worth a look with user administration (§27.5 Phase 2).
- **Test:** `staff accounts cannot use the app login` (2). Seen failing without the fix: yes (mutation runs).

### A-06-028 · P3 · `GET /admin/telemetry/budgets` is a JSON API under the HTML path
- Its comment says `/v1/admin/telemetry/budgets`. Left as is (client-visible path); it is moderator-gated and in the matrix.

### RL findings → Part 15
- **A-06-RL1 · P1** Admin login (`POST /v1/admin/auth/login` and the form `POST /admin/login`): no per-account or per-IP limit, no lockout or backoff. Once a password is known, the 6-digit code falls to online guessing (3 valid codes per 10⁶ each window). PRD §24.4 auth endpoints (10/min per account, 30/min per IP). Every failure is now audited with IP (A-06-008), so the limiter can also alert. Backup codes go through the same endpoint.
- **A-06-RL2 · P3** `POST /v1/admin/auth/2fa/verify`: no limit (needs an admin session).
- **A-06-RL3 · P2** `POST /v1/admin/dedupe/report` for signed-in app users: no limit; one account can fill the review queue (§24.4 writes 120/min).

## Mutation checks

Each key line removed, the named tests run, the file restored.

Run with `--maxWorkers=2` on `admin-security.test.ts`, one mutation at a time, each file restored byte-for-byte (checked).

| Mutation | Result |
|---|---|
| TOTP `UPDATE` without `last_totp_step < $step` | 2 fail (replay, older code) |
| Backup code `UPDATE` without `$hash = ANY(backup_codes)` | 1 fails (concurrent spend) |
| `lookupAdmin` without the `session_version` check | 1 fails (logout ends sessions) |
| `lookupAdmin` returns the token's role | 1 fails (demoted admin) |
| App account → 403 before the password check | 1 fails (same 401) |
| Hook without `isAdminPath` | 1 fails (cookie ignored elsewhere) |
| Cookie accepted without the Origin check | 1 fails (cross-origin write) |
| `decodeURIComponent` without try/catch (A-06-021) | 1 fails |
| `worksQuery.parse` instead of `safeParse` (A-06-022) | 1 fails |
| `escapeHtml` returns its input | 4 fail (merges, maturity ×2, audit-log pages) |
| `MERGE_WORKS` maturity without the lock | 1 fails |
| Gap-fill title without the lock | 1 fails |
| CORS `origin: true` | 1 fails |
| No 10-character check on typed reasons | 3 fail |
| No rule prefill | 1 fails |
| Staff allowed on app login | 1 fails |
| Staff allowed to refresh | 1 fails |
| SecLists list removed from the `Set` | 3 fail |

Not mutated: the append-only trigger (a migration; its test failed before 0023 existed) and the estimates path (its test failed before the flag existed).

## Performance

| Endpoint / query | Before | After | Plan notes |
|---|---|---|---|
| `GET /v1/admin/ingest/status` (`flyleaf`) | totals **152 s** + maturity 41 s cold / 2 s warm (psql) | **185 ms** first, **16–22 ms** warm (6 calls, real function) | six seq/index-only full scans, 1.7M buffers read → `pg_class`/`pg_stats` reads |
| Audit-log list, unfiltered (`flyleaf_dev`, 200k rows) | 147 ms | 0.18 ms | Seq Scan + top-N sort → Index Scan `admin_audit_log_created_idx`, 5 buffers |
| Audit-log list, `subject_type` | 74 ms | 0.20 ms | bitmap + sort → same index |
| `MERGE_WORKS`, 50k-row re-ingest batch (`flyleaf_dev`) | 11.7–15.1 s | 13.0–14.9 s | +1 `field_provenance` probe per row, +6–10 % buffer hits; noise-level |
| Admin request auth | JWT verify | JWT verify + 1 PK query (`users` ⋈ `admin_credentials`) | admin paths only; app requests no longer run the admin verifier at all (A-04-023's ~119 µs is gone for them) |
| Maturity page count / search (`flyleaf`) | 4.3–5.8 s / seq scan | unchanged | A-06-025, deferred |

All timings indicative only (8 GB dev machine).

## Behaviour changes

1. **Browser login** is a form `POST /admin/login` (303 to `/admin/merges`; failures re-render with 401/403). The session is two server-set cookies (`Path=/admin`, `Path=/v1/admin`), `HttpOnly; Secure; SameSite=Strict`, 2 h. Page script never sees the token.
2. The console's buttons work (they could not authenticate before).
3. A cookie-authenticated POST to an admin path without an `Origin` naming this host → 401. Bearer / `X-Admin-Token` callers are unaffected.
4. Admin credentials are ignored outside `/admin/…` and `/v1/admin/…`.
5. **Every admin request checks the database:** a demoted admin acts with the new role at once; a removed, deleted or disabled one gets 401. **Admin tokens issued before this deploy are refused** (no `sv` claim): sign in again.
6. **Logout ends every session of that admin**, not just the browser's cookie.
7. Admin login for an app account or unknown email: **401 `invalid_credentials`** (was 403 `admin_access_denied` for app accounts).
8. A TOTP code works once; a backup code works once, also under concurrency.
9. `POST /v1/admin/auth/2fa/setup` no longer changes the live secret; `…/verify` activates it (`400 no_pending_2fa` without a setup).
10. New audit actions `admin.login_failed`, `admin.2fa_verify_failed`, `admin.denied`, `admin.disabled`; `actor_id`, `actor_email`, `actor_role` may be null; `ip` and `user_agent` on every entry. UPDATE/DELETE on `admin_audit_log` fail.
11. `GET /v1/admin/ingest/status` returns statistics-based estimates with `counts_are_estimates: true` on an analysed database.
12. **Re-ingest keeps locked fields** (maturity overrides; any future locked work field).
13. **CORS:** only `CORS_ORIGINS` (default: `APP_BASE_URL`'s origin) get `Access-Control-Allow-Origin`.
14. **Common passwords:** 2,327 refused at signup, reset and admin creation (was 31). Existing hashes are unaffected.
15. Admin creation: email lowercased and trimmed, password NFC and subject to the app rules; `npm run admin -- create|disable`.
16. Admin HTML: nonce CSP, `Cache-Control: no-store`; other HTML's baseline CSP allows no script.
17. `openapi.yaml`: REST `GET /admin/audit-log` and `GET /admin/merges` now described; admin HTML routes hidden; audit item fields nullable plus `ip`/`user_agent`; ingest status gains `counts_are_estimates`. `@flyleaf/api-client` types updated to match.
18. **Resolve** needs a typed reason of 10+ characters for a user-reported pair or whenever one is typed (rule-queued pairs default to the rule); **undo** needs a body `{ "reason": "…" }` of 10+ characters. Otherwise 422 `reason_required`. `api-client` `undoMerge(id, reason)`.
19. **Staff accounts get 401 `invalid_credentials` on `POST /v1/auth/login`** (identical to a wrong password) and 401 on refresh. Existing app sessions of staff accounts end at the next refresh (≤ 15 min).
20. `FLYLEAF_TEST_WORKERS` caps vitest workers in `scripts/ci.mjs` (README §3c).

Inherited assertions updated to the spec (Rule 9):
- `admin.test.ts` › `rejects admin login for regular app users`: `/Admin access required/` → `401 invalid_credentials` (PRD §42 #13).
- `admin.test.ts` › `clears session cookie on logout`: one `Set-Cookie` string → both cookies (one per path) carry `Max-Age=0`.
- `dedupe.test.ts` › the admin HTTP end-to-end test: its stage-4 merge and its undo now send reasons (D-06-1 changed the request contract; the assertions are unchanged).
- `hooks-hardening.test.ts` › `admin HTML gets the baseline CSP` → admin HTML gets a nonce policy without `unsafe-inline` script, and the baseline has no `script-src` (Part 05 recorded this assertion as temporary).

## Decisions answered (26 Sep 2026)

- **D-06-1 → yes**, implemented as A-06-029.
- **D-06-2 → yes**, implemented as A-06-030.

The original questions, for the record:

### D-06-1 · Should merge, dismiss and undo require a reason?
PRD §27.5 lists "reason" among what every audit entry captures. The maturity override requires one; `resolve` takes an optional `reason` (the console sends none), and undo hard-codes "Reversed merge within 30-day window".
- **Option A (recommended):** require `reason` (≥ 3 chars) on resolve and add a required body to undo; the console prompts. Client-visible (422 without it).
- **Option B:** keep optional; record the rule applied (stage and match rule) as the reason automatically.
- Answered: A, with a 10-character minimum for typed reasons and the rule as the prefill for stage 1-3 pairs (A-06-029).

### D-06-2 · May staff accounts sign in to the app?
Admins and moderators are `users` rows; app login (`/v1/auth/login`) accepts them with the same password and no second factor, issuing an app session (which cannot reach admin routes: A-04-003). §27.5 says "Admin login is distinct from the app account".
- **Option A (recommended):** refuse app login and refresh for `role IN ('admin','moderator')`; staff keep a separate personal account.
- **Option B:** allow (today's behaviour); staff passwords are then exposed to the app endpoint's weaker limits.
- Answered: A.

## Deferred (with reason and owner part)

| Item | Owner |
|---|---|
| A-06-RL1 … RL3 rate limits (admin login is P1) | Part 15 |
| A-06-025 admin catalog search/count seq scans, LIKE escaping | Part 15 |
| A-06-026 audit row in the same transaction as merge/undo/resolve (pass an `audit(tx)` callback into `resolveQueueItem`/`undoMerge`) | Part 15 |
| Every ingest pass ends with `ANALYZE` on the tables it loaded, `raw_payloads` included; today only `--finalise` runs it, on four tables. `flyleaf`'s statistics are stale (works `reltuples` 3.65M vs 3.20M exact), and the ingestion status now reads them (A-06-013) | Part 15 |
| Staff password reset through the app's forgot-password flow (A-06-030 note) | §27.5 user administration |
| A-06-027 locks in `MERGE_EDITIONS` / `MERGE_AUTHORS` | §6.46 corrections; tracked in Part 15 |
| A-06-017 TRUNCATE guard via a non-owner API role (§42 #14) | Part 15 |
| Moderators rotating their own 2FA (A-06-010 note) | when user administration (§27.5 Phase 2) lands |
| `jobs.test.ts` teardown errors under load: pg-boss `stop({ graceful: false })` does not wait for in-flight handlers before PGlite closes (see CI) | Part 15 |
| `npm audit`: 7 moderate advisories where `ci.mjs`'s comment says 4 (gate is `high`; none added here) | Part 15 |

## CI

Green in two parts, as in Part 03b. Every step of `scripts/ci.mjs` ran against the final tree.

1. **Your terminal**, `FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`: api-client build ✅, api typecheck ✅, spec check ✅ (drift 0), API tests **1090 / 1091** in 665 s (53 files). The one failure was `contract.test.ts:87`: its hidden-route list still held only Part 05's two share pages. CI stopped there.
2. **Fix:** each of the seven hidden admin routes was confirmed to render HTML, or to answer a form post with a redirect or an HTML page; none is JSON. They were added to that list by exact name, with the reason.
3. **Re-run here, `--maxWorkers=1`:** `contract.test.ts` + `jobs.test.ts`, 21 / 21.
4. **Remaining steps here, as `ci.mjs` defines them** (Docker up, `flyleaf-pg` on 5432): api build ✅, api audit (`--audit-level=high`) ✅ (7 moderate, 0 high; the `ci.mjs` comment says 4 moderate, so the moderate count has grown since that comment; this part added no dependency), mobile typecheck ✅, mobile tests ✅ 100 / 100, migrations on a real Postgres (`flyleaf`) ✅. `0023` had also been applied to `flyleaf_dev`, and re-running on both was a no-op.

So: API 1091 / 1091 (1090 in your run plus the fixed contract test), mobile 100 / 100. Two earlier full runs from this session were stopped by the machine's memory pressure and are not counted.

**Not fixed, recorded:** under full-suite load, `jobs.test.ts` logs `_PostgresSendReadyForQueryIfNecessary` errors after its tests pass. Teardown already stops pg-boss before closing PGlite, but `stop({ graceful: false })` resolves without waiting for a job handler that is still running queries on the same PGlite connection. Three isolated runs at 1 worker showed none, so no fix could be seen working, and it is not a teardown-order change → Part 15 (wait for in-flight handlers, e.g. a graceful stop with a short timeout, before closing the client).
