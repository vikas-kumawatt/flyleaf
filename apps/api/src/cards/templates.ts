// Share-card templates (ST-08; PRD §6.45, §6.37a, §29.1 loop 1, AC-18):
// finish, review quote, stat, profile and Wall collage. Portrait story size
// (1080 × 1920), light palette and type from design.md (§2, §3), the reader's
// handle on every card (§29.1 "handle watermark on every card").
//
// A template draws its model and nothing else: every string in a model has
// been through text.ts (clean, clamped, never empty where it is drawn), every
// image is a data: URI from our own storage, and every number was computed
// before it got here (service.ts). A template never invents a figure: when
// a model field is null, its line is left out.

import { CARD_HEIGHT, CARD_WIDTH, SANS_STACK, SERIF_STACK, h, type CardChild, type CardNode } from './render.js';
import { bidiLayout, hasRtl } from './text.js';

/** design.md §2, light. Tokens only: no colour literal outside this table. */
export const C = {
  ground: '#F7F7F5',
  surface: '#FFFFFF',
  surface2: '#EFEFEC',
  ink: '#14161A',
  ink2: '#43484F',
  muted: '#6E747C',
  line: '#E2E2DE',
  lineStrong: '#CBCBC5',
  accent: '#2F5D50',
  star: '#C8951F',
  heart: '#A8443A',
} as const;

export interface CardImage {
  /** data:image/...;base64,... — never a URL. */
  uri: string;
}

export interface Poster {
  title: string;
  author: string | null;
  cover: CardImage | null;
}

export interface FinishModel {
  handle: string;
  title: string;
  author: string | null;
  cover: CardImage | null;
  rating: number | null;
  hearted: boolean;
  /** "12 Oct 2026", or null when the finish is undated. */
  finishedOn: string | null;
}

export interface ReviewModel {
  handle: string;
  name: string;
  title: string;
  author: string | null;
  cover: CardImage | null;
  rating: number | null;
  /** null when the review is marked as containing spoilers: the card never shows that text. */
  quote: string | null;
}

export interface StatBar {
  label: string;
  value: number;
  /** What the bar says beside it ("12", "40%"). */
  text: string;
}

export interface StatModel {
  handle: string;
  /** "2026" or "All time". */
  period: string;
  heading: string;
  /** The figure, formatted. */
  value: string;
  /** A line under the figure ("books", "Brandon Sanderson"). */
  caption: string | null;
  /** A second line ("12 Mar – 27 Apr 2025"). */
  detail: string | null;
  bars: StatBar[];
  /** ST-03: "Based on 180 of 247 books — 67 have no page count." null when nothing is missing. */
  coverage: string | null;
}

export interface ProfileModel {
  handle: string;
  name: string;
  initials: string;
  avatar: CardImage | null;
  bio: string | null;
  favourites: Poster[];
  year: number;
  booksThisYear: number;
  booksAllTime: number;
}

export type WallLayout = '4x4' | '3x5';

export interface WallModel {
  handle: string;
  name: string;
  layout: WallLayout;
  /** All the books on the wall, not just those drawn. */
  count: number;
  posters: Poster[];
  /** "2026" when filtered to a year, else null. */
  year: string | null;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const PAD = 88;

function frame(...children: CardChild[]): CardNode {
  return h('div', {
    style: {
      width: CARD_WIDTH, height: CARD_HEIGHT, display: 'flex', flexDirection: 'column',
      backgroundColor: C.ground, color: C.ink, fontFamily: SANS_STACK, padding: PAD,
    },
  }, ...children);
}

/**
 * Text that may be right-to-left. Left-to-right text is one node (satori
 * wraps it). Text with Hebrew or Arabic is laid out word by word in the
 * paragraph's direction, an embedded run of the other direction kept in its
 * own order, because satori drops the spaces between right-to-left words.
 */
export function textBlock(
  text: string,
  style: Record<string, unknown>,
  opts: { lines: number; lineHeight: number; align?: 'start' | 'center' },
): CardNode {
  const maxHeight = opts.lines * opts.lineHeight;
  const center = opts.align === 'center';
  if (!hasRtl(text)) {
    // Centred: no width of its own (satori ignores textAlign on a one-line
    // block that is given width: 100%); its parent centres it.
    const { width: _width, ...rest } = style;
    return h('div', {
      style: {
        display: 'block', lineHeight: `${opts.lineHeight}px`, maxHeight, overflow: 'hidden', wordBreak: 'break-word',
        lineClamp: opts.lines, textAlign: center ? 'center' : 'left', ...(center ? { maxWidth: '100%', ...rest } : style),
      },
    }, text);
  }
  const { dir, runs } = bidiLayout(text);
  const gap = Math.round(Number(style.fontSize ?? 32) * 0.28);
  const word = (w: string, i: number) => h('div', { key: String(i), style: { display: 'flex', lineHeight: `${opts.lineHeight}px`, wordBreak: 'break-word', maxWidth: '100%' } }, w);
  const items = runs.map((run, i) => (run.dir === dir
    ? run.words.map(word)
    : [h('div', {
        key: `run${i}`,
        style: { display: 'flex', flexDirection: run.dir === 'rtl' ? 'row-reverse' : 'row', flexWrap: 'wrap', columnGap: gap },
      }, ...run.words.map(word))])).flat();
  return h('div', {
    style: {
      display: 'flex', flexDirection: dir === 'rtl' ? 'row-reverse' : 'row', flexWrap: 'wrap',
      justifyContent: center ? 'center' : 'flex-start', columnGap: gap, maxHeight, overflow: 'hidden', ...style,
    },
  }, ...items);
}

const STAR_PATH = 'M12 2.5l2.94 6.1 6.56.86-4.8 4.62 1.2 6.52L12 17.4l-5.9 3.2 1.2-6.52-4.8-4.62 6.56-.86z';
const HEART_PATH = 'M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.6 4.5c2.2 0 3.6 1.2 5.4 3.2 1.8-2 3.2-3.2 5.4-3.2 3.7 0 5.7 3.9 4.2 7.3C19.5 16.4 12 21 12 21z';

function star(size: number, fill: 'full' | 'half' | 'empty', key: string): CardNode {
  const icon = (color: string) => h('svg', { width: size, height: size, viewBox: '0 0 24 24' }, h('path', { d: STAR_PATH, fill: color }));
  if (fill !== 'half') {
    return h('div', { key, style: { display: 'flex', width: size, height: size } }, icon(fill === 'full' ? C.star : C.lineStrong));
  }
  return h('div', { key, style: { display: 'flex', position: 'relative', width: size, height: size } },
    icon(C.lineStrong),
    h('div', { style: { position: 'absolute', left: 0, top: 0, width: size / 2, height: size, overflow: 'hidden', display: 'flex' } }, icon(C.star)));
}

/** Five stars and the numeral beside them (design.md §2 rule 4: never colour alone). */
export function ratingRow(rating: number, size: number, center = false): CardNode {
  const stars = [0, 1, 2, 3, 4].map((i) => star(size, rating >= i + 1 ? 'full' : rating >= i + 0.5 ? 'half' : 'empty', `s${i}`));
  return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: center ? 'center' : 'flex-start', gap: Math.round(size * 0.12) } },
    ...stars,
    h('div', { style: { display: 'flex', marginLeft: Math.round(size * 0.3), fontSize: Math.round(size * 0.72), fontWeight: 600, color: C.ink } },
      rating % 1 === 0 ? rating.toFixed(0) : rating.toFixed(1)));
}

function heart(size: number): CardNode {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24' }, h('path', { d: HEART_PATH, fill: C.heart }));
}

/** A cover, or a typographic poster in its place so a grid never has a hole (PRD §6.37a). */
export function poster(p: Poster, w: number, hgt: number, key?: string): CardNode {
  const box = { width: w, height: hgt, borderRadius: Math.max(4, Math.round(w * 0.03)), flexShrink: 0 };
  if (p.cover) {
    return h('img', { key, src: p.cover.uri, width: w, height: hgt, style: { ...box, objectFit: 'cover', border: `1px solid ${C.line}` } });
  }
  const titleSize = Math.max(14, Math.round(w * 0.11));
  const authorSize = Math.max(11, Math.round(w * 0.065));
  return h('div', {
    key,
    style: {
      ...box, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      backgroundColor: C.surface2, border: `1px solid ${C.lineStrong}`, padding: Math.round(w * 0.09), overflow: 'hidden',
    },
  },
  textBlock(p.title, { fontFamily: SERIF_STACK, fontWeight: 600, fontSize: titleSize, color: C.ink },
    { lines: 5, lineHeight: Math.round(titleSize * 1.2) }),
  p.author ? textBlock(p.author, { fontSize: authorSize, color: C.ink2 }, { lines: 2, lineHeight: Math.round(authorSize * 1.3) }) : null);
}

function label(text: string): CardNode {
  return h('div', { style: { display: 'flex', fontSize: 26, fontWeight: 600, letterSpacing: '0.12em', color: C.muted } }, text.toUpperCase());
}

/** The watermark on every card: the reader's handle and where to find them. */
function footer(handle: string, note?: string | null): CardNode {
  return h('div', {
    style: { display: 'flex', flexDirection: 'column', marginTop: 'auto', paddingTop: 36, borderTop: `2px solid ${C.line}`, gap: 8 },
  },
  note ? h('div', { style: { display: 'flex', fontSize: 24, color: C.muted } }, note) : null,
  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
    h('div', { style: { display: 'flex', fontSize: 36, fontWeight: 600, color: C.ink } }, `@${handle}`),
    h('div', { style: { display: 'flex', fontFamily: SERIF_STACK, fontSize: 34, fontWeight: 600, color: C.accent } }, 'flyleaf.app')));
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function finishCard(m: FinishModel): CardNode {
  return frame(
    h('div', { style: { display: 'flex', justifyContent: 'center' } }, label(m.finishedOn ? `Finished · ${m.finishedOn}` : 'Finished')),
    h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 56 } },
      poster({ title: m.title, author: m.author, cover: m.cover }, 560, 840)),
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 56, gap: 20 } },
      textBlock(m.title, { fontFamily: SERIF_STACK, fontWeight: 600, fontSize: 64, color: C.ink, width: '100%' },
        { lines: 3, lineHeight: 78, align: 'center' }),
      m.author
        ? textBlock(m.author, { fontSize: 36, color: C.ink2, width: '100%' }, { lines: 1, lineHeight: 46, align: 'center' })
        : null,
      m.rating !== null || m.hearted
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 28, marginTop: 12 } },
            m.rating !== null ? ratingRow(m.rating, 56, true) : null,
            m.hearted ? heart(56) : null)
        : null),
    footer(m.handle),
  );
}

export function reviewCard(m: ReviewModel): CardNode {
  return frame(
    h('div', { style: { display: 'flex', gap: 40, alignItems: 'flex-start' } },
      poster({ title: m.title, author: m.author, cover: m.cover }, 220, 330),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, flexGrow: 1, flexShrink: 1, width: 0 } },
        label('Review'),
        textBlock(m.title, { fontFamily: SERIF_STACK, fontWeight: 600, fontSize: 52, color: C.ink }, { lines: 3, lineHeight: 64 }),
        m.author ? textBlock(m.author, { fontSize: 32, color: C.ink2 }, { lines: 1, lineHeight: 42 }) : null,
        m.rating !== null ? h('div', { style: { display: 'flex', marginTop: 8 } }, ratingRow(m.rating, 44)) : null)),
    h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 72, flexGrow: 1 } },
      m.quote !== null
        ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
            h('div', { style: { display: 'flex', fontFamily: SERIF_STACK, fontSize: 160, lineHeight: '120px', height: 100, color: C.lineStrong } }, '“'),
            textBlock(m.quote, { fontFamily: SERIF_STACK, fontSize: 44, color: C.ink }, { lines: 15, lineHeight: 64 }))
        : h('div', { style: { display: 'flex', fontFamily: SERIF_STACK, fontSize: 44, lineHeight: '60px', color: C.ink2 } },
            'This review contains spoilers. Read it on Flyleaf.')),
    footer(m.handle, `— ${m.name}`),
  );
}

export function statCard(m: StatModel): CardNode {
  const max = Math.max(1, ...m.bars.map((b) => b.value));
  return frame(
    label(m.period),
    h('div', { style: { display: 'flex', fontFamily: SERIF_STACK, fontWeight: 600, fontSize: 64, lineHeight: '78px', marginTop: 24 } }, m.heading),
    h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 48, gap: 8 } },
      h('div', { style: { display: 'flex', fontSize: m.value.length > 6 ? 150 : 220, fontWeight: 600, lineHeight: 1, color: C.ink } }, m.value),
      m.caption ? textBlock(m.caption, { fontFamily: SERIF_STACK, fontWeight: 600, fontSize: 56, color: C.ink }, { lines: 2, lineHeight: 70 }) : null,
      m.detail ? h('div', { style: { display: 'flex', fontSize: 36, color: C.ink2, marginTop: 8 } }, m.detail) : null),
    m.bars.length > 0
      ? h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 64, gap: 22 } },
          ...m.bars.map((b, i) => h('div', { key: `b${i}`, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 30, color: C.ink2 } },
              textBlock(b.label, { fontSize: 30, color: C.ink2, flexShrink: 1 }, { lines: 1, lineHeight: 38 }),
              h('div', { style: { display: 'flex', fontWeight: 600, color: C.ink, marginLeft: 24 } }, b.text)),
            h('div', { style: { display: 'flex', height: 18, borderRadius: 9, backgroundColor: C.surface2 } },
              h('div', { style: { display: 'flex', width: `${Math.max(2, Math.round((b.value / max) * 100))}%`, height: 18, borderRadius: 9, backgroundColor: C.ink2 } })))))
      : null,
    footer(m.handle, [m.coverage, 'Counted from public reads only.'].filter(Boolean).join(' ')),
  );
}

export function profileCard(m: ProfileModel): CardNode {
  const AVATAR = 240;
  return frame(
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 40, gap: 20 } },
      m.avatar
        ? h('img', { src: m.avatar.uri, width: AVATAR, height: AVATAR, style: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, objectFit: 'cover', border: `2px solid ${C.line}` } })
        : h('div', {
            style: {
              display: 'flex', width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: C.surface2,
              alignItems: 'center', justifyContent: 'center', fontFamily: SERIF_STACK, fontSize: 96, fontWeight: 600, color: C.ink2,
            },
          }, m.initials),
      textBlock(m.name, { fontFamily: SERIF_STACK, fontWeight: 600, fontSize: 72, color: C.ink, width: '100%' }, { lines: 2, lineHeight: 86, align: 'center' }),
      h('div', { style: { display: 'flex', fontSize: 36, color: C.muted } }, `@${m.handle}`),
      m.bio ? textBlock(m.bio, { fontFamily: SERIF_STACK, fontSize: 34, color: C.ink2, width: '100%' }, { lines: 3, lineHeight: 48, align: 'center' }) : null),
    m.favourites.length > 0
      ? h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 64, gap: 24 } },
          label('Four favourites'),
          h('div', { style: { display: 'flex', gap: 24 } }, ...m.favourites.slice(0, 4).map((p, i) => poster(p, 210, 315, `f${i}`))))
      : null,
    h('div', { style: { display: 'flex', marginTop: 64, gap: 48 } },
      stat(m.booksThisYear, `${m.booksThisYear === 1 ? 'book' : 'books'} in ${m.year}`),
      stat(m.booksAllTime, `${m.booksAllTime === 1 ? 'book' : 'books'} read`)),
    footer(m.handle, 'Counted from public reads only.'),
  );
}

function stat(n: number, caption: string): CardNode {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    h('div', { style: { display: 'flex', fontSize: 88, fontWeight: 600, lineHeight: 1 } }, n.toLocaleString('en-GB')),
    h('div', { style: { display: 'flex', fontSize: 30, color: C.ink2 } }, caption));
}

export const WALL_GRID: Record<WallLayout, { cols: number; rows: number }> = {
  '4x4': { cols: 4, rows: 4 },
  '3x5': { cols: 3, rows: 5 },
};

export function wallCard(m: WallModel): CardNode {
  const { cols, rows } = WALL_GRID[m.layout];
  const GAP = 16;
  const width = CARD_WIDTH - 2 * PAD;
  const height = 1380;
  // Size for the rows drawn, so a short wall is not a few stamps in a big frame.
  const rowsDrawn = Math.max(1, Math.min(rows, Math.ceil(m.posters.length / cols)));
  // The largest 2:3 poster that fits both ways.
  const w = Math.floor(Math.min((width - (cols - 1) * GAP) / cols, ((height - (rowsDrawn - 1) * GAP) / Math.max(rowsDrawn, 3)) * (2 / 3)));
  const hgt = Math.floor(w * 1.5);
  const rowNodes: CardNode[] = [];
  for (let r = 0; r * cols < m.posters.length; r++) {
    rowNodes.push(h('div', { key: `r${r}`, style: { display: 'flex', gap: GAP, justifyContent: 'center' } },
      ...m.posters.slice(r * cols, r * cols + cols).map((p, i) => poster(p, w, hgt, `p${i}`))));
  }
  return frame(
    label(m.year ? `The Wall · ${m.year}` : 'The Wall'),
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 16, gap: 24 } },
      textBlock(m.name, { fontFamily: SERIF_STACK, fontWeight: 600, fontSize: 60, color: C.ink, flexShrink: 1 }, { lines: 1, lineHeight: 74 }),
      h('div', { style: { display: 'flex', fontSize: 36, color: C.ink2, flexShrink: 0 } }, `${m.count.toLocaleString('en-GB')} ${m.count === 1 ? 'book' : 'books'}`)),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: GAP, marginTop: 40 } }, ...rowNodes),
    footer(m.handle, 'Public reads only.'),
  );
}

export const TEMPLATES = {
  finish: finishCard,
  review: reviewCard,
  stat: statCard,
  profile: profileCard,
  wall: wallCard,
} as const;
