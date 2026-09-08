# Flyleaf — Design System

**Companion to:** `PRD.md` §36–38
**Version:** 1.0
**Platform:** React Native (Expo). Values in dp/pt; both platforms share one scale.

---

## 1. The governing idea

> **The interface recedes; covers advance.**

Book covers are wildly varied and saturated. An interface with its own strong colour fights every single one of them. So Flyleaf is near-monochrome with one accent, and the colour in the product comes from the books.

The product should feel like **a well-made hardback, not a SaaS dashboard.** Literary but modern, expressive but calm, premium through restraint rather than ornament.

**Two things this rules out immediately:** copying Letterboxd's palette (`#14181C` / `#00E054`) or its typeface pairing, and any interface colour that competes with cover art.

---

## 2. Colour

Near-monochrome, cover-forward. One accent, used only for interactive elements. Stars are the only other coloured element.

### Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `ground` | `#F7F7F5` | `#0F1113` | App background |
| `surface` | `#FFFFFF` | `#17191C` | Cards, sheets |
| `surface2` | `#EFEFEC` | `#1F2226` | Nested surfaces, inputs |
| `ink` | `#14161A` | `#ECEEF0` | Primary text |
| `ink2` | `#43484F` | `#B4BAC2` | Secondary text |
| `muted` | `#6E747C` | `#868D96` | Tertiary, metadata |
| `line` | `#E2E2DE` | `#262A2F` | Dividers, borders |
| `lineStrong` | `#CBCBC5` | `#363B41` | Emphasised borders |
| `accent` | `#2F5D50` | `#7FB3A1` | Interactive, links, active tab |
| `accentSoft` | `#E4EDE9` | `#18241F` | Selected backgrounds |
| `star` | `#C8951F` | `#E0AF45` | **Rating stars only** |
| `heart` | `#A8443A` | `#D9756A` | The heart (§9.4) |
| `positive` | `#2E6B4E` | `#6DB68B` | Success |
| `critical` | `#93441D` | `#D4906A` | Destructive, errors |
| `overlay` | `rgba(20,22,26,0.4)` | `rgba(0,0,0,0.6)` | Sheet scrims |

### Rules

1. **Dark mode is a first-class design, not an inversion.** This audience reads at night; a large share will never see the light theme. Dark surfaces are warm-neutral, never pure black, so covers do not appear to float.
2. **Never hardcode a colour.** Every value comes from a token. A literal in a component is a bug.
3. **Accent restraint.** One accent for interaction. Status is communicated by label first, colour second.
4. **Colour is never the sole carrier of meaning.** Ratings show a numeral, statuses show text, charts carry direct labels rather than a colour legend (§38).

### Status colours — deliberately absent

Want / Reading / Finished / DNF are **not** colour-coded chips. They are labelled controls in `ink2`. Four coloured pills on every book card would fight the covers and reintroduce exactly the visual noise this palette exists to avoid.

---

## 3. Typography

| Role | Face | Fallback | Why |
|---|---|---|---|
| **Display** — screen titles, book titles, review body | **Literata** | Georgia, serif | Designed for screen reading. Serif for review bodies makes long text feel like reading, which is thematically exact |
| **UI** — labels, buttons, navigation, metadata | **Archivo** | system sans | Legible at small sizes, gets out of the way |
| **Numerals** — statistics, page counts | Archivo, `tabular-nums` | — | Digits must align in columns |

**Not Inter, not Space Grotesk, not Playfair Display.** The first two are the default-safe choices everything looks like; the third is the "literary" cliché.

### Scale

| Name | Size / line height | Weight | Use |
|---|---|---|---|
| `displayL` | 34 / 40 | 600 | Screen titles |
| `displayM` | 26 / 32 | 600 | Section headings, book title on detail |
| `title` | 20 / 26 | 600 | Card titles |
| `bodyL` | 17 / 26 | 400 | **Review body — serif** |
| `body` | 15 / 22 | 400 | Standard UI text |
| `caption` | 13 / 18 | 400 | Metadata |
| `micro` | 11 / 14 | 500 | Labels, uppercase, `letterSpacing: 0.08em` |

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

### Cards
12pt radius · 1pt `line` border · **no drop shadow in light mode** — elevation comes from surface contrast, which is quieter and reads better against cover art.

### Buttons

| Variant | Spec |
|---|---|
| Primary | Filled `accent`, 48pt height, 12pt radius, `body` weight 600 |
| Secondary | 1pt `accent` outline, transparent fill |
| Tertiary | Text only, `accent` |
| Destructive | `critical` outline; filled only on the confirmation step |

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
5 tabs plus a central FAB. Icons with labels. Active state in `accent`. The bar never disappears except in full-screen modals (log sheet, scanner, share preview).

### Empty states
**Always an illustration or real content, a warm line of copy, and one concrete action. Never a shrug.**

| Screen | Copy |
|---|---|
| Reading, empty | "Nothing on the go. What are you reading?" + search field + 3 from Want to Read |
| Diary, empty | "Your diary starts with the first book you finish." |
| Feed, no follows | *Never empty* — auto-switch to Popular with an inline suggestion carousel |
| Wall, <4 books | Section hidden entirely — a sparse grid looks worse than nothing |
| Stats, <3 books | "Finish a few books and your stats will appear" + preview illustration |

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
| Like / heart | Scale bounce, 200ms |
| Card entry | 40ms stagger, 8pt rise with fade |
| Stats reveal | Bars grow, donuts sweep, 600ms, first view only |
| Finish moment | Cover briefly gains a subtle sheen — a beat of ceremony, not confetti |

**Reduced motion:** all of the above become instant opacity changes; the stats reveal renders in its final state. Non-negotiable. Additionally degrade the stats reveal on low-end devices where 60fps is not achievable.

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
Cover, "You finished!", **star row already visible and interactive**, heart, date, format chips, review field collapsed to one tap. Skip is visible and unambiguous. Whole flow under 20 seconds.

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

```ts
// src/ui/tokens.ts — the only place literals are permitted
export const color = {
  ground:{light:'#F7F7F5',dark:'#0F1113'},
  surface:{light:'#FFFFFF',dark:'#17191C'},
  surface2:{light:'#EFEFEC',dark:'#1F2226'},
  ink:{light:'#14161A',dark:'#ECEEF0'},
  ink2:{light:'#43484F',dark:'#B4BAC2'},
  muted:{light:'#6E747C',dark:'#868D96'},
  line:{light:'#E2E2DE',dark:'#262A2F'},
  lineStrong:{light:'#CBCBC5',dark:'#363B41'},
  accent:{light:'#2F5D50',dark:'#7FB3A1'},
  accentSoft:{light:'#E4EDE9',dark:'#18241F'},
  star:{light:'#C8951F',dark:'#E0AF45'},
  heart:{light:'#A8443A',dark:'#D9756A'},
  positive:{light:'#2E6B4E',dark:'#6DB68B'},
  critical:{light:'#93441D',dark:'#D4906A'},
} as const;

export const space = {1:4,2:8,3:12,4:16,6:24,8:32,12:48,16:64} as const;
export const radius = {sm:6,md:12,lg:16,pill:999} as const;
export const cover = {
  xs:{w:32,h:48}, s:{w:56,h:84}, m:{w:88,h:132},
  l:{w:120,h:180}, xl:{w:180,h:270},
} as const;
export const type = {
  displayL:{family:'Literata',size:34,lh:40,weight:'600'},
  displayM:{family:'Literata',size:26,lh:32,weight:'600'},
  title:{family:'Archivo',size:20,lh:26,weight:'600'},
  bodyL:{family:'Literata',size:17,lh:26,weight:'400'},
  body:{family:'Archivo',size:15,lh:22,weight:'400'},
  caption:{family:'Archivo',size:13,lh:18,weight:'400'},
  micro:{family:'Archivo',size:11,lh:14,weight:'500',tracking:0.08},
} as const;
export const motion = {
  push:280, sheet:{damping:0.8}, progress:400,
  star:150, like:200, statsReveal:600, stagger:40,
} as const;
```

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
- [ ] Covers requested at the size the surface renders
