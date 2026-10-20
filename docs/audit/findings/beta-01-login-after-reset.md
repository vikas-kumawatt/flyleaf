# Beta 01 · "Email or password is incorrect" after a password reset

Reported from beta testing (0.1.0-beta.1), 20 Oct 2026. Branch `fix/login-after-reset`.

**Report:** forgot password → reset from the emailed link → sign out → sign in with the new password. The app said "Email or password is incorrect" every time.

## Root cause

The server was never refusing the new password. The test `apps/api/src/test/login-after-reset.e2e.test.ts` runs the whole path against the production wiring by both reset routes, and the new password signs in.

The message was wrong. `auth.tsx` showed "incorrect" for every failure of `signIn()`, and `signIn()` failed for more than a bad password:
- the login call itself: a 429, 5xx, or no connection;
- every step after the server had accepted the password (`/v1/me`, the cache, the guest shelf migration).

The failure the beta could actually hit is a **429 from the anonymous per-IP tiers**:
- Since Audit 15, production enforces the Global tier (PRD §24.4), which allows 200 requests an hour per IP for anonymous callers, and `POST /v1/auth/login` counts against it.
- Everything a signed-out phone sends shares that budget: search, book pages, shelves, and telemetry.
- Telemetry re-sent a failed batch every 15 s with no backoff. That included a 429 from `events:ip` (120 an hour), and a batch the server would never accept (more than 100 events, which happens after a stretch offline).
- That retry loop also survived sign-out.
- An hour of ordinary guest use therefore used up the address's budget. Each sign-in attempt, refused requests included, counted against it too. So every retry was refused for up to an hour, and each refusal read as a wrong password.

The e2e test reproduces this:
- with the old `events.ts`, the phone's address goes over the Global tier within the hour, and guest browsing and sign-in both get 429;
- with the new one, it sends 121 batches and sign-in works.

The suspected cause, guest data making `migrateToServer` throw, does not hold: every failure inside it was already caught. It did have two real problems:
- sign-in waited on it (a slow network held the sign-in);
- it dropped a guest book on any 4xx (403, 409).

## Fix

| Where | Change |
|---|---|
| `apps/mobile/src/lib/authErrors.ts` (new) | "Incorrect" only for 401 `invalid_credentials`; 429 → "Too many attempts. Try again in N minutes." (from `Retry-After`); no response or 5xx → "We couldn't reach the Flyleaf server…". None depends on the email existing. Used by sign-in, forgot, and both reset screens |
| `apps/mobile/src/lib/sessionFlow.ts` (new), `session.tsx` | Only the credentials call can fail a sign-in. `/v1/me`, cache, saving the user and the guest migration are best-effort; the migration runs in the background. Sign-out cancels an in-flight migration, clears tokens, cache and telemetry even when the server is unreachable. A refused refresh token does the same |
| `apps/mobile/src/lib/guest.ts` | `migrateToServer` never rejects. A book is dropped only for 404/422 (that work can never be added); 401/403/409/429/5xx/network keep it. `cancelMigration()` stops a run at the next book |
| `apps/mobile/src/lib/events.ts` | Batches of at most 100; 429 waits for `Retry-After`; no response, 408 or 5xx back off exponentially (to 10 min); any other 4xx drops the batch; the buffer is bounded; `resetTelemetry()` on sign-out (a send in flight is not re-queued into the next session) |
| `apps/mobile/src/lib/api.ts` | `logout()` always clears the tokens, whatever a hook or the server call does |
| `apps/mobile/app/auth.tsx` | The in-app reset fields no longer auto-capitalise or autocorrect (Android's default `sentences` could change the first letter of the new password, which the sign-in field then did not) |

## Owner decision

**D-B01-1:** should `POST /v1/auth/login` (and register) count against the anonymous Global tier?
- The login route has its own limits: 10/min per email and 20/min per IP.
- Signing in is how a reader leaves the anonymous budget.
- Under CGNAT or on shared Wi-Fi, many readers share one address.

**Not changed here:** the client no longer spends the budget on its own, and the message is now honest.

## Mobile `npm audit` (34: 1 critical, 22 high, 11 moderate)

Triage rule: is the vulnerable code in the shipped app (the JS bundle or a native module), and can it be reached there? Fixes must stay on SDK 57 (`npx expo install --check`, SL-00).

**Reachable, mitigated in this branch:**
- **decode-uri-component ≤ 0.4.2** (moderate, GHSA-vcc3-ghjq-m6fr), through expo-router → query-string 7.
  - `getStateFromPath` parses the query of every incoming link with it, so a link anyone can send reaches it.
  - Measured in Node: 3 KB of `%E0%A4` blocks `query-string.parse` for 17 s, 6 KB for 96 s.
  - There is no SDK 57-compatible fix. The only patched release (0.5.0) is ESM-only, which query-string 7 `require()`s, and `npm audit fix --force` wants expo-router 58 (SDK 58).
  - Mitigation: `+native-intent.tsx` drops every query parameter that `decodeURIComponent` rejects before the router sees the link (`withoutMalformedQuery`, in `appLinks.ts`). Well-formed parameters never reach the slow path.
  - Upgrade properly with SDK 58.

**Not reachable in the shipped app.** Each one is build, CLI, dev-server or prebuild tooling:

| Advisory | Severity | Path | Why not reachable |
|---|---|---|---|
| shell-quote 1.8.4–1.10.0 | critical | react-native → react-devtools-core | Only `react-devtools-core/dist/standalone.js` (the desktop DevTools UI) uses it; the on-device backend does not, and RN loads devtools under `__DEV__` only |
| node-forge ≤ 1.4.0 | high | expo-updates → @expo/code-signing-certificates; @expo/cli | Used by `expo-updates/cli` (generating and configuring code-signing keys on the developer's machine). The app verifies update signatures natively |
| source-map-js < 1.2.2 | high | @expo/metro-config → postcss | Metro bundling |
| braces, micromatch, brace-expansion | high | metro-file-map, glob | Bundler / CLI file matching |
| metro, metro-config, metro-transform-worker, @expo/metro*, @react-native/metro-config, @react-native/community-cli-plugin | high | metro | The bundler and dev server |
| react-native, react-native-reanimated, react-native-worklets, @react-native/virtualized-lists | high | — | Flagged only because they depend on the metro packages above (and each other); no advisory against their runtime code |
| expo, expo-updates, @expo/cli | high | — | The same: through @expo/cli, node-forge, metro |
| uuid < 11.1.1 | moderate | expo-sharing → @expo/config-plugins → xcode | Config plugins run at prebuild; the app's ids come from expo-crypto |
| @expo/config, @expo/config-plugins, @expo/prebuild-config, @expo/inline-modules, @expo/local-build-cache-provider, xcode, expo-sharing | moderate | — | Prebuild / config tooling, via xcode → uuid |
| query-string, expo-router | moderate | — | The decode-uri-component entry above |

`npm audit fix` (without `--force`) was not run. It re-resolves dozens of unrelated Expo packages, one of them from SDK 58 (`@expo/log-box-utils` 58.0.2). That is too much change for a beta fix, and none of it reaches the app. It belongs in the SDK 58 upgrade.

`npx expo install --check`: dependencies up to date. That was run with `EXPO_OFFLINE=1`, against SDK 57's bundled list, because the sandbox's proxy refuses `api.expo.dev`. The lockfile is unchanged.
