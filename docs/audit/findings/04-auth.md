# Audit 04 — Auth (FN-60 … FN-66)

2026-09-25 · CI **green** (433 s) · tests **894 API + 100 mobile → 927 API + 100 mobile** (+33 in the new `auth-audit.test.ts`; no test weakened or removed)

Databases: correctness on PGlite (new `src/test/auth-audit.test.ts`); latency, plans and data checks on **`flyleaf_dev`**. Machine: 8 GB, so **timings are indicative only**. No migration was added. `secure-design` was not triggered: this run was autonomous by instruction, and the audit itself is the security review of this area.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| FN-60 | users / refresh_tokens / profiles migrations | ⚠️ tables and indexes as claimed; `email`/`username` are `text` with app-side lowercasing, not `citext` as architecture §3.3 says; `deleted_at` exists but no path honoured it | A-04-007, A-04-011 |
| FN-61 | argon2id, common-password list, 10-char minimum | ⚠️ argon2id at OWASP minimum (m=19456, t=2, p=1); the "list" is 32 entries; no NFC normalisation; no maximum | A-04-009, A-04-015 |
| FN-62 | register, login, DOB gate | ⚠️ gate worked for plain cases but impossible dates were a 500 and pre-1900 passed; login timing revealed account existence; reserved usernames enforced only on mobile; login limit is per-email only | A-04-006, A-04-008, A-04-010, A-04-017 |
| FN-63 | 15 m JWT + rotating hashed refresh | ❌ an **admin** JWT authenticated app routes; `alg` not pinned; a token with no `exp` was accepted; rotation raced | A-04-003, A-04-004, A-04-005 |
| FN-64 | reuse → revoke family | ⚠️ sequential reuse revoked the family, but two concurrent uses both succeeded and forked the family | A-04-005 |
| FN-65 | verification + reset behind a sender | ⚠️ tokens 256-bit, hashed, expiring, superseded on reissue, and reset revokes all families (all tested); links hard-coded to `https://flyleaf.app`; reset token could be spent twice concurrently | A-04-013, A-04-014, A-04-024 |
| FN-66 | session list + per-device revoke | ✅ 404 for another user's family (not 403), `lastUsedAt` advances on rotation (now tested); the device label was unbounded raw User-Agent (fixed) | A-04-012 |
| (lead 1) | `JWT_SECRET` fallback | ❌ hard-coded public secret used in production | **A-04-001** |
| (lead 2) | `trustProxy: true` | ❌ any client could set its own `req.ip` | A-04-002 |
| (lead 3) | unverified accounts restricted | 🚫 nothing enforces it | A-04-016 (**DECISION NEEDED**) |

## Findings

### A-04-001 · P0 · `JWT_SECRET` silently fell back to a secret published in this repository
- **Where:** `apps/api/src/platform/index.ts:16` (`config.jwtSecret`)
- **Evidence:** importing the config in a child process with `NODE_ENV=production` and no `JWT_SECRET` exited 0. Every access **and admin** token is signed with this key, so anyone who read the repo could mint a token for any user id, or an admin token with any role.
- **Spec:** PRD §42.1 (secrets never in the repository), §42 #2.
- **Fix:** `resolveJwtSecret()`: in production a missing secret, one under 32 bytes, or the dev value itself throws at import, so the API and worker refuse to start with a message that says how to generate one. Non-production keeps the dev fallback (tests, bench).
- **Test:** `auth-audit.test.ts` › `JWT_SECRET at boot` (4 tests, three spawn a real process). Seen failing before the fix: yes (exit code 0).

### A-04-002 · P1 · `trustProxy: true` let any client pick its own IP
- **Where:** `app.ts:192` (`buildApp` default), `server.ts:25`
- **Evidence:** `X-Forwarded-For: 6.6.6.6` became `req.ip` = `6.6.6.6`. Today `req.ip` is written to `admin_audit_log` on admin login (`admin/routes.ts:76`), so the recorded IP was forgeable. Every per-IP limit Part 15 adds would be defeated the same way. No Caddyfile or deploy config exists in the repo, so nothing guaranteed a proxy in front.
- **Fix:** `TRUST_PROXY` env, **off by default**; `true` or a comma-separated IP/CIDR list switches it on (`parseTrustProxy`). `buildApp` defaults to off; `server.ts` passes the config value. Hop counts are not accepted (Fastify 5's type does not take them, and naming the proxy address is safer).
- **Test:** `proxy trust (A-04-002)` (3 tests). Seen failing before the fix: yes.
- **Deploy note:** behind Caddy, set `TRUST_PROXY=127.0.0.1` (or Caddy's address), otherwise every request appears to come from Caddy.

### A-04-003 · P1 · An admin JWT authenticated app routes
- **Where:** `identity/index.ts` `verifyAccessToken` (no `aud`/`iss` check); `admin/auth.ts` signs admin tokens with the same key and a `sub`.
- **Evidence:** `GET /v1/me` with `Authorization: Bearer <admin token>` → **200** as the admin's user. The FN-90 claim "stolen mobile app tokens cannot access admin routes" held in that direction (already tested in `admin.test.ts:261`), but the reverse did not: a 2-hour admin token acted as an app session that app `logout-all` cannot revoke.
- **Spec:** audit 04 lead; FN-90 isolation.
- **Fix:** app tokens now carry `aud: flyleaf-app`, `iss: flyleaf`, and verification requires both. Access tokens issued before the deploy fail verification once; clients get a 401 and refresh (15-minute window).
- **Test:** `rejects an admin token on app routes`, `an admin token does not authenticate an app route (A-04-003)`. Seen failing before the fix: yes (200).

### A-04-004 · P2 · `alg` not pinned and `exp` not required
- **Evidence:** `verifyAccessToken` accepted an HS512 token and a token with no `exp` (valid forever). `alg: none` was already rejected by jose.
- **Fix:** `algorithms: ['HS256']`, `requiredClaims: ['exp', 'iat', 'sub']`. Clock skew: tokens are issued and verified by the same process, so tolerance is 0. Revisit if a second instance ever runs.
- **Test:** 3 tests in `access token verification`. Seen failing before the fix: yes (HS512, no-exp).

### A-04-005 · P1 · Refresh rotation raced: two concurrent refreshes both succeeded
- **Where:** `IdentityService.refresh`, a `SELECT` then a separate `UPDATE`.
- **Evidence:** `Promise.allSettled([refresh(t), refresh(t)])` → 2 fulfilled. The family forked into two live chains, so a thief replaying concurrently with the victim was never detected (PRD §25.2: "reuse detection … is not optional").
- **Fix:** one transaction whose conditional `UPDATE … WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND <user not deleted> RETURNING` is the lock; the loser falls through to reuse detection. **Strict, no grace window**: the mobile client single-flights refreshes (`apps/mobile/src/lib/api.ts:288`). The known cost: if the rotated response is lost in transit (app killed, network drop after the server commits), the next refresh counts as reuse and the user signs in again. That is a UX cost, not a security one. A grace window would have to reissue into the same family, which re-creates the fork. Part 07 should confirm the single-flight also covers background tasks. Happy path is now 2 statements in one transaction instead of 1 + 2. Plan: `Index Scan using refresh_tokens_hash_idx` + `users_pkey` (flyleaf_dev).
- **Test:** `two concurrent refreshes with one token never both succeed`. Seen failing before the fix: yes.

### A-04-006 · P2 · Login response time revealed whether an email has an account
- **Evidence (flyleaf_dev, median of 22):** wrong password **16.8 ms** vs unknown email **4.3 ms** (no argon2 at all).
- **Spec:** PRD §6.4 ("never reveal whether the email exists"), §42 #13.
- **Fix:** an unknown (or deleted) email verifies against a dummy hash. After: **16.6 ms vs 16.9 ms**.
- **Test:** `login for an unknown email costs about as much as a wrong password`. Seen failing before the fix: yes (5.9 ms vs 42.6 ms over 3 runs). Timing-based; the threshold is 0.5× against a measured 4× gap.

### A-04-007 · P2 · Deleted users could log in, refresh and receive reset emails
- **Evidence:** with `users.deleted_at` set, `login` returned tokens and `refresh` rotated. **Latent:** nothing sets `deleted_at` yet (account deletion, PRD §25.4, is unbuilt), and `admin/auth.ts:238` already checked it.
- **Fix:** login, the refresh `UPDATE` and forgot-password exclude deleted users. `lookup()` stays stateless, so an access token already issued remains valid **up to 15 minutes**. Whoever builds deletion must also revoke all refresh families.
- **Test:** `a deleted user can neither log in nor refresh`. Seen failing before the fix: yes.

### A-04-008 · P2 · Impossible dates of birth were a 500; pre-1900 passed; age depended on server time zone
- **Evidence:** `POST /v1/auth/register` with `dateOfBirth: 2013-02-30` or `0000-01-01` → **500** (`new Date` rolled 30 Feb to 2 March, then Postgres rejected the `date`). `1899-12-31` → 201. `isAtLeast13` compared local-time fields of a UTC-midnight parse, so on a server west of UTC it was off by a day.
- **Fix:** strict calendar parse (≥ 1900) and UTC date comparison. 29 Feb birthdays turn 13 on 1 March (tested). Future dates fail the age check (422). An under-13 attempt leaves **no** user, profile, token or email behind (tested; validation runs before any write).
- **Test:** 3 unit tests plus 3 HTTP tests. Seen failing before the fix: yes (500, and 201 for 1899).
- **Note:** "today" is the UTC date. For a user near the date line the server and the device may disagree for a few hours on the birthday itself; the server decides.

### A-04-009 · P2 · No maximum password length; NFC and NFD forms of one password did not match
- **Evidence:** the lead's DoS premise is **disproved** by measurement: `@node-rs/argon2` pre-hashes, so hash and verify cost ~20 ms at 10, 1,024, 100,000 and 1,000,000 characters. Separately, a password registered as NFC (`caf` + U+00E9) failed login when typed as NFD (`cafe` + U+0301).
- **Fix:** 1,024-character cap (hygiene; in the contract schema too) and NFC normalisation before hash and verify (register, login, reset). Argon2 parameters (m=19 MiB, t=2, p=1) match the OWASP minimum; left unchanged.
- **Test:** `a password over 1,024 characters is rejected with 422`, `a password typed in NFD matches …`. Seen failing before the fix: yes (201; 401).

### A-04-010 · P2 · Reserved usernames were enforced only by the mobile client
- **Evidence:** `username: admin` through the API → 201. PRD §6.7 requires a blocklist.
- **Fix:** `RESERVED_USERNAMES` in `identity/index.ts`, identical to the SL-22 mobile list, checked in `usernameSchema`. A parity test reads the mobile file and fails if the lists drift.
- **Test:** `server list matches the mobile list`, `reserved username … is rejected`. Seen failing before the fix: yes.

### A-04-011 · P3 · Email/username normalisation: correct, but not as documented
- **Evidence:** the service lowercases and trims email and username before insert and lookup, and the unique constraints are on those stored forms. `Alice@Example.COM` then `aLiCe@example.com` → 409 `email_taken` (tested). The contract (`format: email`, username `^[a-z0-9_]{3,20}$`) rejects surrounding whitespace and uppercase usernames with 422 before the service runs; mobile trims and lowercases (`app/auth.tsx:121`). Unicode lookalikes (Cyrillic `а`, fullwidth `ａ`) fail the email format. `flyleaf_dev`: 0 case-duplicate emails, 0 case-duplicate usernames, 0 non-canonical emails.
- **Drift:** architecture §3.3 says `citext`; the columns are `text`. Correct only while every writer normalises: `createAdminUser` (`admin/auth.ts:410`) inserts the email as given, so a mixed-case admin email could coexist with a lowercase app account, and it does not NFC-normalise the password. **Routed to Part 06.**
- **Fix:** none here (no migration needed while writers normalise); behaviour pinned by test.

### A-04-012 · P2 · Session device label was the raw, unbounded User-Agent
- **Fix:** `deviceLabel()`: control characters replaced, trimmed, at most 200 characters.
- **Test:** `the device label is truncated and stripped of control characters`. Seen failing before the fix: yes.

### A-04-013 · P2 · A password-reset token could be spent twice concurrently
- **Evidence:** two concurrent `resetPassword(sameToken, …)` both returned ok; the last write chose the password.
- **Fix:** the token check stays first (so bogus tokens cost no argon2), then the burn is conditional (`… AND used_at IS NULL RETURNING`) inside the transaction; the loser gets 400. `verifyEmail` has the same shape but is idempotent, so it was left alone.
- **Test:** `a password reset token can be spent only once under concurrency`. Seen failing before the fix: yes.

### A-04-014 · P2 · Email links were hard-coded to `https://flyleaf.app`
- **Fix:** `APP_BASE_URL` env; default `https://flyleaf.app` in production and `http://localhost:8081` otherwise. Bodies carry only the token (no user id, no password): tested.
- **Note for Part 07:** the mobile app has no screen or deep-link route for `/verify-email` or `/reset-password` (`app.json` scheme `flyleaf`), so these links currently lead nowhere in the app.
- **Test:** `email links use the configured base URL and carry only the token`. Seen failing before the fix: yes.

### A-04-015 · P2 · The common-password list has 32 entries
- **Evidence:** `identity/common-passwords.ts`. PRD §6.3/§25.2 require a common-password list, and §42 #1 "breached-password checking at registration". 32 hand-picked strings do not meet that intent.
- **Fix:** **DECISION NEEDED D-04-2** (data source and licence).

### A-04-016 · P1 · Unverified accounts are not restricted
- **Evidence:** no route checks `users.email_verified_at`; an unverified account can review, comment and follow.
- **Spec:** PRD §6.6 (marked **[ASSUMPTION]**), §25.3 roles table, §42 #4.
- **Fix:** **DECISION NEEDED D-04-1**, not implemented, as instructed.

### A-04-017 · P2 · RL · Login has no per-IP limit
- **Evidence:** only `login:<email>` 10/min exists. PRD §24.4 wants 30/min per IP (authenticated) and 20/min per IP (anonymous), and §42 #1 names credential stuffing, which spreads across emails. → **Part 15.** (Needs A-04-002's `TRUST_PROXY` set in deployment to key on the real IP.)

### A-04-018 · P2 · RL · Register has no limit at all
- → **Part 15.** Each attempt costs one argon2 hash and, on success, an email.

### A-04-019 · P2 · RL · refresh, verify-email, reset-password and logout have no limit
- Tokens are 256-bit, so guessing is infeasible; these are PRD §24.4 "auth endpoints" limits. → **Part 15.**

### A-04-020 · P2 · RL · forgot-password is limited per email only
- `forgot_pwd:<email>` 5/15 min exists. No per-IP limit, so one client can mail-bomb many addresses. → **Part 15.**

### A-04-021 · P3 · RL · No unlock time or rate-limit headers
- PRD §6.4 "Locked after repeated failures with a clear unlock time", §6.3 "try again in N minutes", architecture §6 `X-RateLimit-*`. The 429 body has neither `Retry-After` nor a time. → **Part 15.**

### A-04-022 · P3 · RL · `rate_limits` grows by one row per distinct attempted email, with no cleanup
- → **Part 15** (sweep expired windows).

### A-04-023 · P3 · The auth hook verifies every app bearer token as an admin token first
- **Measured:** app verify **78 µs**, failed admin verify of an app token **119 µs** (jose throws on the audience), so ~200 µs of JWT work per authenticated request, 0.2% of the p50 budget. Not fixed. If wanted: `jose.decodeJwt` the `aud` and run only the matching verifier.

### A-04-024 · P3 · Mail timing and failure handling will matter once a real sender exists
- `forgotPassword` sends mail only when the account exists; with a network `EmailSender` that is a timing oracle. `register` sends after the commit, so a mailer error would be a 500 for an account that exists (retry → `email_taken`). Both latent with `ConsoleEmailSender`. Plan: send through a pg-boss job when the real sender is added.

### A-04-025 · P2 · Weak tests
- `hooks.test.ts` uses a fake `identityLookup`, so no hook test ever exercised the real verifier; that is why A-04-003/004 went unnoticed. The new tests go through `verifyAccessToken` and real routes.
- `listSessions … reflects rotation` checked only the count, not `lastUsedAt`; now covered.
- Mutation checks on the new code: see "Mutation checks" below.

### A-04-026 · P3 · tasks.md inaccuracies
- FN-62 "rate-limited login" means per-email only. FN-63's "Fastify's onRequest hook" also runs an admin verify first. FN-64/FN-65 test counts are stale. Corrected in tasks.md audit lines.

## Mutation checks

Each key line of the new code was deleted, and the relevant tests run, then the file restored (byte-identical).

| Mutation | Result |
|---|---|
| Refresh `UPDATE` without `used_at IS NULL` | 2 tests fail (concurrent refresh, sequential reuse) |
| `verifyAccessToken` without `audience` | 2 tests fail (admin token, unit and HTTP) |
| Login without the dummy verify | 1 test fails (timing) |
| Reset burn without `used_at IS NULL` | 1 test fails (concurrent reset) |
| Refresh `UPDATE` without the deleted-user `EXISTS` | 1 test fails (deleted user) |

## Performance

`flyleaf_dev`, API in-process on the 8 GB machine; indicative only. Script: `src/bench/auth-load.ts` (re-runnable).

| Endpoint / query | Before | After | Notes |
|---|---|---|---|
| `POST /v1/auth/login`, wrong password vs unknown email (median, sequential) | 16.8 / **4.3** ms | 16.6 / 16.9 ms | A-04-006; argon2 dominates by design |
| `GET /v1/works/:id` (cached) idle | — | p50 0.7 · p95 1.1 · max 4.0 ms · loop-delay p99 1.7 ms | baseline for the next row |
| `GET /v1/works/:id` during 20 concurrent logins | — | p50 5.0 · p95 15.2 · max 26.1 ms · loop-delay p99 12.4 ms | argon2 is async (`@node-rs/argon2` on the libuv pool); no stall. The rise is CPU contention from 4 hashing threads, not blocking. **Not P1.** |
| `POST /v1/auth/login` under 20-way load | — | p50 242 · p95 335 ms · 88 logins/s | throughput capped by the 4-thread libuv pool; per-IP limits (Part 15) bound it anyway |
| Refresh rotation | 1 SELECT + tx(UPDATE, INSERT) | tx(UPDATE…RETURNING, INSERT) | Index Scan `refresh_tokens_hash_idx` + `users_pkey` |
| Auth hook JWT work per bearer request | — | 78 µs app + 119 µs admin | A-04-023 |

## Behaviour changes

1. **Production refuses to boot** without a private `JWT_SECRET` of ≥ 32 bytes (API and worker both import the config).
2. **`TRUST_PROXY` must be set behind a proxy**; otherwise `req.ip` is the proxy's address. Default off.
3. App access tokens carry `aud: flyleaf-app` and `iss: flyleaf`; tokens without them, with another `alg`, or without `exp` are treated as guest (401 on protected routes). Tokens issued before the deploy stop working once; clients refresh.
4. Admin tokens no longer authenticate app routes.
5. Two concurrent refreshes with one token: one succeeds, the other gets **403 `token_reused`** and the family is revoked (previously both succeeded).
6. Deleted users get 401 on login and refresh, and no reset email.
7. `dateOfBirth` must be a real date on or after 1900-01-01: `422 invalid_field` "Enter a real date of birth." (was 500 or 201).
8. Passwords over 1,024 characters: 422 on register and reset (contract `maxLength: 1024`, OpenAPI regenerated).
9. Passwords are NFC-normalised before hashing and verifying. A stored hash of a password containing NFD combining characters would no longer verify; none can exist yet outside dev data.
10. Reserved usernames: 422 `That username is reserved.`
11. Session `device` is at most 200 characters with control characters removed.
12. Email links use `APP_BASE_URL` (dev default `http://localhost:8081`).
13. Concurrent reuse of one reset token: the second gets 400 `invalid_or_expired_token`.

## Decisions needed

### D-04-1 · Unverified accounts: restrict now? (A-04-016)
PRD §6.6 [ASSUMPTION] and §25.3 say unverified accounts cannot review, comment or follow. §6.4 says log-in is allowed with a banner.
- **Option A (recommended):** enforce server-side with one helper (`requireVerified(viewer)` returning 403 `email_unverified`, which reveals nothing about anyone else) on create-review, create-comment and follow/request, plus `emailVerified` on `/v1/me` for the banner. Test fixtures: `interaction-fixtures.ts` direct inserts would set `email_verified_at = now()` by default, and tests that register through `IdentityService.register` and then post would verify first or use a fixture flag. Bench seed users would be marked verified. About half a day, mostly fixture churn.
- **Option B:** keep it unenforced until launch, with a DB-level default for existing rows. Cheaper now, but it becomes a behaviour change for real users later.
- **Option C:** drop the assumption from the PRD.
- Related PRD §6.3 edge case: "email exists but unverified → resend verification rather than error". Today register returns 409 `email_taken` either way. If A is chosen, have register return 409 `email_unverified` and resend (rate-limited 1/60 s), and never issue tokens for the existing account.

### D-04-2 · Which common-password list? (A-04-015)
- **Option A (recommended):** bundle a public list filtered to ≥ 10 characters (e.g. SecLists "10-million-password-list-top-100000", MIT, or NCSC top 100k), a few thousand entries, as a data file loaded into the existing `Set`. No network at registration.
- **Option B:** HIBP k-anonymity range API at registration: best coverage, but adds an outbound dependency and a failure mode to sign-up.
- **Option C:** A now, B later.

### Recorded (decided, reversible)
- **Refresh reuse: strict, no grace window** (A-04-005). Reversal plan if Part 07 finds the client cannot guarantee single-flight: a 10–30 s window in which a just-used token returns the *same* successor instead of revoking. That needs storing the successor encrypted or re-deriving it; not worth it while the client single-flights.
- **Access tokens are not revoked by logout, logout-all, session revoke or password reset**: they expire within 15 minutes. That is by design in PRD §25.2 (stateless, 15 min) and accepted. Tested: revoking the current session ends refresh while the live access token keeps working until expiry.
- **Registration reveals "email already registered"** (409 `email_taken`). PRD §6.3 explicitly requires offering log-in/reset for an existing email, so this is the accepted trade-off. Login and forgot-password do not reveal it.

## Deferred (with reason and owner part)

| Item | Owner |
|---|---|
| A-04-017 … A-04-022 rate limits (RL) | Part 15 |
| A-04-011 `createAdminUser` does not normalise email or password | Part 06 |
| A-04-014 no mobile route for verify/reset links; A-04-005 single-flight coverage | Part 07 |
| A-04-023 hook double verify (P3, measured negligible) | optional, Part 15 |
| A-04-024 mail through a job queue when a real sender lands | whoever adds the sender (Part 15 to track) |
| Account deletion must revoke all refresh families (A-04-007) | §25.4 implementation |
| Docs: PRD §25.2 and architecture §7 amended to list `exp`, `aud`, `iss` claims; architecture §3.3 `citext` vs `text` left as recorded drift | done here / Part 15 |
