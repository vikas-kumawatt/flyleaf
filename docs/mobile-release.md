# Beta build of the mobile app against the live server

An ordered checklist for the first beta APK (and every one after it). It is written for **a phone browser plus one laptop terminal**: everything marked 📱 works from the phone's browser; everything marked 💻 is typed on the laptop, from `apps/mobile` in the repo.

Server: `https://flyleaf-vk.koreacentral.cloudapp.azure.com` (Azure's name for the VM; no custom domain yet). Below it is `<host>`.

---

## What the repo already does (no action)

| | Where | What |
|---|---|---|
| API address per build profile | `eas.json` › `build.<profile>.env.FLYLEAF_API_URL` → `app.config.ts` → `extra.apiUrl` → `src/lib/apiBase.ts` | **development**: unset; the app talks to the laptop running Metro (`http://<Metro's address>:3000`, or `10.0.2.2:3000` on an emulator). **preview** (beta APK) and **production**: `https://<host>`. No address is written in app code (a test checks). On the EAS build server, a preview or production build without the address stops; a release bundle without one refuses to start rather than quietly talking to nothing. |
| Shared links | `PUBLIC_BASE` in `src/lib/api.ts` | Profile and shelf links shared from a beta build point at `https://<host>/@name` etc. (the API renders those pages), not at `flyleaf.app`, which does not exist yet. Development builds still share `flyleaf.app`. |
| Push (Android, FCM V1) | `app.json` › `android.googleServicesFile: ./google-services.json`, `expo-notifications` plugin (`defaultChannel: default`) | `app.config.ts` uses EAS's `GOOGLE_SERVICES_JSON` file variable when present, else a local `apps/mobile/google-services.json`, else drops the field so a local dev build without Firebase still builds (push is then absent). **The file is git-ignored** (root `.gitignore`, with `*firebase-adminsdk*.json`, the service-account key's usual name). On the build server a preview or production build without it stops. |
| App Links | `app.json` › `android.intentFilters` | Two filters with the same five paths (`/verify-email`, `/reset-password`, `/@…`, `/book/…`, `/u/…`), one on `flyleaf.app`, one on `<host>`, both `autoVerify`. iOS `associatedDomains` lists the same two hosts (iOS is not built). `app.config.ts` copies the hosts into `extra.appLinkHosts`, so `/@name` and `/book/:id` on either host open the right screen. |
| Versions | `app.json` › `version` `0.1.0-beta.1`; `eas.json` › `cli.appVersionSource: "remote"` (already on) + `autoIncrement: true` on preview and production | `version` is the Android **versionName** you see in Settings → Apps. **versionCode** lives on EAS, not in the repo: one counter per project, raised by 1 on every preview and production build, so each beta APK installs over the last one. A development build uses the current value without raising it. The first remote value starts at 1 (no `versionCode` in app.json). |
| Bundling on EAS | `apps/mobile/package.json` › `eas-build-post-install` | Builds `packages/api-client/dist` (git-ignored; Metro maps `@flyleaf/api-client` to it). Without it a release bundle fails with *Unable to resolve module @flyleaf/api-client*. Development builds never hit this because their JavaScript comes from Metro. |
| Licences | `src/lib/licences.ts` | satori 0.33.5 and @resvg/resvg-js 2.6.2 (MPL-2.0), which draw the share cards on the server (owner decision on Phase 5 B, item 4). |

**OTA updates** (`eas update`) do not read `eas.json`'s `env`. Publish to the beta with the address in the shell, for example `FLYLEAF_API_URL=https://<host> npx eas-cli update --channel preview --environment preview`, or create `FLYLEAF_API_URL` as a plain-text EAS variable in the `preview` and `production` environments once. An update published without it makes the app refuse to start. An update reaches only builds with the same `version` (`runtimeVersion: appVersion`).

---

## Decide before the first beta build

- **The package name is `app.flyleaf`.** Once testers install it and Firebase registers it, changing it means a new app on every phone (uninstall, reinstall, data gone), a new Firebase Android app and new App Links settings. It matches `ios.bundleIdentifier` in `app.json`, `ANDROID_APP_PACKAGE`/`IOS_BUNDLE_ID` on the server, and the fallback in `apps/api/src/web/public-pages.ts`; if it ever has to change, change all of them **before step 1**.

---

## The checklist

### 1. Firebase project and Android app 📱 ~10 min

1. <https://console.firebase.google.com> → **Create a project** (any name, e.g. `flyleaf`). Google Analytics is not needed; turn it off.
2. In the project: **Add app** → the **Android** icon.
3. **Android package name:** `app.flyleaf` (exactly `android.package` in `apps/mobile/app.json`). App nickname optional. **Leave the SHA-1 empty** (push does not need it).
4. **Register app** → **Download google-services.json**. Skip the remaining steps (the Gradle lines are added by Expo at build time).

- ✅ The phone has `google-services.json`, and its text contains `"package_name": "app.flyleaf"`.

### 2. The FCM V1 service-account key 📱 ~5 min

Firebase console → ⚙️ **Project settings** → **Service accounts** tab → **Generate new private key** → **Generate key**. A JSON file downloads (named like `<project>-firebase-adminsdk-….json`).

This file is a **private key** that can send push to your app. Keep it out of the repo, out of chats and out of shared folders. After step 4 it can be deleted from the phone (EAS keeps it; you can always generate a new one).

### 3. google-services.json → EAS, as a secret file variable 📱 or 💻

**From the phone (expo.dev):** <https://expo.dev> → your account → project **flyleaf** → **Project settings** → **Environment variables** → **Add variables**:
- Name `GOOGLE_SERVICES_JSON`
- Type **File**, choose the downloaded `google-services.json`
- Environments: **development**, **preview**, **production**
- Visibility **Secret**
- Save.

**Or from the laptop** (with the file copied into `apps/mobile`, where git ignores it):

```
npx eas-cli env:create --scope project --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret --environment development --environment preview --environment production
```

- ✅ `npx eas-cli env:list --environment preview` lists `GOOGLE_SERVICES_JSON` (value hidden).
- Each `eas.json` profile names its environment (`"environment": "preview"` etc.), which is how the build picks the variable up. On the build server it becomes a path, and `app.config.ts` passes it to `android.googleServicesFile`.

### 4. The FCM V1 key → EAS credentials 📱 or 💻

This is **not** an environment variable. It is stored with the app's Android credentials, which is where Expo's push service reads it to deliver to FCM.

**From the phone (expo.dev):** project **flyleaf** → **Project settings** → **Credentials** → **Android** → the application identifier **`app.flyleaf`** (or **Add application identifier** and enter it) → **Service credentials** → **FCM V1 service account key** → **Add a service account key** → **Upload new key** → choose the file from step 2 → **Save**.

**Or from the laptop:**

```
npx eas-cli credentials
```

→ **Android** → **production** → **Google Service Account** → **Manage your Google Service Account Key for Push Notifications (FCM V1)** → **Set up a Google Service Account Key for Push Notifications (FCM V1)** → **Upload a new service account key** → the file's path.

- ✅ The Credentials page for `app.flyleaf` shows an FCM V1 service account key.

The server needs no Firebase settings: it sends through Expo's push service (`PUSH_DRIVER='expo'`). `EXPO_ACCESS_TOKEN` in `/etc/flyleaf/flyleaf.env` is needed only if you turn on *Enhanced Security for Push Notifications* for the project.

### 5. Build the beta APK 💻 (or 📱 if the GitHub integration is available)

**Laptop**, from `apps/mobile` on an up-to-date `main`:

```
git pull
npm ci
npx eas-cli login                                  # once
npx eas-cli build -p android --profile preview
```

- If EAS asks to **generate a new Android Keystore**, answer **yes**. EAS keeps it. It is the key whose fingerprint step 7 needs, and every later build is signed with it. **Never** let it be replaced once testers have the app: a different key cannot install over the old one.
- The build log shows `Environment variables loaded from the "preview" build profile "env" configuration: FLYLEAF_API_URL` and the preview environment's variables.
- It queues on the free tier, then prints a link and a QR code. `Ctrl+C` stops only the log; `npx eas-cli build:list` shows progress.

**Phone-only alternative: expo.dev's GitHub integration.** expo.dev → project → **Project settings** → **GitHub** → connect the `flyleaf` repository and set the **base directory** to `apps/mobile`. Then the project's **Builds** page → **Build from GitHub** (or similar wording) → platform Android, profile `preview`, branch `main`. This was not tried from this repo; whether your plan offers it is shown on that page. If it is not there, use the laptop.

- ✅ The build page says **Finished** and offers **Install** / a download link for the `.apk`.

### 6. Install the APK on the phone 📱

Open the build's link (or scan the QR) on the phone → download → open the `.apk`. Android asks to allow installs from the browser once.

- A **development build** of Flyleaf already on the phone has the same package name, so the beta **replaces** it (same EAS key). For local development afterwards, install a development build again.
- ✅ Settings → Apps → Flyleaf shows version **0.1.0-beta.1**. The app opens, and a search returns books from the server.

### 7. App Links: the signing key's SHA-256 → the server 💻 then Claude/SSH

**7a. Read the fingerprint** (laptop, `apps/mobile`):

```
npx eas-cli credentials -p android
```

→ choose the **preview** profile (it shares the keystore with production for the same package) → under **Keystore**, copy the value after **SHA256 Fingerprint** (`AA:BB:…`, 32 pairs). On expo.dev the same page is **Credentials** → **Android** → `app.flyleaf` → the keystore → **SHA-256 fingerprint**.

**7b. Set it on the server.** Both values are public (they are what `assetlinks.json` publishes), so Claude may do this over SSH:

```
sudo nano /etc/flyleaf/flyleaf.env
```

Replace the two commented lines under `# App Links for the emailed links` with:

```
ANDROID_APP_PACKAGE='app.flyleaf'
ANDROID_CERT_SHA256='AA:BB:…'          # the 7a value; several keys: comma-separated
```

Then apply it. `provision.sh` re-renders `/etc/flyleaf/app.env` and restarts the API and worker. `release.sh` ships the latest `main`, which this PR's merge is part of:

```
sudo /opt/flyleaf/deploy/provision.sh
sudo /opt/flyleaf/deploy/release.sh
```

(`configure-env.sh` only fills `<placeholders>` and does not ask for these two. Editing `flyleaf.env` is the way. A malformed value stops the API at start with a message naming the variable, and `release.sh` then rolls back by itself.)

- ✅ `curl -fsS https://<host>/.well-known/assetlinks.json` shows `"package_name": "app.flyleaf"` and your fingerprint.

**7c. Make Android re-check the links.** Android verifies when the app is installed. If the APK went on before 7b, reinstall it, or on the laptop with the phone on USB: `adb shell pm verify-app-links --re-verify app.flyleaf`, then `adb shell pm get-app-links app.flyleaf`, which should show `<host>: verified`. `flyleaf.app` will show as not verified until that domain exists and serves the same file.

- On **Android 12 and later**, each host is verified separately, so `<host>` works now. On **Android 11 and older**, the app's hosts are verified together, and `flyleaf.app` cannot verify yet, so links there open the browser page, whose **Open in the app** button still works.
- ✅ From another app (Gmail, Notes), tap `https://<host>/@<your username>`. It opens the app on your profile.

### 8. When something fails

| Symptom | Look at |
|---|---|
| Build stops: `FLYLEAF_API_URL is not set for the preview profile` | `eas.json` › `build.preview.env` |
| Build stops: `google-services.json is missing for the preview profile` | step 3: the variable exists, type File, environment **preview** |
| Build fails bundling: `Unable to resolve module @flyleaf/api-client` | `eas-build-post-install` in `apps/mobile/package.json` must exist |
| App opens to an error: `No API address in this build` | an `eas update` was published without `FLYLEAF_API_URL` (see OTA updates above) |
| Push never arrives, the server log shows `InvalidCredentials` | step 4: the FCM V1 key is attached to `app.flyleaf` |
| Push never arrives, no error | the phone: Settings → Apps → Flyleaf → Notifications on. Push is asked for after your first follow, or from the notification centre's banner. No push in the first 24 h of a new account except import completion (PRD §19). |
| Links open the browser | `assetlinks.json` (7b), then re-verify (7c) |

---

## Phone test checklist

On the beta APK against `https://<host>`, merged from the phone checks in `docs/tasks.md` (SO-3x, SO-4x, SO-5x, Phase 5 A, B, C) and deploy step 8. Tick each one, and note the phone model and Android version.

**Server and account (deploy step 8)**
- [ ] Sign up from the phone. The verification email arrives (Gmail). Tap its link: with App Links verified (7c) it opens the app, otherwise the browser page, which works too. Log a book.
- [ ] Forgot password → email → reset → sign in.

**Notifications (SO-3x)**
- [ ] Nothing asks for notification permission at first launch. The first follow asks once. Saying "no" is remembered, and the notification centre offers a "turn on push" banner instead.
- [ ] With a second account (a second phone, or a browser session against the API): follow, like and comment on the first account's review. Each appears in the centre (Home → bell): unread badge (99+ past 99), grouped Today / This week / Earlier, mark all read, pull to refresh.
- [ ] Push arrives for those once the account is older than 24 h. Tapping it opens the right screen, with Back leading to sensible screens (e.g. review → book → Home).
- [ ] Sign out: no more pushes for that account on this phone.

**Moderation (SO-4x)**
- [ ] Report from each surface: a review (flag in the header), a comment, a profile ("Block or report"), a shelf, a book. The confirmation says reports are usually reviewed within 2 days and points to Settings → Your reports.
- [ ] Profile settings → Your reports lists them with their status.
- [ ] From the admin console, act on a report against your own review. The notification opens the notice (rule, consequences, appeal box), and one appeal goes through.

**Public pages and App Links (SO-5x, Phase 5 A)**
- [ ] Profile → Share profile gives `https://<host>/@<name>`. It opens in a browser on a phone without the app, with preview cards when pasted into a chat app.
- [ ] With the app installed: `https://<host>/@<name>`, `https://<host>/book/<id>` and `https://<host>/u/<name>/shelves/<slug>` open in the app (Android 12+, after 7c).
- [ ] Onboarding after sign-up shows follow suggestions. With an unverified account, Follow works from onboarding, a profile and a follower list with no verify prompt. Writing a review still asks to verify.

**Stats, goals and streaks (Phase 5 A)**
- [ ] Profile strip: log progress today and see "1 day · Reading streak". Tap the ring, set 24 and see "n/24". Lower the goal, then remove it. A private finish moves your ring but not the ring a follower sees.
- [ ] The ring at 0, under half, over half and full draws correctly (no screenshot test covers it).
- [ ] Stats: an unrated book shows "Based on X of your Y books — Z are unrated". A streak broken for 3+ days shows "Longest streak".

**Share cards (Phase 5 B)**
- [ ] In the phone's browser, `https://<host>/v1/cards/users/<your user id>/wall` (also `/profile`, `/stat/books?year=all`) for a public account. Text is crisp full screen, Arabic/Hebrew/CJK titles and emoji look right, and an Instagram story fits (1080 × 1920) without cropping the handle.

**Stats screen, sharing, milestones, Year in Review, licences (Phase 5 C)**
- [ ] Stats screen: one card per figure, a note under a figure with missing data, tap a derived figure for its method, bars grow once (instant with Reduce motion on).
- [ ] Share on a card: the preview shows the server card, the switcher swaps year / All time, Share opens the share sheet, and an Instagram story fits.
- [ ] Profile → Licences opens and scrolls the package list smoothly. **satori** and **resvg-js** are listed with the fonts, emoji and data credits.
- [ ] Finish your 10th (or first) book: the moment or banner appears once the finish syncs, and never again. With Notifications → Milestones off, nothing appears.
- [ ] Year in Review: before 1 December, set the phone's clock (and zone) to December, or open `/year-in-review?year=2025` from the stats banner when it shows. Swipe the cards and share one.
- [ ] A Sinhala, Khmer or Tibetan title on a finish card renders. (Myanmar: the medial ra sits beside its consonant, a known limit.)

**Offline (the app's core promise)**
- [ ] Airplane mode: log progress and finish a book. "Offline" shows. Back online, the queue flushes and the server has the changes.

---

## Next builds

- **JavaScript-only change:** `FLYLEAF_API_URL=https://<host> npx eas-cli update --channel preview --environment preview` (laptop). The beta picks it up on its next launch or two.
- **Native change** (new native module, `app.json` plugin or permission, intent filters): steps 5–6 again. versionCode goes up by itself. Raise `version` (e.g. `0.1.0-beta.2`) when you want testers to see a new number. A new `version` is also a new runtime, so earlier APKs stop receiving updates.
- **Real domain later:** deploy.md › *Moving to a real domain*. Add the domain's intent filter and associated domain next to the others (the tests require both platforms to list the same hosts), set `FLYLEAF_API_URL` in `eas.json` to it, rebuild, and keep `ANDROID_CERT_SHA256` the same (same key).
- **iOS:** not built. `0.1.0-beta.1` is not a valid iOS version string (`CFBundleShortVersionString` takes numbers only), so an iOS build needs `ios.version` or a numeric `version` first.
