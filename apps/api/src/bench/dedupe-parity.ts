// Audit 03b: does the SQL title normalisation agree with the TypeScript one on
// THIS server? PGlite cannot answer that on its own (A-03-014), so this runs
// both over every title in the catalog, and over every code point of planes
// 0-3, and prints the disagreements.
//
//   DATABASE_URL=…/flyleaf npx tsx src/bench/dedupe-parity.ts [--examples 40]

import postgres from 'postgres';
import { config } from '../platform/index.js';
import { NORMALISED_TITLE_EXPR, SUBTITLE_EXPR, normaliseTitle, normaliseSubtitle } from '../catalog/dedupe.js';

type Example = { title: string; sql: string; ts: string; kind: string };

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--examples');
  const maxExamples = i === -1 ? 40 : Number(argv[i + 1]);
  const pg = postgres(config.databaseUrl, { max: 1 });
  const started = Date.now();
  const examples: Example[] = [];
  const note = (e: Example) => { if (examples.length < maxExamples) examples.push(e); };

  let rows = 0;
  let titleDiffs = 0;
  let subtitleDiffs = 0;
  const cursor = pg.unsafe(`
    SELECT title, ${NORMALISED_TITLE_EXPR} AS norm, ${SUBTITLE_EXPR} AS sub
    FROM works`).cursor(5000);
  for await (const batch of cursor) {
    for (const r of batch as unknown as { title: string; norm: string; sub: string }[]) {
      rows++;
      const ts = normaliseTitle(r.title);
      if (ts !== r.norm) { titleDiffs++; note({ title: r.title, sql: r.norm, ts, kind: 'title' }); }
      const tsSub = normaliseSubtitle(r.title);
      if (tsSub !== r.sub) { subtitleDiffs++; note({ title: r.title, sql: r.sub, ts: tsSub, kind: 'subtitle' }); }
    }
  }

  // Every code point, inside a word, alone, and in a subtitle: covers what the
  // catalog happens not to contain.
  const onProbe = (expr: string) => expr.replace(/\btitle\b/g, 'p');
  let codePoints = 0;
  let codePointDiffs = 0;
  const probes: string[] = [];
  for (let cp = 1; cp <= 0x3ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    probes.push(`The A${c}b ${c}: X${c}${c}y`);
  }
  for (let at = 0; at < probes.length; at += 5000) {
    const got = await pg.unsafe(
      `SELECT p, ${onProbe(NORMALISED_TITLE_EXPR)} AS norm, ${onProbe(SUBTITLE_EXPR)} AS sub
       FROM unnest($1::text[]) AS u(p)`,
      [probes.slice(at, at + 5000)],
    ) as unknown as { p: string; norm: string; sub: string }[];
    for (const r of got) {
      codePoints++;
      const ts = `${normaliseTitle(r.p)} | ${normaliseSubtitle(r.p)}`;
      const inSql = `${r.norm} | ${r.sub}`;
      if (ts !== inSql) { codePointDiffs++; note({ title: r.p, sql: inSql, ts, kind: 'codepoint' }); }
    }
  }

  await pg.end();
  console.log(JSON.stringify({
    database: config.databaseUrl.replace(/:[^:@]*@/, ':***@'),
    rows, titleDiffs, subtitleDiffs, codePoints, codePointDiffs,
    seconds: Math.round((Date.now() - started) / 1000), examples,
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
