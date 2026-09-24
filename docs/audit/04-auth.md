# Audit Part 04 — Auth (FN-60 … FN-66)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §25 (all), §26.6 (children), §6.3–6.6 (sign up, log in, reset, verify), §24.4 (auth rate limits), §42 threat model, §34.5. Architecture §3.3 and §7.

Code: `apps/api/src/identity/index.ts`, `identity/common-passwords.ts`, `platform/index.ts` (`config`, `PgRateLimiter`), `platform/mail.ts`, `app.ts` (auth hook), `server.ts`, and migrations `0005_auth.sql` and `0007_auth_tokens.sql`. Tests: `identity.test.ts`, `hooks.test.ts`.

## Confirmed leads, verify and fix

1. **`JWT_SECRET` silently falls back to a hard-coded dev secret in production.** `config.jwtSecret = process.env.JWT_SECRET ?? 'flyleaf-dev-secret-…'`. In production (`NODE_ENV=production`) a missing or short (< 32 bytes) secret must stop the process at boot with a clear message. Anyone who reads this public repo could otherwise mint tokens. **P0.**
2. **`trustProxy: true` by default** in `buildApp` and `server.ts`. Unless the API only ever sits behind Caddy, any client can set `X-Forwarded-For` and pick its own IP, which defeats every per-IP limit. Decide how it should be configured (e.g. `TRUST_PROXY` env, default off, on in the deploy config) and test that a spoofed header doesn't change the rate-limit bucket when proxy trust is off.
3. **Unverified accounts** (PRD §6.6 `[ASSUMPTION]` and the §25 roles table): "cannot review, comment or follow". Nothing enforces this today. Record it as `DECISION NEEDED` with a recommendation (it affects existing test fixtures that never verify email). Don't implement it without my go-ahead.

## FN-60 / FN-61 / FN-62 — users, passwords, register, login, age gate

- **Email normalisation**: case, surrounding whitespace, unicode lookalikes. `Alice@X.com` and `alice@x.com` must be one account. Check the unique index is on the normalised form. **Username** too: case-insensitive uniqueness, reserved words (server list vs the mobile list in SL-22 must match), length bounds, allowed characters.
- **Passwords**: 10-character minimum, the common-password list, and a **maximum length**. There's a 1 MB body limit, and hashing a 1 MB password with argon2 is a cheap CPU DoS; cap it around 256–1,024 characters. Check unicode normalisation (NFC vs NFD passwords) and argon2 parameters against current OWASP guidance.
- **DOB / 13+ gate**: exactly-13-today in the user's vs the server's timezone, 29 Feb birthdays, future dates, dates before 1900, and invalid strings. What happens to someone who is under 13? PRD §26.6: the attempt must not leave a partial account behind.
- **Enumeration**: does register reveal "email taken"? Compare with the PRD's stance. Login must take the same time for "no such user" and "wrong password" (verify a dummy hash when the user doesn't exist). Measure both.
- **Deleted users** (`users.deleted_at`): can they log in, refresh, or does `lookup()` still return them as a viewer for existing access tokens? Every path must treat them as gone.
- **Login rate limits** per PRD §24.4 (10/min per account, 30/min per IP, 20/min per IP anonymous). Check the buckets exist and that their keys use the account **and** the IP. Record gaps as `RL`, to be fixed in Part 15.

## FN-63 / FN-64 — JWT and rotating refresh with reuse detection

- Access token: 15 min expiry, `aud`/`iss` checked, `alg` pinned (reject `none` and RS/HS confusion), `exp` enforced, and clock skew handled. An **admin** token must never authenticate an app route or the reverse (the FN-90 claim). Test both directions.
- Refresh: opaque, hashed at rest, rotates on every use, 60-day expiry, `family_id` revocation on reuse. **Race:** two concurrent refreshes with the same token, which the mobile app will produce when two requests 401 at once (see Part 07, SL-04). Does the second one revoke the whole family and log the user out? Is the rotation a single atomic `UPDATE … WHERE used_at IS NULL RETURNING`? Decide on a short grace window vs strict revoke and record it. Strict is fine only if the client is guaranteed to single-flight.
- Logout revokes the family. `logout-all` revokes all families. Note in the findings that access tokens stay valid until expiry, and whether that's acceptable per the spec.

## FN-65 — email verification and password reset

- Tokens: random ≥ 128 bits, hashed, single-use, expiring (24 h verify; check the reset expiry), and invalidated when a new one is issued. Reset **revokes all refresh families** (claimed). Test it.
- `forgot-password` always returns 200 (no enumeration) **and** is rate limited per email and per IP. `resend-verification` 1/60 s (claimed).
- Links in the email use a configurable base URL, not a hard-coded `https://flyleaf.app` in dev.
- The email body must not include anything besides the token (no password, no internal id).

## FN-66 — sessions list and per-device revoke

- Revoking another user's family returns 404, not 403. Revoking the **current** session: what happens to the caller? The `device` string from User-Agent must be truncated and sanitised. `lastUsedAt` must be accurate after rotation.

## Performance

- Measure login and register latency (argon2 dominates by design) and check they don't block the event loop: `@node-rs/argon2` async vs sync. Run 20 concurrent logins while measuring `GET /v1/works/:id` latency at the same time. If unrelated requests stall, it's P1.
- The auth hook runs on **every** request. Measure its cost. It also tries `verifyAdminToken` on every bearer token before the app lookup (`app.ts`). Is that extra JWT verify needed on app routes?

## Deliverables

`docs/audit/findings/04-auth.md`, tests, fixes, and audit lines under FN-60…66.
