# Audit Part 05 — Authorization and API contract (FN-70, FN-71, FN-72, FN-80, FN-81, FN-82)

**Read `docs/audit/00-method.md` first.** Use `docs/audit/route-inventory.md` from Part 01; this part depends on it.

Spec: PRD §25.3, §26.1–26.3, §11.3–11.4, §4.2 (guest), §24.1–24.3, §42. Architecture §4 and §6.

Code: `apps/api/src/authorization/index.ts`, every service that returns user data, `app.ts` (hook chain), `http.ts`, `contract/{schemas,generate,index}.ts`, `packages/api-client/src/*`, and tests `authorization.test.ts`, `hooks.test.ts`, `contract.test.ts`, `social-block-equivalence.test.ts`.

## Confirmed leads, verify and fix

1. **Review PATCH/DELETE return 403** to non-owners (`reviews/index.ts`: `ApiError.forbidden('forbidden', 'You can only edit/delete your own reviews')`). They must be 404, the same as a missing review. **P1.**
2. **`GET /v1/reviews/:id` ignores blocks and private accounts.** It only checks the review's own visibility, so a blocked user, or a stranger viewing a private account's public review, can read it. **P0.**
3. **`GET /v1/works/:id/reviews` filters blocks but not private accounts**, and doesn't consider the parent read's visibility. **P0/P1.** (SO-23 recently reworked ranking in this function. Don't undo that; fix the filtering.)
4. **The feed plugin is registered twice** (`app.ts`: once with prefix `/v1`, once without), so `/feed` exists alongside `/v1/feed`. Remove the unprefixed one unless something depends on it (grep the mobile app and client).
5. **`contract/generate.ts` keeps its own plugin list.** It omitted the feed until SO-21 and still omits `exportsPlugin`. The durable fix is to build the spec from `buildApp()` itself (with stub services), so a route can't exist without being in the spec. Do that, regenerate, and make sure `contract.test.ts` would catch a missing plugin.

## FN-70 / FN-71 / FN-72 — viewer argument, `canView()`, the cross-user suite

- Grep every service for methods that read another user's data **without** a `viewer` parameter, and every visibility check that doesn't go through `canView()`/`assertCanView()`. Hand-rolled SQL filters (`visibility = 'public' OR …`) are fine for list queries, but they must be **equivalent** to `canView`. Prove it: write a table-driven test that runs `canView` and the list query's SQL over the same fixture matrix and compares the results.
- **Pending follows** must never count as following, anywhere. Grep for every `follows` join and check it filters `state = 'accepted'`.
- **Build the full matrix.** The existing 43 tests cover reads. Extend them to every user-owned resource type:
  - resources: profile, reads list, single read, stats, reviews (single and list), shelves (single, items, by-slug, user list), followers/following, likes list, comments, activity/feed, imports, exports, sessions
  - viewers: the 8 viewer states × item visibility × account privacy (see `00-method.md`)
  - for each denial, assert the 404 **body is identical** to a random-UUID 404

  Make it table-driven so a new resource is one row. Everything that fails is a finding.
- **Write paths**: every mutation on someone else's resource returns 404 (not 403, not 200 with no effect). Enumerate them from the route inventory.

## FN-80 / FN-81 — route schemas, OpenAPI, typed client

- Every route has **request and response schemas**. A response schema also *strips* undeclared fields, so check the reverse problem too: fields the client needs silently missing because the schema omits them. Compare each service's return type with its response schema.
- Error responses (400/401/404/409/422/429) are declared on the routes that can return them.
- **Is the client actually "generated"?** tasks.md says FN-81 "typed client generated into `packages/api-client`". Check whether `types.ts`/`client.ts` are generated or hand-written. If hand-written, the claim is false (P3 docs), and the real risk is type drift: pick three routes and compare the client types field by field against `openapi.yaml`. Recommend (don't necessarily implement) `openapi-typescript` generation in CI.
- Every route in the inventory has a client method, or a documented reason not to (admin HTML, OG pages).

## FN-82 — hook chain

- The auth hook **never rejects** (guest fallback): an expired, forged, malformed or `alg:none` token, a token for a deleted user, or a huge header all become `viewer = null`, and a protected route then returns 401.
- **`x-request-id` is client-controlled** (`requestIdHeader: 'x-request-id'`) and ends up in logs and response headers. Validate or cap it (charset, ≤ 64 chars) so a client can't inject log lines or huge headers.
- The error handler: 500s never leak `err.message` or a stack; schema errors → 422 with a field; malformed JSON → 400; the 413 mapping works; unique/FK/check-constraint violations from Postgres map to 409/422 somewhere central rather than surfacing as 500. Grep for routes where a plain constraint violation can escape as a 500 and write a test for one.
- **CORS**: `origin: true` reflects any origin. Decide per the threat model (§42). The API uses bearer tokens (so permissive CORS matters less), **but** admin auth also accepts a cookie (see Part 06). Record the combined risk and fix it there.
- Security headers: `nosniff`, `X-Frame-Options`, and anything the threat model requires on HTML routes (CSP on the admin and OG pages).

## Performance

- The `canView` path for single resources does several sequential queries: profile, then block, then follow (`ReadingService.#checkRelationship` and friends). Measure the query count for `GET /v1/reads/:id`, `GET /v1/users/:id` and `GET /v1/reviews/:id`. If there are more than two queries for authorization alone, combine them into one relationship query shared by all services, and measure again.

## Deliverables

`docs/audit/findings/05-authorization-and-contract.md`, the matrix test file(s), fixes, the regenerated spec and client, and audit lines under FN-70…72 and FN-80…82.

## Decided in Part 04: D-04-1, restrict unverified accounts (implement here)

Answer: **yes, enforce it**. It's an authorization rule, so it belongs in this part's single policy layer, not scattered through handlers.
- One server-side check (`requireVerified`, or a capability in the same place as `canView`) on **creating reviews, comments and follows**. Refusal: 403 with a stable code `email_unverified`, which the client turns into a "verify your email" prompt. Reading, logging reads and shelving stay open to unverified accounts.
- Signing up again with an existing **unverified** email resends the verification email. The response must be **identical** to a fresh signup (same status, body and timing), so it doesn't reveal whether the account exists; Part 04 fixed the same leak on login.
- Test fixtures: add a verified-user helper rather than editing every test by hand. Add a test per gated action that fails when the check is removed.
- Add the gate to the 8-viewer matrix as a ninth viewer, "signed in, unverified".
