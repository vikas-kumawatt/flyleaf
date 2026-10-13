// Owner decision on Phase 5 B (13 Oct 2026), built with Phase 5 C: fonts for
// Sinhala, Odia, Tibetan, Ethiopic, Khmer and Myanmar, which drew as nothing.
//
// Two checks per script:
//   - ink: a line of that script, alone on a small canvas, draws glyphs. With
//     its font removed the same line draws nothing (resvg loads no system
//     fonts and satori skips a script it has no face for), so this fails
//     without the font: seen failing before the fonts were added.
//   - golden: a finish card titled in that script, compared like ST-08's.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CARD_HEIGHT, CARD_WIDTH, SANS_STACK, SERIF_STACK, h, toPng, toSvg } from '../cards/render.js';
import { finishCard } from '../cards/templates.js';
import { decodePng, diffRatio, pixelsNot } from './png.js';
import { finishModel } from './card-fixtures.js';

const GOLDEN_DIR = new URL('./fixtures/cards/', import.meta.url);
const GROUND: [number, number, number] = [0xf7, 0xf7, 0xf5];

/** Real titles, so the shaping (conjuncts, stacks, medial forms) is exercised. */
export const SCRIPT_TITLES: Record<string, { title: string; author: string }> = {
  sinhala: { title: 'මඩොල් දූපත', author: 'මාර්ටින් වික්‍රමසිංහ' },
  odia: { title: 'ଛ ମାଣ ଆଠ ଗୁଣ୍ଠ', author: 'ଫକୀର ମୋହନ ସେନାପତି' },
  tibetan: { title: 'བོད་ཀྱི་ལོ་རྒྱུས།', author: 'དགེ་འདུན་ཆོས་འཕེལ།' },
  ethiopic: { title: 'ፍቅር እስከ መቃብር', author: 'ሐዲስ ዓለማየሁ' },
  khmer: { title: 'ទុំទាវ', author: 'ព្រះបទុមត្ថេរ សោម' },
  myanmar: { title: 'မြန်မာ့ စာပေ', author: 'ဇော်ဂျီ' },
};

async function ink(text: string, family: string): Promise<number> {
  const node = h('div', {
    style: { display: 'flex', width: 800, height: 200, backgroundColor: '#F7F7F5', color: '#14161A', fontFamily: family, fontSize: 72, padding: 20 },
  }, text);
  const p = decodePng(toPng(await toSvg(node, { width: 800, height: 200 }), 800));
  return pixelsNot(p, GROUND, { x0: 0, y0: 0, x1: 800, y1: 200 });
}

describe('fonts for six more scripts: each draws its glyphs', () => {
  it.each(Object.entries(SCRIPT_TITLES))('%s draws ink in the sans and the serif stack', async (_name, { title }) => {
    // A line of 4–6 letters at 72 px covers thousands of pixels; nothing
    // drawn is 0.
    expect(await ink(title, SANS_STACK)).toBeGreaterThan(1500);
    expect(await ink(title, SERIF_STACK)).toBeGreaterThan(1500);
  });
});

describe('fonts for six more scripts: golden finish cards', () => {
  it.each(Object.entries(SCRIPT_TITLES))('finish-%s', async (name, { title, author }) => {
    const png = toPng(await toSvg(finishCard({ ...finishModel, title, author, cover: null, hearted: false })));
    const file = new URL(`finish-${name}.png`, GOLDEN_DIR);
    if (process.env.UPDATE_GOLDENS === '1' || !existsSync(file)) {
      if (process.env.CI) throw new Error(`golden finish-${name}.png is missing; run UPDATE_GOLDENS=1 locally and commit it`);
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, png);
    }
    const got = decodePng(png);
    const want = decodePng(readFileSync(file));
    expect([got.width, got.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect(diffRatio(got, want)).toBeLessThanOrEqual(0.005);
  }, 60_000);
});
