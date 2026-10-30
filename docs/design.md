# Flyleaf — Design System

**Companion to:** `PRD.md` §36–38
**Version:** 2.0 (unslop redesign, Oct 2026)
**Platform:** React Native (Expo). Values in dp/pt; both platforms share one scale.

---

## 1. The governing idea

> **The interface recedes; covers advance.**

Book covers are wildly varied and saturated. An interface with its own strong colour fights every single one of them. So Flyleaf is graphite with one ink-blue accent, and the colour in the product comes from the books.

Version 2 is built on [unslop](../.claude/skills/unslop/SKILL.md) by Damir Sokolovsky (@heydamir, CC BY 4.0): quiet chrome, richness only in the moments that matter.

### Direction

| | |
|---|---|
| **Product** | A reading tracker where people log what they read, rate it in half-stars, and keep a diary and a wall of covers |
| **Character** | Bookish, unhurried, exact |
| **World** | A well-made hardback: paper, ink and cloth, often read at night |
| **Moments** | The covers themselves (Wall, reading card, book hero), and the progress bar and goal ring filling |
| **Signature** | The gold half-star row with its numeral. Gold appears nowhere else |

The product should feel like **a well-made hardback, not a SaaS dashboard.** Literary but modern, expressive but calm, premium through restraint rather than ornament.

**Two things this rules out immediately:** copying Letterboxd's palette (`#14181C` / `#00E054`) or its typeface pairing, and any interface colour that competes with cover art.

---

## 2. Colour

Graphite surfaces, one ink-blue accent for interaction. Stars and the heart are the only other coloured elements.

### Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `ground` | `#FAFAFA` | `#141415` | App background |
| `surface` | `#FFFFFF` | `#19191B` | Cards, sheets |
| `surface2` | `#F4F4F5` | `#232325` | Raised: inputs, active rows, segmented tracks |
| `ink` | `#171717` | `#EDEDED` | Primary text |
| `ink2` | `#525252` | `#A1A1A6` | Secondary text |
| `muted` | `#737373` | `#85858B` | Meta, captions, icons |
| `line` | ink at 8% | ink at 8% | Hairlines |
| `lineStrong` | ink at 16% | ink at 16% | Emphasised hairlines, empty stars |
| `accent` | `#3355C4` | `#8DA6EE` | Primary action, links, selection (6.5:1 / 7.7:1) |
| `onAccent` | `#FFFFFF` | `#141415` | Text and icons on an accent fill |
| `accentSoft` | `#EEF2FC` | `#1B2133` | Selected backgrounds |
| `star` | `#B07F14` | `#E0AF45` | **Rating stars only** |
| `heart` | `#B4423A` | `#E5726A` | The heart (§9.4) |
| `positive` | `#16A34A` | `#4CC38A` | Success |
| `critical` | `#DC2626` | `#E5484D` | Destructive, errors |
| `overlay` | black 40% | black 60% | Sheet scrims |
| `scrim` | black 64% | black 64% | Badges drawn over cover art |

### Rules

1. **Dark mode is a first-class design, not an inversion.** This audience reads at night. Depth in dark comes from surface steps and hairlines, never shadows.
2. **Never hardcode a colour.** Every value comes from a token. A literal in a component is a bug.
3. **Accent restraint.** The accent covers a few percent of a screen: the primary action, the selection, a link. Tab bar and filter chips stay neutral.
4. **Colour is never the sole carrier of meaning.** Ratings show a numeral, statuses show text, charts carry direct labels rather than a colour legend (§38).
5. **No gradients, glows or coloured shadows.** Light mode may use one soft neutral shadow on floating things (the FAB), nothing else.

### Status colours — deliberately absent

Want / Reading / Finished / DNF are **not** colour-coded chips. They are labelled controls in `ink2`.

---

## 3. Typography

| Role | Face | Fallback | Why |
|---|---|---|---|
| **Display** — screen titles, book titles, review body | **Newsreader** | Georgia, serif | A text serif drawn for long reading on screens. Book titles and reviews should feel like reading |
| **UI** — labels, buttons, navigation, metadata | **Instrument Sans** | system sans | Warm, legible at 12–15, gets out of the way |
| **Numerals** — statistics, page counts | Instrument Sans, `tabular-nums` | — | Digits must align in columns |

Weights are 400 and 500, with 600 for rare emphasis. **No 700+ anywhere.** Hierarchy comes from size and colour. Custom fonts ignore `fontWeight` on Android, so `Txt` maps a weight to its family (`familyFor` in `tokens.ts`).

**Sentence case everywhere.** No uppercase tracked labels, no italic for emphasis, no negative letter spacing below 16.

### Scale

| Name | Size / line height | Weight | Use |
|---|---|---|---|
| `displayL` | 32 / 38 | 400 serif | Screen titles |
| `displayM` | 24 / 30 | 500 serif | Section headings, book title on detail |
| `title` | 17 / 24 | 500 | Card titles |
| `bodyL` | 17 / 26 | 400 serif | **Review body** |
| `body` | 15 / 22 | 400 | Standard UI text |
| `caption` | 13 / 20 | 400 | Metadata |
| `micro` | 12 / 16 | 500 | Section labels and meta, sentence case, no tracking |

Book titles use the display serif everywhere they appear — cards, rows, detail. It is the single most repeated element in the product and the main carrier of the literary feel.

**Dynamic type: support to 200%.** No fixed-height text containers anywhere. Every layout is tested at maximum scale as part of done.

---

## 4. Space and layout

4pt base grid. Scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`.

| Context | Value |
|---|---|
| Screen horizontal margin | 16 |
| Card padding | 16 |
| Section gap | 32 |
| List row vertical padding | 12 |
| Sheet top padding | 20 |

### Cover sizes — 2:3, always

The ratio is universal, and the placeholder is generated at the same ratio so grids never jump.

| Token | Size | Use |
|---|---|---|
| `coverXS` | 32 × 48 | Inline lists, mentions |
| `coverS` | 56 × 84 | Search results, feed metadata |
| `coverM` | 88 × 132 | Shelf grids, carousels |
| `coverL` | 120 × 180 | Reading cards, favourites |
| `coverXL` | 180 × 270 | Book detail hero |

**Request the image size that matches the surface.** Never `L` in a grid — that is the §40.3 stage-1 performance rule, and it is a design responsibility as much as an engineering one.

### The narrow-screen floor

Everything must work at **360 dp** (Android) and **375 pt** (iPhone SE). Where it bites:

| Surface | Constraint |
|---|---|
| The Wall, 3-column 2:3 | ~104 dp per cover after gutters. Verify legibility; **drop to 2 columns below 340 dp** rather than shrinking |
| Tab bar, 5 tabs + FAB | ~60 dp per target. Labels must not truncate — if they do, the tab names are too long |
| Half-star control | Ten touch zones across the width. The tightest control in the product; verify its extra hit area *here* specifically |
| Feed cards, Diary rows | Must not truncate title **and** author **and** rating |

---

## 5. Components

### Radius
Tags 4–6 · controls and inputs 10 · cards 14 · sheets 20 · pill only for avatars, the progress track and toggles. Nested radius: inner = outer − padding, never below 4.

### Cards
14pt radius · 1pt `line` hairline · **no drop shadow** — elevation comes from surface steps, which is quieter and reads better against cover art.

### Buttons

| Variant | Spec |
|---|---|
| Primary | Filled `accent`, `onAccent` text, 48pt height (36 small), 10pt radius, `body` weight 500 |
| Secondary | `surface2` fill, 1pt `line` hairline, `ink` text |
| Tertiary | Text only, `accent` |
| Destructive | `critical` text with a hairline; filled only on the confirmation step |

Minimum touch target **44 × 44** everywhere, regardless of visual size.

### Bottom sheets
The primary modal pattern — logging, progress, DNF, edition picker, share. Detents at 50% and 90% · grabber handle · `overlay` scrim · spring dismissal, velocity-aware.

### Star rating
The most-repeated interaction in the product.

- 44pt minimum touch target with **extra horizontal hit area** beyond the visual star
- Half-star zones: left half / right half of each star
- Fills continuously as you drag across
- **Haptic tick at each half step**
- Announces as "4.5 out of 5 stars", with an adjustable accessibility trait
- A numeral always accompanies the stars

### The heart
Outline → filled, `heart` token, scale bounce 200ms, haptic. Sits beside the star row, never inside it — they are different statements (§9.4).

### Progress bar
6pt height, fully rounded, `accent` fill, animates over 400ms on change. **That animation is the reward for the core daily action** — do not shorten it.

### Tab bar
5 tabs plus a central FAB. Outline icons with labels, hairline top border. Active state in `ink`, inactive `muted`; the accent is kept for actions. The bar never disappears except in full-screen modals (log sheet, scanner, share preview).

### Empty states
**Always an illustration or real content, a warm line of copy, and one concrete action. Never a shrug.**

| Screen | Copy |
|---|---|
| Reading, empty | "Nothing on the go. What are you reading?" + search field + 3 from Want to Read |
| Diary, empty | "Your diary starts with the first book you finish." |
| Feed, no follows | *Never empty* — auto-switch to Popular with an inline suggestion carousel |
| Wall, <4 books | Section hidden entirely — a sparse grid looks worse than nothing |
| Stats, <3 books | "Finish a few books and your stats will appear" + preview illustration |

### Icons
Ionicons outline, 16 or 18 inline (22 in the tab bar), coloured by their text role. **No emoji in the interface.** Stars and hearts are icons in `star` / `heart`, never typed glyphs.

### Skeletons
Shape-matched to real content, subtle shimmer. **Never a centred spinner on a full screen.**

---

## 6. Gestures

Every gesture has a visible, tappable equivalent. **A gesture is never the only way to do something.**

| Gesture | Context | Action |
|---|---|---|
| Swipe right | Reading card | +10 pages, haptic confirm |
| Swipe left | Reading card | Finish · Pause · Stop reading |
| Swipe left | Shelf item | Remove, with undo |
| Swipe left | Want-to-read row | Start reading · Remove |
| Swipe left | Notification | Mark read · Dismiss |
| Swipe right | Feed card | Save book to Want to Read |
| **Swipe left** | **Feed card** | **Rate and review** — the fastest path from "my friend loved it" to "so did I" |
| Long-press | Any cover | Quick actions: shelve, rate, share, view |
| Double-tap | Review card | Like |
| Drag | Ranked shelf row | Reorder (with a "move to position" alternative) |
| Pull down | Any list | Refresh |
| Swipe down | Any sheet | Dismiss |

**Rules:** destructive swipes require the second tap on the revealed action — never single-swipe-to-delete. Every swipe shows a labelled, colour-coded background as it opens, so the gesture teaches itself. Swipes are disabled while a list scrolls horizontally.

---

## 7. Motion

| Interaction | Treatment |
|---|---|
| Screen push | 280ms ease-out, shared-element transition on covers |
| Bottom sheet | Spring, damping 0.8 |
| **Progress bar change** | **400ms ease-out** — the small reward that makes tracking feel good |
| Star selection | Scale to 1.15 and back, 150ms, haptic |
| Like / heart | Scale to 1.1 and back, 200ms, no bounce |
| Card entry | 40ms stagger, 8pt rise with fade |
| Stats reveal | Bars grow, donuts sweep, 600ms, first view only |
| Finish moment | Cover briefly gains a subtle sheen — a beat of ceremony, not confetti |

**Reduced motion:** all of the above become instant opacity changes; the stats reveal renders in its final state. Non-negotiable. Additionally degrade the stats reveal on low-end devices where 60fps is not achievable.

One easing curve everywhere: `cubic-bezier(0.22, 1, 0.36, 1)` (`motion.easing`). Feedback 120–180ms, menus 160–220ms, entrances 300–500ms. Only colour, opacity and transform animate.

> **Restraint rule:** motion confirms actions and rewards the core loop. It never decorates. A book app that animates constantly feels cheap.

### Micro-interactions worth the effort

- Haptic tick as the progress slider crosses each 5%
- Cover lifts slightly on long-press before the quick-actions menu
- The star row filling as you drag across it
- The goal ring animating on the profile — ambient, unpushy
- Pull-to-refresh revealing a rotating book spine

---

## 8. Voice

| Principle | Example |
|---|---|
| **Never shame** | "Stopped reading" — never "Gave up" or "Failed" |
| Warm on abandonment | "Not every book is for every reader." |
| Specific over clever | "Sign up to log *Piranesi*" — not "Join Flyleaf" |
| Plain punctuation | No exclamation marks; no full stop on labels, buttons or headings; "…" not "..." |
| Errors explain and offer a fix | "We couldn't load this book. Try again." Never a raw error |
| No manufactured urgency | No countdowns, no "your streak is at risk", no "you're 3 books behind" |
| Own it plainly | "Based on 180 of your 247 books — 67 are missing page counts." with a link to fix them |

---

## 9. Accessibility

**Target WCAG 2.1 AA.** Checked before merge, not audited before launch.

| Requirement | Implementation |
|---|---|
| Screen readers | Covers announce "Cover of *Title* by *Author*", never "image". Ratings announce "4.5 out of 5 stars" |
| Adjustable traits | The rating control exposes `adjustable` so it can be set by swipe gesture |
| Dynamic type | Support to 200%. No fixed-height text containers. Tested at max scale |
| Contrast | 4.5:1 body, 3:1 large text and UI components — **verified in both themes** |
| Touch targets | 44 × 44 minimum; extra hit area on the half-star control |
| Reduced motion | Respected everywhere |
| Colour independence | Numerals beside stars, labels beside statuses, direct labels on charts |
| Focus management | Opening a sheet moves focus in; closing returns it to the trigger. Never trapped |
| Alternative input | Drag-to-reorder always has "move to position". Slider progress always has numeric entry |

**Definition of done for any core flow includes a screen-reader pass** on: log a book, update progress, finish, review.

---

## 10. Screen notes

Layout intent for the screens that carry the product. Full specs in `PRD.md` §6.

### Reading (tab 2) — the most important screen
Segmented **Reading / Want to read / Diary**. Cards at `coverL` with a progress bar, "page 210 of 480", and a predicted finish date. The slider **auto-saves on release — no confirm button**. Budget: 5 seconds from app open to saved progress. Optimistic always; a progress write never shows a spinner.

### Book detail
`coverXL` hero with parallax. Title in display serif. The **status control is the largest element after the cover**. Rating distribution as a histogram. **Friends' ratings above strangers'.** Tabs: Reviews / Editions / Your history. "Where to read" below the fold, library links first.

### Finish flow
Cover, "Finished", **star row already visible and interactive**, heart, date, format chips, review field collapsed to one tap. Skip is visible and unambiguous. Whole flow under 20 seconds.

### The Wall (§6.37a)
3-column 2:3 poster grid, sticky filters (Year · Rating · Hearted · Genre · Format). Blurhash placeholders in grid position. Missing covers get a generated typographic poster so the grid never has holes. Shares as a 4×4 collage.

### Diary
Three views of the same rows — **List · Grid · Calendar**. The calendar is the only view that shows *absence*: dot weight scales with pages read, empty days are simply empty with no red and no "missed".

### Profile
Avatar, name, bio, counts, follow/edit. Then **four favourites** — above the statistics, because taste comes before quantity. Then the stats strip with the goal ring, currently reading, the Wall, the Diary, reviews, shelves.

### Feed
Segmented Friends / Popular. Reviewed and finished cards are largest. Review excerpt clamps at 3 lines. Never renders an empty state.

---

## 11. Tokens as code

`apps/mobile/src/ui/tokens.ts` is the only place literals are permitted and the source of truth for every value in §2–§7: `palette`, `space`, `radius` (`xs 4 · sm 6 · md 10 · lg 14 · xl 20 · pill`), `cover`, `fontFamilies`, `familyFor`, `type`, `motion`. The web pages (`apps/api/src/web`, `identity/link-pages.ts`) and the admin console mirror the same palette as CSS variables.

---

## 12. Design checklist

Before any screen is considered done:

- [ ] Renders correctly in **both themes** — dark checked first, not last
- [ ] Renders at **360 dp** without truncation or overlap
- [ ] Renders at **200% dynamic type** without clipping
- [ ] Every touch target ≥ 44 × 44
- [ ] Contrast verified in both themes
- [ ] Empty state has content or an action, never a shrug
- [ ] Loading state is a shape-matched skeleton, not a spinner
- [ ] Error state explains and offers a retry
- [ ] Screen-reader pass complete for the core flows
- [ ] Reduced-motion path verified
- [ ] **No colour literals** — every value from a token
- [ ] No emoji, no uppercase labels, no weight above 600, no exclamation marks
- [ ] Spacing on the 4pt grid, radii from `radius`
- [ ] Covers requested at the size the surface renders
