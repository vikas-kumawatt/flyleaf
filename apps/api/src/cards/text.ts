// Text that is safe to draw on a share card (ST-07, ST-08).
//
// Every string on a card comes from a reader or the catalog: a title of 600
// characters, a review in Arabic, a name that is only emoji, an author nobody
// recorded. Before anything is laid out it goes through here:
//
//   cleanText   Unicode NFC, well-formed; control characters and the explicit
//               bidi controls (embeddings, overrides, isolates, marks) removed,
//               because they can reorder the text around them (a name with
//               U+202E prints the handle beside it backwards); whitespace
//               collapsed. ZWJ and ZWNJ stay: emoji sequences and Persian need them.
//   clampText   at most N grapheme clusters (an emoji family or a combining
//               accent is one), with an ellipsis. Cut before layout, so the
//               card's height never depends on the text.
//   bidiLayout  the paragraph's direction (its first strong character, as
//               Unicode's P2) and its runs of words. satori lays a right-to-left
//               line out by words but loses the spaces between them, so a card
//               places each word itself (templates.ts).

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// C0 and C1 controls (tab and newline become spaces below), the bidi
// embeddings, overrides, isolates and marks, BOM, and the object replacement
// character. Not ZWJ (U+200D) or ZWNJ (U+200C).
/** A character class from code point ranges (written as numbers, so no invisible character sits in this file). */
const charClass = (ranges: Array<[number, number?]>, extra = '') =>
  `[${extra}${ranges.map(([a, b]) => (b === undefined ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)).join('')}]`;
const STRIP = new RegExp(charClass([
  [0x00, 0x08], [0x0b], [0x0c], [0x0e, 0x1f], [0x7f, 0x9f], // C0 (not tab, LF, CR) and C1 controls
  [0x200e], [0x200f], [0x061c], // LRM, RLM, ALM
  [0x202a, 0x202e], [0x2066, 0x2069], // embeddings, overrides, isolates
  [0xfeff], [0xfffc], // BOM, object replacement
]), 'gu');
const SPACES = new RegExp(charClass([[0xa0], [0x2028], [0x2029]], '\\s') + '+', 'gu');

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Combining marks kept on one character. Real text stacks at most three or
 * so (Vietnamese two, Devanagari a vowel sign, nukta and anusvara); "Zalgo"
 * text stacks dozens, and satori's line breaker then never finishes in a
 * narrow box (found by share-cards-render: a poster title hung the render).
 */
export const MAX_MARKS = 4;
const MARK = /\p{M}/u;

function capMarks(text: string): string {
  if (!MARK.test(text)) return text;
  let out = '';
  for (const { segment } of segmenter.segment(text)) {
    let marks = 0;
    for (const ch of segment) {
      if (MARK.test(ch)) {
        marks += 1;
        if (marks > MAX_MARKS) continue;
      }
      out += ch;
    }
  }
  return out;
}

/** A string fit to draw: normalised, no controls, at most MAX_MARKS marks a character, single spaces, trimmed. Empty for null. */
export function cleanText(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  return capMarks(String(input).toWellFormed().normalize('NFC').replace(STRIP, '')).replace(SPACES, ' ').trim();
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** cleanText, then at most `max` graphemes, cut at a word boundary when one is near, with an ellipsis. */
export function clampText(input: string | null | undefined, max: number): string {
  const text = cleanText(input);
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  let cut = parts.slice(0, Math.max(1, max - 1)).join('');
  // Back up to a space if one is in the last fifth, so a word is not split.
  const space = cut.lastIndexOf(' ');
  if (space > cut.length * 0.8) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** Text, or the fallback when the text is empty after cleaning. */
export function orFallback(input: string | null | undefined, fallback: string): string {
  const text = cleanText(input);
  return text === '' ? fallback : text;
}

const RTL_CHAR = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const STRONG = /[\p{L}]/u;

export type Direction = 'ltr' | 'rtl';

/** The direction of a word: its first strong character's, or null for digits, punctuation and emoji. */
export function wordDirection(word: string): Direction | null {
  for (const ch of word) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (STRONG.test(ch)) return 'ltr';
  }
  return null;
}

export const hasRtl = (text: string) => RTL_CHAR.test(text);

export interface BidiRun {
  dir: Direction;
  words: string[];
}

/**
 * A paragraph's direction and its runs of words in logical order. A word
 * with no strong character (a number, "—", an emoji) joins the run before
 * it, or the paragraph's direction at the start.
 */
export function bidiLayout(text: string): { dir: Direction; runs: BidiRun[] } {
  const words = text.split(' ').filter((w) => w !== '');
  const dir: Direction = words.map(wordDirection).find((d) => d !== null) ?? 'ltr';
  const runs: BidiRun[] = [];
  for (const word of words) {
    const d = wordDirection(word) ?? runs[runs.length - 1]?.dir ?? dir;
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.words.push(word);
    else runs.push({ dir: d, words: [word] });
  }
  return { dir, runs };
}

// ---------------------------------------------------------------------------
// Emoji: Twemoji SVGs from the @twemoji/svg package, read from disk. Never
// fetched: nothing at render time leaves the process.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const TWEMOJI_DIR = dirname(require.resolve('@twemoji/svg/package.json'));
const emojiCache = new Map<string, string>();
const ZWJ = String.fromCodePoint(0x200d);
const VS16 = String.fromCodePoint(0xfe0f);

/** The Twemoji file name for a sequence: lowercase hex code points; FE0F dropped unless the sequence has a ZWJ (Twemoji's rule). */
export function twemojiName(segment: string): string {
  const raw = segment.includes(ZWJ) ? segment : segment.split(VS16).join('');
  return Array.from(raw, (c) => c.codePointAt(0)!.toString(16)).join('-');
}

/** A data URI for one emoji, or '' when Twemoji has none (satori then draws nothing). */
export function emojiDataUri(segment: string): string {
  const cached = emojiCache.get(segment);
  if (cached !== undefined) return cached;
  const names = [twemojiName(segment), Array.from(segment.split(VS16).join(''), (c) => c.codePointAt(0)!.toString(16)).join('-')];
  let uri = '';
  for (const name of names) {
    const file = join(TWEMOJI_DIR, `${name}.svg`);
    if (/^[0-9a-f-]+$/.test(name) && existsSync(file)) {
      uri = `data:image/svg+xml;base64,${readFileSync(file).toString('base64')}`;
      break;
    }
  }
  if (emojiCache.size < 2_000) emojiCache.set(segment, uri);
  return uri;
}
