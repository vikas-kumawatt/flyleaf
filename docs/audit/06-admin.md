# Audit Part 06 — Admin console (FN-90, FN-91, FN-92, FN-93)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §27.5 (**[LOCKED]** admin console), §27 generally, §42 threat model, §7.8 maturity (**[LOCKED]**), §7.9 provenance (**[LOCKED]**). Architecture §3.7.

Code: `apps/api/src/admin/{auth,totp,routes,dedupe,catalog,catalog-routes}.ts`, `http.ts` (`requireAdmin`/`requireModerator`), `app.ts` (admin detection in the auth hook), migration `0009_admin_auth.sql`, the catalog ingest's provenance handling, and tests `admin.test.ts`, `admin-catalog.test.ts`.

## Confirmed leads, verify and fix

1. **The admin session cookie is set by page JavaScript** (`routes.ts`: `document.cookie = 'flyleaf_admin_session=' + token + '; path=/admin; max-age=7200; SameSite=Lax'`). So it is **not `HttpOnly`** (any XSS on an admin page can steal a full admin token) and **not `Secure`**. Set it server-side on the login response with `HttpOnly; Secure; SameSite=Strict; Path=/admin`. Keep `Secure` off only for `http://localhost` in development. **P0.**
2. **The cookie is accepted on every route, not just `/admin`.** The auth hook in `app.ts` reads `flyleaf_admin_session` from any request's `Cookie` header. Together with `cors({ origin: true })`, work out whether a malicious page can make an admin's browser perform authenticated admin actions (CSRF). Check every state-changing admin endpoint for: method (never GET), CSRF protection (token or strict `SameSite` plus an `Origin` check), and whether it accepts the cookie at all. Fix accordingly.

## FN-90 — admin auth with 2FA

- The TOTP implementation (`totp.ts`): RFC 6238 test vectors (add them if absent), ±1 step drift only, constant-time comparison, and **replay protection**: the same code accepted twice within its 30 s window is a finding. Store the last accepted step per admin.
- Backup codes: hashed, **single-use** (test that reuse fails), and are a code's attempts rate limited?
- **Brute force**: password and TOTP attempts limited per admin and per IP, and a lockout or backoff with an audit entry. A 6-digit code without limits can be brute-forced online.
- Token isolation both ways (the `aud: 'flyleaf-admin'` claim): an app token on admin routes → 401/403; an admin token on app routes → treated as a guest, never as a user.
- Admin token expiry, and how an admin is revoked or disabled (and whether a disabled admin's live token keeps working).
- The bootstrap/creation path for the first admin: is it a script? Does it print secrets to logs?

## FN-91 / FN-92 — merge review UI, maturity override, ingestion dashboard

- **Role gating on every route, both the REST and the HTML variants**: a moderator can read the queue and audit trail but not merge, undo or override. Build this from the route inventory and test every admin route × {none, app user, moderator, admin}.
- **XSS**: every interpolation in server-rendered HTML goes through `escapeHtml`. Check attribute contexts, `href`/`src` (a `javascript:` URL in data), and JSON embedded in inline `<script>`. Seed a work titled `"><img src=x onerror=alert(1)>` and a reason containing `</script>` and check every page.
- **Maturity override** locks `field_provenance` (`is_locked = true`, `provider = 'user'`). Then **prove the lock holds**: run the ingest normaliser/merge on a changed dump record for that work (use the ingest test harness) and check the override survives. If the ingest code doesn't check `is_locked`, that's P0 against [LOCKED] §7.9.
- The override requires a reason, and the reason is audited.
- **Ingestion status endpoint performance**: it reports catalog breakdowns (works, editions, authors, covers, raw payloads, maturity distribution). If those are `COUNT(*)`/`GROUP BY` over 3.2M+ rows per request, measure it on the real DB. If it takes more than 1 s, use `pg_class.reltuples` estimates, cache for ~60 s, or precompute in a job.

## FN-93 — audit log

- **Every** admin action writes an entry: login success **and failure**, 2FA failures, merge, undo, dismiss, override, and report actions. Failed or denied attempts matter most.
- **Append-only**: no route updates or deletes audit rows. Consider a DB-level guard (a trigger rejecting UPDATE/DELETE on `admin_audit_log`), and record it as a recommendation if you don't add it.
- Entries capture actor, target, reason, IP (see Part 04 on proxy trust: a spoofable IP in an audit log is a finding), UA and a payload diff. Check that payloads never contain secrets (TOTP seeds, tokens, password hashes).
- Querying the audit log with filters uses its indexes (`EXPLAIN`).

## Deliverables

`docs/audit/findings/06-admin.md`, the role × route test matrix, XSS tests, fixes, and audit lines under FN-90…93.
