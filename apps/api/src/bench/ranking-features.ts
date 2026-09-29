// Audit 02d: the ranking inputs of every candidate SEARCH_SQL considers, for
// every FN-43 panel query, on a real database. SEARCH_SQL's candidate arms
// are reused verbatim (the string is cut at its final SELECT), so the
// candidate set is exactly the one search ranks; only the final ORDER BY is
// replaced by the features it is computed from. A weighting can then be
// judged offline against the whole panel without re-running the arms, which
// takes ~7 minutes per pass on the full catalog.
//
//   DATABASE_URL=…/flyleaf npx tsx src/bench/ranking-features.ts out.json
//
// Read-only; statement_timeout 60 s, work_mem 4 MB. As in relevance-panel.ts,
// the viewer is a guest, and an expected work that is absent, merged or
// explicit (hidden from guests by PRD §7.8) is recorded as such.
import fs from 'node:fs';
import postgres from 'postgres';
import { config, TRIGRAM_THRESHOLD } from '../platform/index.js';
import { SEARCH_SQL, searchArgs } from '../catalog/index.js';
import { loadCorpus, buildPanel } from '../test/relevance-panel.js';

const FINAL_SELECT = '\n  SELECT\n    w.id, w.title,';
const cut = SEARCH_SQL.indexOf(FINAL_SELECT);
if (cut < 0) throw new Error('SEARCH_SQL changed shape: final SELECT not found');

// The author test, per candidate, as SEARCH_SQL's author term writes it,
// plus whole-word matches of the query in an author name and in the title.
const FEATURES_SQL = `${SEARCH_SQL.slice(0, cut)}
  SELECT
    w.id, w.title, w.log_count,
    w.title ILIKE $4::text AS prefix,
    lower(w.title) = lower($1::text) AS exact,
    EXISTS (SELECT 1 FROM work_authors wa JOIN authors a ON a.id = wa.author_id
             WHERE wa.work_id = w.id
               AND flyleaf_author_names(a.name, a.alternate_names) ILIKE ANY ($7::text[])) AS author_sub,
    EXISTS (SELECT 1 FROM work_authors wa JOIN authors a ON a.id = wa.author_id
             WHERE wa.work_id = w.id
               AND to_tsvector('simple', flyleaf_unaccent(flyleaf_author_names(a.name, a.alternate_names)))
                   @@ plainto_tsquery('simple', flyleaf_unaccent($1::text))) AS author_word,
    to_tsvector('simple', flyleaf_unaccent(w.title)) @@ plainto_tsquery('simple', flyleaf_unaccent($1::text)) AS title_word,
    similarity(w.title, $1::text) AS sim
  FROM candidate c
  JOIN works w ON w.id = c.id
  WHERE w.merged_into_id IS NULL
    AND w.is_provisional = false
    AND (w.maturity <> 'explicit' OR $6::boolean)
`;

type Cand = {
  id: string; title: string; log_count: number; prefix: boolean; exact: boolean;
  author_sub: boolean; author_word: boolean; title_word: boolean; sim: number;
};

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: ranking-features.ts <out.json>');
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
    const byKey = new Map(found.map((r) => [r.ol_work_key, r]));
    const cases = [];
    const started = Date.now();
    for (const c of panel) {
      const expected = byKey.get(c.expect);
      let status = !expected ? 'absent' : expected.maturity === 'explicit' ? 'explicit' : 'ok';
      let cands: Cand[] = [];
      const t = Date.now();
      if (status === 'ok') {
        try {
          // Limit 20, as the API sends: $5 also gates the typo arms.
          cands = (await pg.unsafe<Cand[]>(FEATURES_SQL, searchArgs(c.q, 20, false) as never[]))
            .map((r) => ({ ...r, log_count: Number(r.log_count), sim: Number(r.sim) }));
        } catch (e) {
          // A search over the timeout is a finding, not a reason to stop.
          if ((e as { code?: string }).code !== '57014') throw e;
          status = 'timeout';
          console.log(`timeout after ${Date.now() - t} ms: ${JSON.stringify(c.q)} (${c.kind})`);
        }
      }
      cases.push({ ...c, expect_id: expected?.id ?? null, status, ms: Date.now() - t, cands });
    }
    const db = new URL(config.databaseUrl).pathname.slice(1);
    fs.writeFileSync(out, JSON.stringify({ db, at: new Date().toISOString(), cases }));
    console.log(`${cases.length} cases from ${db} in ${((Date.now() - started) / 1000).toFixed(0)} s -> ${out}`);
  } finally {
    await pg.end();
  }
}

void main();
