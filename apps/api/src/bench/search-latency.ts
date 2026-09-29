// Audit 02d: latency and plan shape of the real SEARCH_SQL on a real
// database, for a fixed set of short queries. Runs the statement the way
// CatalogService.#localSearch does (postgres.js unsafe(), an unnamed
// statement, so every run gets a custom plan) as a guest.
//
//   DATABASE_URL=…/flyleaf npx tsx src/bench/search-latency.ts [runs] [query ...]
//
// Per query: one untimed warm-up, `runs` timed runs (default 10), then one
// EXPLAIN (ANALYZE, BUFFERS) for the plan shape of every arm and the
// top-level buffers. `runs` 0 prints only the plan shapes and estimates
// (EXPLAIN without ANALYZE: nothing executes), to compare plans across
// ANALYZE runs cheaply. p95 is nearest-rank, so with 20 runs or fewer it is the
// slowest run. Read-only; statement_timeout 60 s and work_mem 4 MB (the
// server default the API runs with) on the session. BENCH_GUCS adds session
// settings for an experiment, e.g. BENCH_GUCS="effective_cache_size=512MB".
import postgres from 'postgres';
import { config, TRIGRAM_THRESHOLD } from '../platform/index.js';
import { SEARCH_SQL, searchArgs } from '../catalog/index.js';

const DEFAULT_QUERIES = ['a', 'lo', 'pir', 'the', 'har', 'king', 'th', 'le', 'ur', 'war', 'love', 'harr', 'harry', 'tolk'];

type PlanNode = {
  'Node Type': string;
  Alias?: string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Plan Rows': number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
};

const ARMS = ['fts', 'title_like', 'by_author', 'title_fuzzy', 'author_fuzzy'];

/**
 * The first scan under each arm: which access path the planner chose. The
 * arms are CTEs referenced once, so Postgres inlines them and they appear as
 * a Subquery Scan carrying the CTE's name as its alias.
 */
function armShapes(root: PlanNode): string[] {
  const out: string[] = [];
  const visit = (n: PlanNode) => {
    const cte = n['Node Type'] === 'Subquery Scan' ? n.Alias : undefined;
    if (cte && ARMS.includes(cte)) {
      const scan = firstScan(n);
      const buf = (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0);
      out.push(scan
        ? `${cte}: ${scan['Node Type']}${scan['Index Name'] ? ` ${scan['Index Name']}` : ''}` +
          ` est ${scan['Plan Rows']}` +
          (scan['Actual Rows'] === undefined ? '' : ` act ${scan['Actual Loops'] === 0 ? 'never' : scan['Actual Rows']}`) +
          `${scan['Rows Removed by Filter'] ? ` filtered ${scan['Rows Removed by Filter']}` : ''} · ${buf} buf`
        : `${cte}: (no scan)`);
    }
    n.Plans?.forEach(visit);
  };
  visit(root);
  return out;
}

function firstScan(n: PlanNode): PlanNode | null {
  if (/Scan$/.test(n['Node Type']) && n['Node Type'] !== 'CTE Scan' && n['Node Type'] !== 'Subquery Scan') return n;
  for (const c of n.Plans ?? []) {
    const s = firstScan(c);
    if (s) return s;
  }
  return null;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function main() {
  const runs = Number(process.argv[2] ?? 10);
  const queries = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_QUERIES;
  const pg = postgres(config.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: {
      'pg_trgm.similarity_threshold': String(TRIGRAM_THRESHOLD),
      statement_timeout: 60_000,
      work_mem: '4MB',
      ...Object.fromEntries((process.env.BENCH_GUCS ?? '').split(',').filter(Boolean).map((kv) => kv.split('='))),
    },
  });
  const db = new URL(config.databaseUrl).pathname.slice(1);
  console.log(`search latency on ${db} · ${runs} runs after 1 warm-up · ${new Date().toISOString()}` +
    (process.env.BENCH_GUCS ? ` · ${process.env.BENCH_GUCS}` : ''));
  try {
    for (const q of queries) {
      const args = searchArgs(q, 20, false) as never[];
      if (runs === 0) {
        const explained = await pg.unsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
          `EXPLAIN (FORMAT JSON) ${SEARCH_SQL}`, args);
        console.log(`
${JSON.stringify(q)}`);
        for (const s of armShapes(explained[0]!['QUERY PLAN'][0]!.Plan)) console.log(`    ${s}`);
        continue;
      }
      const timeOne = async () => {
        const t = performance.now();
        try {
          const rows = await pg.unsafe(SEARCH_SQL, args);
          return { ms: performance.now() - t, n: rows.length };
        } catch (e) {
          return { ms: performance.now() - t, n: -1, err: (e as Error).message };
        }
      };
      await timeOne();
      const times: number[] = [];
      let n = 0;
      let err: string | undefined;
      for (let i = 0; i < runs; i++) {
        const r = await timeOne();
        times.push(r.ms);
        n = r.n;
        err ??= r.err;
      }
      const explained = await pg.unsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SEARCH_SQL}`, args);
      const top = explained[0]!['QUERY PLAN'][0]!.Plan;
      const buf = (top['Shared Hit Blocks'] ?? 0) + (top['Shared Read Blocks'] ?? 0);
      console.log(`\n${JSON.stringify(q).padEnd(8)} p50 ${pct(times, 50)!.toFixed(0)} ms · p95 ${pct(times, 95)!.toFixed(0)} ms` +
        ` · min ${Math.min(...times).toFixed(0)} · ${n} rows · ${buf} buf (hit ${top['Shared Hit Blocks']} read ${top['Shared Read Blocks']})` +
        (err ? ` · ERROR ${err}` : ''));
      for (const s of armShapes(top)) console.log(`    ${s}`);
    }
  } finally {
    await pg.end();
  }
}

void main();
