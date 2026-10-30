// ST-07 / ST-08: the renderer and the templates, without a database.
//
//   - text.ts: what reaches a card is clean, bounded and never empty where drawn;
//   - every text field survives long, RTL, CJK, Indic, emoji, combining,
//     control-character and empty input without spilling out of its place;
//   - golden images, one per template (plus RTL and CJK finishes), compared
//     with a small tolerance: "cards look identical everywhere" (Phase 5
//     exit). UPDATE_GOLDENS=1 rewrites them (then look at every one).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MAX_MARKS, bidiLayout, clampText, cleanText, emojiDataUri, graphemes, orFallback, twemojiName } from '../cards/text.js';
import { CARD_HEIGHT, CARD_WIDTH, CardRenderer, contentHash, toPng, toSvg } from '../cards/render.js';
import { C, TEMPLATES, finishCard, profileCard, reviewCard, statCard, wallCard, yearCard } from '../cards/templates.js';
import { LIMITS, coverageLine, initials } from '../cards/index.js';
import { decodePng, diffRatio, pixelsNot, type Pixels } from './png.js';
import { HARD_STRINGS, cover, finishModel, profileModel, reviewModel, statExtremeModel, statModel, wallModel, yearCalendarModel, yearGentleModel, yearTopModel } from './card-fixtures.js';

const cp = (...points: number[]) => String.fromCodePoint(...points);
const GOLDEN_DIR = new URL('./fixtures/cards/', import.meta.url);
const GROUND: [number, number, number] = [0xf7, 0xf7, 0xf5];

async function pixels(node: ReturnType<typeof finishCard>): Promise<Pixels> {
  return decodePng(toPng(await toSvg(node)));
}

describe('ST-07: text is safe to draw', () => {
  it('removes controls and bidi overrides, keeps ZWJ, normalises and collapses spaces', () => {
    const evil = `Evil${cp(0x202e)}gnp.exe${cp(0x202c)}`;
    expect(cleanText(evil)).toBe('Evilgnp.exe');
    expect(cleanText(`a${cp(0x2066)}b${cp(0x2069)}c${cp(0x200f)}d${cp(0x0007)}e${cp(0xfeff)}`)).toBe('abcde');
    expect(cleanText(' a \n\t b ')).toBe('a b');
    expect(cleanText(`a${cp(0x2028)}b${cp(0xa0)}c`)).toBe('a b c');
    // e + combining acute → é (NFC)
    expect(cleanText(`Caf${cp(0x65, 0x301)}`)).toBe(`Caf${cp(0xe9)}`);
    const scientist = cp(0x1f469, 0x1f3fd, 0x200d, 0x1f52c);
    expect(cleanText(scientist)).toBe(scientist);
    // ZWNJ is meaningful in Persian.
    expect(cleanText(`می${cp(0x200c)}خواهم`)).toContain(cp(0x200c));
    // A lone surrogate becomes U+FFFD, never a broken string.
    expect(cleanText(`a${String.fromCharCode(0xd800)}b`)).toBe(`a${cp(0xfffd)}b`);
    // Zalgo: at most MAX_MARKS marks per character survive (more hangs satori's breaker in a narrow box).
    const zalgo = cleanText(HARD_STRINGS.combining);
    for (const g of graphemes(zalgo)) expect([...g].filter((c) => /\p{M}/u.test(c)).length).toBeLessThanOrEqual(MAX_MARKS);
    expect(cleanText('Tiếng Việt')).toBe('Tiếng Việt');
    expect(cleanText('मुंशी प्रेमचंद')).toBe('मुंशी प्रेमचंद');
    expect(cleanText(null)).toBe('');
    expect(cleanText(undefined)).toBe('');
  });

  it('clamps by grapheme, never splitting an emoji or an accent, with an ellipsis', () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(graphemes(family.repeat(3))).toHaveLength(3);
    const clamped = clampText(family.repeat(10), 4);
    expect(graphemes(clamped)).toEqual([family, family, family, '…']);
    expect(clampText('short', 10)).toBe('short');
    expect(clampText('abcdefghij klmnop', 12)).toBe('abcdefghij…'); // back to the space near the end
    expect(clampText('one two three four five six', 12)).toBe('one two thr…'); // no space near the end: cut
    expect(graphemes(clampText('x'.repeat(500), 90))).toHaveLength(90);
    expect(clampText('', 10)).toBe('');
    expect(orFallback(HARD_STRINGS.blank, 'Untitled')).toBe('Untitled');
  });

  it('finds the paragraph direction and keeps an embedded run in its own order', () => {
    expect(bidiLayout('hello world').dir).toBe('ltr');
    const he = bidiLayout(HARD_STRINGS.hebrew!);
    expect(he.dir).toBe('rtl');
    expect(he.runs.map((r) => r.dir)).toEqual(['rtl', 'ltr', 'rtl']);
    expect(he.runs[1]!.words).toEqual(['I', 'loved', 'Piranesi', 'so', 'much,']);
    // A number at the start takes the paragraph's direction from the first strong letter.
    expect(bidiLayout('2024 مئة عام').dir).toBe('rtl');
  });

  it('draws emoji from Twemoji on disk (no fetch), FE0F per Twemoji naming', () => {
    expect(twemojiName(cp(0x2764, 0xfe0f))).toBe('2764');
    expect(twemojiName(cp(0x1f469, 0x1f3fd, 0x200d, 0x1f52c))).toBe('1f469-1f3fd-200d-1f52c');
    expect(emojiDataUri(cp(0x1f4da))).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(emojiDataUri('not an emoji')).toBe('');
  });

  it('helpers: initials, coverage sentence', () => {
    expect(initials('Aisha Khan')).toBe('AK');
    expect(initials(cp(0x1f4da) + ' reader')).toBe(cp(0x1f4da) + 'R');
    expect(initials('')).toBe('?');
    expect(coverageLine({ based_on: 180, of: 247 }, ['has no page count', 'have no page count'])).toBe('Based on 180 of 247 books — 67 have no page count.');
    expect(coverageLine({ based_on: 1, of: 2 }, ['is unrated', 'are unrated'])).toBe('Based on 1 of 2 books — 1 is unrated.');
    expect(coverageLine({ based_on: 5, of: 5 }, ['x', 'y'])).toBeNull();
    expect(coverageLine({ based_on: 0, of: 0 }, ['x', 'y'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Every field, every hard string: the card renders, nothing crosses the side
// margins, and the footer (the handle watermark) is exactly where it always is.
// ---------------------------------------------------------------------------

const MARGINS = [
  { x0: 0, y0: 0, x1: 60, y1: CARD_HEIGHT },
  { x0: CARD_WIDTH - 60, y0: 0, x1: CARD_WIDTH, y1: CARD_HEIGHT },
  { x0: 0, y0: CARD_HEIGHT - 60, x1: CARD_WIDTH, y1: CARD_HEIGHT },
];
const FOOTER = { x0: 0, y0: 1700, x1: CARD_WIDTH, y1: CARD_HEIGHT };

type FieldCase = { name: string; build: (s: string) => ReturnType<typeof finishCard>; baseline: ReturnType<typeof finishCard> };
const clamp = (s: string, n: number) => clampText(s, n);
const FIELDS: FieldCase[] = [
  { name: 'finish › title', build: (s) => finishCard({ ...finishModel, title: orFallback(clamp(s, LIMITS.title), 'Untitled') }), baseline: finishCard(finishModel) },
  { name: 'finish › author', build: (s) => finishCard({ ...finishModel, author: clamp(s, LIMITS.author) || null }), baseline: finishCard(finishModel) },
  { name: 'review › quote', build: (s) => reviewCard({ ...reviewModel, quote: clamp(s, LIMITS.quote) || null }), baseline: reviewCard(reviewModel) },
  { name: 'review › title', build: (s) => reviewCard({ ...reviewModel, title: orFallback(clamp(s, LIMITS.title), 'Untitled') }), baseline: reviewCard(reviewModel) },
  { name: 'stat › caption', build: (s) => statCard({ ...statModel, caption: clamp(s, LIMITS.name) || null }), baseline: statCard(statModel) },
  { name: 'stat › bar label', build: (s) => statCard({ ...statModel, bars: [{ label: orFallback(clamp(s, LIMITS.bar), '—'), value: 3, text: '3' }] }), baseline: statCard(statModel) },
  { name: 'profile › name', build: (s) => profileCard({ ...profileModel, name: orFallback(clamp(s, LIMITS.name), 'aisha'), initials: initials(s) }), baseline: profileCard(profileModel) },
  { name: 'profile › bio', build: (s) => profileCard({ ...profileModel, bio: clamp(s, LIMITS.bio) || null }), baseline: profileCard(profileModel) },
  {
    name: 'wall › poster titles',
    build: (s) => wallCard({ ...wallModel, posters: wallModel.posters.map((p) => ({ ...p, cover: null, title: orFallback(clamp(s, LIMITS.posterTitle), 'Untitled'), author: clamp(s, LIMITS.posterAuthor) || null })) }),
    baseline: wallCard(wallModel),
  },
  { name: 'year › caption', build: (s) => yearCard({ ...yearGentleModel, caption: clamp(s, LIMITS.title) || null }), baseline: yearCard(yearGentleModel) },
  { name: 'wall › name', build: (s) => wallCard({ ...wallModel, name: orFallback(clamp(s, LIMITS.name), 'aisha') }), baseline: wallCard(wallModel) },
];

describe('ST-07: every text field is safe to render', () => {
  it.each(FIELDS.map((f) => [f.name, f] as const))('%s', async (_name, field) => {
    const base = await pixels(field.baseline);
    const problems: string[] = [];
    for (const [label, raw] of Object.entries(HARD_STRINGS)) {
      let p: Pixels;
      try {
        p = await pixels(field.build(raw));
      } catch (err) {
        problems.push(`${label}: threw ${(err as Error).message}`);
        continue;
      }
      if (p.width !== CARD_WIDTH || p.height !== CARD_HEIGHT) problems.push(`${label}: ${p.width}×${p.height}`);
      for (const m of MARGINS) {
        const n = pixelsNot(p, GROUND, m);
        if (n > 0) problems.push(`${label}: ${n} pixels drawn in the margin ${JSON.stringify(m)}`);
      }
      const footerDiff = diffRatio(p, base, 24, FOOTER);
      // The stat footer carries the coverage line, which the bar case leaves as is.
      if (footerDiff > 0) problems.push(`${label}: footer moved or overdrawn (${(footerDiff * 100).toFixed(2)}% differs)`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('a hostile name cannot reverse the handle beside it: the override is gone before layout', async () => {
    const name = orFallback(clamp(HARD_STRINGS.controls!, LIMITS.name), 'x');
    expect(name).not.toMatch(new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`, 'u'));
    const svg = await toSvg(profileCard({ ...profileModel, name }));
    expect(svg).not.toContain(cp(0x202e));
  });

  it('no image on a card is a URL: covers, avatars and emoji are data URIs', async () => {
    const svgs = await Promise.all([
      toSvg(finishCard(finishModel)), toSvg(reviewCard(reviewModel)), toSvg(statCard(statModel)),
      toSvg(profileCard({ ...profileModel, avatar: cover })), toSvg(wallCard(wallModel)),
      toSvg(finishCard({ ...finishModel, title: HARD_STRINGS.emoji! })),
    ]);
    let images = 0;
    for (const svg of svgs) {
      const hrefs = [...svg.matchAll(/href="([^"]{0,40})/g)].map((m) => m[1]!);
      images += hrefs.length;
      for (const href of hrefs) expect(href.startsWith('data:') || href.startsWith('#')).toBe(true);
      // The SVG namespace (plain, or URL-encoded inside an inline icon's data URI) is a name, not a fetch.
      expect(svg.replace(/xmlns=(?:"|%22)http:\/\/www\.w3\.org\/2000\/svg(?:"|%22)/g, '')).not.toMatch(/https?:\/\//);
    }
    // Covers, the avatar, emoji and icons were all checked, not zero images.
    expect(images).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Golden images. Tolerance: a pixel differs when a channel moves by more than
// 24/255; at most 0.5% of pixels may differ (anti-aliasing across CPUs and
// resvg builds). A changed layout or font moves far more than that.
// ---------------------------------------------------------------------------

const GOLDENS: Array<[string, ReturnType<typeof finishCard>]> = [
  ['finish', finishCard(finishModel)],
  ['finish-rtl', finishCard({ ...finishModel, title: 'مئة عام من العزلة', author: 'غابرييل غارسيا ماركيث', cover: null, rating: 3, hearted: false })],
  ['finish-cjk', finishCard({ ...finishModel, title: `三体 ノルウェイの森 채식주의자 ${cp(0x1f4da)}`, author: '刘慈欣', rating: 5, hearted: false, finishedOn: null })],
  ['review', reviewCard(reviewModel)],
  ['stat', statCard(statModel)],
  ['stat-extreme', statCard(statExtremeModel)],
  ['year-calendar', yearCard(yearCalendarModel)],
  ['year-top', yearCard(yearTopModel)],
  ['year-gentle', yearCard(yearGentleModel)],
  ['profile', profileCard(profileModel)],
  ['wall-4x4', wallCard(wallModel)],
  ['wall-3x5', wallCard({ ...wallModel, layout: '3x5', count: 7, year: '2026', posters: wallModel.posters.slice(0, 7) })],
];

describe('ST-08: golden images (cards look identical everywhere)', () => {
  it.each(GOLDENS)('%s', async (name, node) => {
    const png = toPng(await toSvg(node));
    const file = new URL(`${name}.png`, GOLDEN_DIR);
    if (process.env.UPDATE_GOLDENS === '1' || !existsSync(file)) {
      if (process.env.CI) throw new Error(`golden ${name}.png is missing; run UPDATE_GOLDENS=1 locally and commit it`);
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, png);
    }
    const got = decodePng(png);
    const want = decodePng(readFileSync(file));
    expect([got.width, got.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect(diffRatio(got, want)).toBeLessThanOrEqual(0.005);
  }, 60_000);

  it('the comparison is not blind: a one-word change fails it', async () => {
    const a = decodePng(toPng(await toSvg(finishCard(finishModel))));
    const b = decodePng(toPng(await toSvg(finishCard({ ...finishModel, title: 'Piranesi!' }))));
    const c = decodePng(toPng(await toSvg(finishCard({ ...finishModel, rating: 4 }))));
    expect(diffRatio(a, b)).toBeGreaterThan(0.0005);
    expect(diffRatio(a, c)).toBeGreaterThan(0.0001);
    expect(diffRatio(a, a)).toBe(0);
  }, 60_000);
});

describe('ST-07: the render cache', () => {
  it('same content, one render; any change in content, a new one', async () => {
    const r = new CardRenderer();
    const draw = () => TEMPLATES.finish(finishModel);
    const a = await r.render('finish', finishModel, draw);
    const b = await r.render('finish', finishModel, draw);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.hash).toBe(a.hash);
    expect(b.png.equals(a.png)).toBe(true);
    expect(r.renders).toBe(1);
    const changed = { ...finishModel, rating: 4 };
    const c = await r.render('finish', changed, () => TEMPLATES.finish(changed));
    expect(c.hash).not.toBe(a.hash);
    expect(r.renders).toBe(2);
    expect(contentHash('finish', finishModel)).toBe(a.hash);
    expect(contentHash('review', finishModel)).not.toBe(a.hash);
  }, 30_000);

  it('two requests for the same new card render it once', async () => {
    const r = new CardRenderer();
    const draw = () => TEMPLATES.finish(finishModel);
    await Promise.all([r.render('finish', finishModel, draw), r.render('finish', finishModel, draw), r.render('finish', finishModel, draw)]);
    expect(r.renders).toBe(1);
  }, 30_000);

  it('is bounded in bytes, least recently used out first', async () => {
    const r = new CardRenderer({ maxCacheBytes: 150_000 });
    const models = [1, 2, 3, 4].map((n) => ({ ...finishModel, title: `Book ${n}` }));
    for (const m of models) await r.render('finish', m, () => TEMPLATES.finish(m));
    expect(r.cachedBytes).toBeLessThanOrEqual(150_000);
    const again = await r.render('finish', models[0]!, () => TEMPLATES.finish(models[0]!));
    expect(again.cached).toBe(false);
    const last = await r.render('finish', models[3]!, () => TEMPLATES.finish(models[3]!));
    expect(last.cached).toBe(true);
  }, 60_000);
});

// Keep the palette honest: the card background the margin checks assume.
it('the card ground is design.md ground', () => {
  expect(C.ground.toLowerCase()).toBe('#fafafa');
});
