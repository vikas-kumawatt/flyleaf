// Audit 08: the FN-43 relevance panel against a REAL database rather than the
// PGlite corpus. Same queries, same expectations and the same position rules
// as relevance.test.ts (both come from test/relevance-panel.ts); only the
// catalog differs, so this answers "did a ranking change hold on the real
// catalog", which the corpus alone cannot.
//
//   DATABASE_URL=…/flyleaf_dev npx tsx src/bench/relevance-panel.ts
//
// Read-only. An expected work missing from the database (a slice may not
// hold it) is reported and left out of the denominator.
import postgres from 'postgres';
import { config, TRIGRAM_THRESHOLD } from '../platform/index.js';
import { SEARCH_SQL, searchArgs } from '../catalog/index.js';
import { loadCorpus, buildPanel } from '../test/relevance-panel.js';

async function main() {
  // Guarded like the other search benches (audit 02d): one bad plan on the
  // full catalog must not run for minutes or claim unbounded memory. The
  // threshold is sent explicitly, as makeDb does, rather than trusting
  // ALTER DATABASE.
  const pg = postgres(config.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: {
      'pg_trgm.similarity_threshold': String(TRIGRAM_THRESHOLD),
      statement_timeout: 60_000,
      work_mem: '4MB',
    },
  });
  try {
    const corpus = loadCorpus();
    const panel = buildPanel(corpus);
    const keys = [...new Set(panel.map((c) => c.expect))];
    const found = await pg<{ id: string; ol_work_key: string; maturity: string }[]>`
      SELECT id, ol_work_key, maturity FROM works
      WHERE ol_work_key = ANY (${keys}) AND merged_into_id IS NULL`;
    const ids = new Map(found.map((r) => [r.ol_work_key, r.id]));
    // PRD §7.8 hides explicit works from a guest, and the panel searches as
    // one, so such a case can never pass. Audit 02d: these were counted as
    // misses (3 on flyleaf: Fifty Shades of Grey). Reported, not scored.
    const hidden = new Set(found.filter((r) => r.maturity === 'explicit').map((r) => r.ol_work_key));

    const byKind = new Map<string, { pass: number; total: number }>();
    const misses: string[] = [];
    let missing = 0;
    const explicit: string[] = [];
    const started = Date.now();
    for (const c of panel) {
      const id = ids.get(c.expect);
      if (!id) { missing++; continue; }
      if (hidden.has(c.expect)) { explicit.push(JSON.stringify(c.q)); continue; }
      // The API's page of 20, judged by position (as relevance.test.ts).
      const rows = (await pg.unsafe<{ id: string; title: string }[]>(
        SEARCH_SQL, searchArgs(c.q, 20, false) as never[])).slice(0, c.within);
      const hit = rows.some((r) => r.id === id);
      const t = byKind.get(c.kind) ?? { pass: 0, total: 0 };
      t.total++;
      if (hit) t.pass++;
      byKind.set(c.kind, t);
      if (!hit) {
        misses.push(`  ${c.kind.padEnd(11)} ${JSON.stringify(c.q).padEnd(34)} ` +
          `got [${rows.slice(0, 3).map((r) => r.title).join(' | ')}]`);
      }
    }
    const total = [...byKind.values()].reduce((n, t) => n + t.total, 0);
    const passed = [...byKind.values()].reduce((n, t) => n + t.pass, 0);
    const db = new URL(config.databaseUrl).pathname.slice(1);
    console.log(`relevance panel on ${db}: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)` +
      ` · ${missing} expected works absent · ${explicit.length} explicit (hidden from guests, not scored) · ${((Date.now() - started) / 1000).toFixed(0)} s`);
    for (const [kind, t] of byKind) console.log(`  ${kind.padEnd(11)} ${t.pass}/${t.total}`);
    if (explicit.length) console.log(`explicit, not scored: ${explicit.join(' ')}`);
    if (misses.length) console.log('misses:\n' + misses.join('\n'));
  } finally {
    await pg.end();
  }
}

void main();
