# Share-card fonts (ST-07)

The share-card renderer (`src/cards/render.ts`) reads these files from disk once and loads **no system
fonts and nothing from the network**, so a card renders the same on every machine.

| File | Family | Covers | Licence |
|---|---|---|---|
| `Newsreader-Regular.ttf`, `Newsreader-Medium.ttf` | Newsreader (opsz 36) | Titles, quotes (design.md §3 display face) | OFL 1.1, `OFL-newsreader.txt` |
| `InstrumentSans-Regular.ttf`, `InstrumentSans-Medium.ttf` | Instrument Sans (wdth 100) | Labels, numbers (design.md §3 UI face) | OFL 1.1, `OFL-instrumentsans.txt` |
| `NotoSansArabic-*.ttf` | Noto Sans Arabic | Arabic, Persian, Urdu | OFL 1.1, `OFL-notosansarabic.txt` |
| `NotoSansHebrew-*.ttf` | Noto Sans Hebrew | Hebrew | OFL 1.1, `OFL-notosanshebrew.txt` |
| `NotoSansDevanagari-Regular.ttf` … `NotoSansGurmukhi-Regular.ttf` | Noto Sans Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi | The main Indian scripts | OFL 1.1, `OFL-notosans<script>.txt` |
| `NotoSansThai-Regular.ttf` | Noto Sans Thai | Thai | OFL 1.1, `OFL-notosansthai.txt` |
| `NotoSansSC-Regular.ttf` | Noto Sans SC | Chinese (Han) and Japanese kana | OFL 1.1, `OFL-notosanssc.txt` |
| `NotoSansKR-Hangul-Regular.ttf` | Noto Sans KR, Hangul only | Korean | OFL 1.1, `OFL-notosanskr.txt` |
| `NotoSansSinhala-Regular.ttf` | Noto Sans Sinhala | Sinhala | OFL 1.1, `OFL-notosanssinhala.txt` |
| `NotoSansOriya-Regular.ttf` | Noto Sans Oriya | Odia | OFL 1.1, `OFL-notosansoriya.txt` |
| `NotoSerifTibetan-Regular.ttf` | Noto Serif Tibetan (Google Fonts has no Noto Sans Tibetan) | Tibetan, Dzongkha | OFL 1.1, `OFL-notoseriftibetan.txt` |
| `NotoSansEthiopic-Regular.ttf` | Noto Sans Ethiopic | Amharic, Tigrinya (Ge'ez script) | OFL 1.1, `OFL-notosansethiopic.txt` |
| `NotoSansKhmer-Regular.ttf` | Noto Sans Khmer | Khmer | OFL 1.1, `OFL-notosanskhmer.txt` |
| `NotoSansMyanmar-Regular.ttf` | Noto Sans Myanmar | Burmese | OFL 1.1, `OFL-notosansmyanmar.txt` |

**Source:** `github.com/google/fonts` (`ofl/<family>`), fetched 13 Oct 2026. **Modified** (OFL §1 "Modified
Version"): each is a static instance cut from the variable font (satori draws a variable font at its default
instance only), hinting removed, and the Korean font subset to Hangul. The Noto CJK fonts carry the Reserved Font
Name "Source"; none of these files uses it. Rebuild with `scripts/build-card-fonts.sh`; `SHA256SUMS` lists the
committed bytes.

**Added in Phase 5 C** (owner decision on Phase 5 B): Sinhala, Odia, Tibetan, Ethiopic, Khmer and Myanmar,
**1,731,200 bytes (1.7 MB) for the six**, regular weight only, static instances with hinting removed; the folder is now
17 MB. `share-cards-scripts.test.ts` checks each draws ink and keeps a golden finish card per script. Known limit:
satori's shaping places Myanmar's medial ra (ြ) beside its consonant instead of around it: legible, not typographically
right.

**Not covered** (drawn as nothing rather than fetched): scripts with no font here (e.g. Lao, Armenian, Georgian, Syriac,
Thaana) and Han characters outside Noto Sans SC (rare and historic ideographs). Japanese kanji are drawn with Chinese
glyph shapes.

## Emoji

Emoji are **Twemoji** SVGs read from the `@twemoji/svg` 15.0.0 package on disk (`src/cards/text.ts`). Twemoji
graphics: Copyright 2019 Twitter, Inc. and other contributors, and jdecked's fork, licensed under
**CC-BY 4.0** (https://creativecommons.org/licenses/by/4.0/); the attribution appears here and in the app's licences screen (`apps/mobile/app/licences.tsx`, Phase 5 C).
