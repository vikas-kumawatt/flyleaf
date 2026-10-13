// Share-card render cost (ST-07): time and memory per template, rendering
// new content each time (no cache hits). No database: the cost of a card is
// satori + resvg; its queries are the screens' own (stats, reads).
//
//   npm run bench:cards [-- --runs 30]
//
// Prints a markdown table. Say where it ran: a sandbox number is not a
// server number.

import { performance } from 'node:perf_hooks';
import os from 'node:os';

import { cardFonts, releaseRenderMemory, toPng, toSvg } from '../cards/render.js';
import { TEMPLATES } from '../cards/templates.js';
import { HARD_STRINGS, finishModel, profileModel, reviewModel, statModel, wallModel } from '../test/card-fixtures.js';

/** `--no-gc`: leave native memory to V8 (shows why the renderer collects). */
const noGc = process.argv.includes('--no-gc');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 30;
const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

const cases: Array<[string, keyof typeof TEMPLATES, (i: number) => unknown]> = [
  ['finish', 'finish', (i) => ({ ...finishModel, title: `Piranesi ${i}` })],
  ['finish (CJK title)', 'finish', (i) => ({ ...finishModel, title: `${HARD_STRINGS.cjk!.slice(0, 40)} ${i}` })],
  ['finish (Arabic title)', 'finish', (i) => ({ ...finishModel, title: `${HARD_STRINGS.arabic} ${i}` })],
  ['review', 'review', (i) => ({ ...reviewModel, quote: `${reviewModel.quote} ${i}` })],
  ['stat', 'stat', (i) => ({ ...statModel, value: String(i) })],
  ['profile', 'profile', (i) => ({ ...profileModel, booksThisYear: i })],
  ['wall 4×4', 'wall', (i) => ({ ...wallModel, count: 300 + i })],
  ['wall 3×5', 'wall', (i) => ({ ...wallModel, layout: '3x5', count: 300 + i, posters: wallModel.posters.slice(0, 15) })],
];

async function main() {
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  cardFonts();
  await toSvg(TEMPLATES.finish(finishModel));
  const coldMs = performance.now() - t0;
  const rssAfterFonts = process.memoryUsage().rss;

  console.log(`Share-card render bench (ST-07) · **sandbox**${noGc ? ' · --no-gc' : ''} · ${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length}, ${mb(os.totalmem())} MB RAM, Node ${process.version}, ${process.arch}`);
  console.log(`\nFirst render (fonts read and parsed): ${coldMs.toFixed(0)} ms; RSS ${mb(rss0)} → ${mb(rssAfterFonts)} MB.\n`);
  console.log('| Card | runs | satori p50 / p95 (ms) | resvg + GC p50 / p95 (ms) | total p50 / p95 (ms) | PNG KB | RSS after (MB) | peak RSS (MB) |');
  console.log('|---|---|---|---|---|---|---|---|');
  let peak = rssAfterFonts;
  for (const [name, template, model] of cases) {
    const s: number[] = [];
    const r: number[] = [];
    let size = 0;
    for (let i = 0; i < runs; i++) {
      const a = performance.now();
      const svg = await toSvg((TEMPLATES[template] as (m: unknown) => ReturnType<typeof TEMPLATES.finish>)(model(i)));
      const b = performance.now();
      const png = toPng(svg);
      if (!noGc) await releaseRenderMemory();
      else await new Promise((resolve) => setImmediate(resolve)); // a request yields either way
      const c = performance.now();
      s.push(b - a);
      r.push(c - b);
      size = png.length;
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    const tot = s.map((x, i) => x + r[i]!);
    console.log(`| ${name} | ${runs} | ${pct(s, 50).toFixed(0)} / ${pct(s, 95).toFixed(0)} | ${pct(r, 50).toFixed(0)} / ${pct(r, 95).toFixed(0)} | ${pct(tot, 50).toFixed(0)} / ${pct(tot, 95).toFixed(0)} | ${(size / 1024).toFixed(0)} | ${mb(process.memoryUsage().rss)} | ${mb(peak)} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
