# Flyleaf — Phase −1 surprises list

**The real output of the walking skeleton.** Not a bug log — a list of things that were not true in the plan, with what each one changes.

Written 3 September 2026, after the full path ran on a physical Android device (Samsung, Android 14, dev build of SDK 57).

---

## The four questions, answered

| Question | Answer | Evidence |
|---|---|---|
| Does the Expo → Node → Postgres round trip work on a real device? | **Yes**, with no IP editing | Sign up, sign out, sign in, search, log, progress, finish, rate, profile — all on the phone against the laptop's API over Wi-Fi |
| Is the work/edition split workable in a real UI? | **Yes**, but presenting an edition needs care | No edition picker was forced into any flow. The bare word `paperback` in the metadata line was unintelligible until it was labelled and reordered |
| Does an append-only progress stream feel right, or over-engineered? | **Right, and invisible** | The screen only ever needs the latest row. Nothing about append-only leaked into the UI |
| Is the 20-second finish budget achievable? | **Yes — under 15 seconds** | Timed on device, unstyled, with an `Alert` as the guest prompt and no animation |

Plus the decision that was most expensive to get wrong:

> **Re-reading creates a second log and leaves the finished one standing** — and read as correct to a first-time user on a real screen, with no explanation. `reads.attempt_no` survives contact.

---

## What surprised me

### 1. Three environment failures before one line of product code ran

| Failure | Cause | Cost |
|---|---|---|
| `npm ERESOLVE` | `react@19.2.0` sat below RN 0.86.3's peer floor `^19.2.3`; `react-native-worklets` was missing entirely as a Reanimated 4 peer | ~1h |
| "Project is incompatible with this version of Expo Go" | **Expo Go supports exactly one SDK version.** The device had client 54; the project is 57 | ~2h, and one wrong diagnosis first |
| Gradle wrapper `SocketTimeoutException` | React Native's generated `gradle-wrapper.properties` allows **10 seconds** to connect before a ~130 MB download | ~1h |

None of these were product problems. All three were the toolchain refusing to start.

**What it changes:** the 5-day Phase −1 estimate silently assumed a working environment. Phase 0 gets an explicit setup allowance rather than discovering this again. `scripts/setup-android.ps1` and `scripts/fix-gradle.ps1` exist so the next machine costs minutes, not a day.

**Non-obvious rule learned:** for mobile dependencies, "latest stable" means *what the SDK bundles*, not what npm calls latest. `bundledNativeModules.json` is the authority. Use `npx expo install`, never `npm install`.

### 2. The EAS free-tier queue is not a viable inner loop

The cloud build sat queued for 47 minutes with an estimate that kept **growing**. The local build took 36 minutes once, and 1–2 minutes thereafter.

**What it changes:** local builds are the default. Cloud builds are for producing an APK someone else installs. A 75-minute wait per native dependency change would have made Phase 1 — which adds `expo-sqlite`, `expo-camera` and Reanimated worklets — genuinely unpleasant.

### 3. A smoke test found a 500 that 23 unit tests could not

Registering a duplicate email returned **500 instead of 409**. The code checked `String(err).includes('duplicate key')`, and Drizzle wraps driver errors — the Postgres message sits down the `cause` chain, not in the top-level string.

**What it changes:** match on **SQLSTATE**, never on message text. `uniqueViolationField()` walks the cause chain for `23505` and reads the constraint name, so the 409 can name the field — which matters, because a taken email and a taken username are different screens (PRD §6.3). Six regression tests pin it. **FN-63/64 must not lose this when real auth replaces the skeleton.**

### 4. Two UI bugs passed every automated check in the project

This is the most important entry in the list.

| Bug | Presented as | Why nothing caught it |
|---|---|---|
| `<Link asChild>` rejects a child whose `style` is an **array**. `[sheet.row, {...}]` threw inside `renderItem` | "Search is broken" | Valid TypeScript. No failing test. The thrown error named a component two levels from the cause |
| The star control drew **two overlapping glyph layers**, and used `⯨` (U+2BE8), which is not in the Android system font | "There are two layers of stars and half-stars don't work" | Valid TypeScript. No failing test. No runtime error at all |

At the time both shipped, the project had: `tsc --noEmit` clean under TS 7 strict with `noUncheckedIndexedAccess`, 23 unit tests passing, and 36/36 smoke assertions against a real Postgres. **All green. Both bugs present.**

**What it changes:** a person looking at a screen is a distinct, non-optional test layer, not a nicety at the end. Every phase's exit criteria now include a pass on a physical device — not "the checks are green".

### 5. `ListHeaderComponent` is a component *type*, not markup

The search field lost focus after **every single keystroke**. FlatList remounts `ListHeaderComponent` when its function identity changes, and `q` was in the `useCallback` deps — so every character unmounted the input and mounted a new one.

**What it changes:** interactive controls never go inside a list header. Keeping the search field outside the list also stops it scrolling away, which is what it should do anyway.

### 6. Correct data can still be unintelligible

The detail screen rendered `1975 · 368 pages · paperback`. The reaction was, verbatim: *"paperback (i dont know what it is)"*.

Nothing was wrong. The word sat last and lowercase, so it read as a stray token rather than a fact about the edition. Reordering to `1975 · Paperback · 368 pages` fixed it completely.

**What it changes:** this is the work/edition split's real risk. Not the schema — the schema is right. The risk is surfacing edition facts without making it obvious they *are* edition facts. Relevant to SL-0x and to the edition picker in Phase 1.

### 7. The guest gate works as designed

Signed out, tapping "Reading" produced: *"Sign up to log this book — Keep track of {title} and everything else you read"*, with **Not now** and **Sign up**. It names the action and the book.

One gap: a returning user who signed out is offered only **Sign up**. The `/auth` screen handles both, but the prompt should say so.

---

## Phase 0 addendum — the failure mode that kept recurring

Written 8 September 2026, after FN-04 and FN-05.

Phase −1's lesson was that some bugs are invisible to automated checks. Phase 0's is narrower and, on the evidence, more expensive:

> **Four separate times, a broken thing and a working thing produced identical output.** Not a wrong answer — *no distinguishable answer at all*.

| Where | What success and total failure looked like | Cost |
|---|---|---|
| Authors ingest | A COPY stream died mid-batch. `copyIn` listened for `finish` and `error`; a destroyed stream emits **`close`**, so the promise never settled, the socket was gone, Node drained the event loop and **exited 0** | 4 rounds of debugging |
| Interrupted runs | Ctrl+C before the read loop hit Node's default handler — instant exit, no output, and the run row left saying `running`, so `--status` showed a dead run as live | Two runs restarted from zero |
| `make ci`, second run | `dist/test/*.test.js` collected alongside the source tests — 283 tests instead of 174, one failing for a reason nothing in the working tree had changed | Caught before it shipped, by running it twice |
| `smoke.ping` | The handler returned a value and logged nothing, so a working queue and a dead worker printed exactly the same thing — in the one job whose entire purpose is telling those apart | Caught on first manual use |

The underlying error was the same each time, and it was **mine, in the verification, not in the code**: I checked that the good path produced the right answer, and never checked that the bad path produced a *different* one.

**What it changes.** Before calling anything verified, answer one question explicitly:

> If this were completely broken, what would I see — and is it different from what I see now?

If the answer is "nothing" or "the same", that is the defect, ahead of whatever was being investigated. Concretely, in this codebase:

- **A promise that can hang must have a timeout or a `close` listener.** A never-settled promise is not an error path; Node calls it success.
- **A test that compares strings to strings proves nothing about a system that parses them.** The COPY escaping bug passed unit tests for weeks and died on the real parser instantly. Round-trip through the actual engine.
- **Run the check twice.** The second run is a different test from the first, because the first one left state behind.
- **Anything meant to be watched by a human must say something when it works.** Silence is indistinguishable from death.
- **An interrupt must be recorded**, or the status display lies in exactly the situation where you rely on it.

The instrumentation that finally found the first one — a `beforeExit` handler naming the pending stage plus `process.getActiveResourcesInfo()` — is still in `ingest.ts` deliberately. Three rounds of plausible guesses cost more than one round of measurement, and the measurement is four lines.

---

## Actions taken

- [x] Search field moved out of `ListHeaderComponent`
- [x] Star control rewritten as one clipped glyph — half-stars verified on device
- [x] `<Link asChild>` array styles replaced with a registered `sheet.rowTop`
- [x] Edition format capitalised and reordered
- [x] `uniqueViolationField()` + 6 regression tests
- [x] `scripts/setup-android.ps1`, `scripts/fix-gradle.ps1`, both idempotent
- [x] README troubleshooting for all three environment failures

## Actions still open

- [ ] **SK-09** — a second person completes the path unaided
- [ ] Guest prompt should offer sign-in as well as sign-up — fold into `FN-6x`
- [ ] Add "verified on a physical device" to every phase's exit criteria
- [ ] Carry the SQLSTATE rule into `FN-63/64`

---

## The one-line version

The schema decisions survived contact with a real screen. The toolchain cost more than the product code, and the only two bugs that reached the device were the two that no automated check in the project could possibly have caught.

**Phase 0's one-line version:** every expensive bug so far has been one where failure and success looked the same from outside — on a screen in Phase −1, in a terminal in Phase 0.
