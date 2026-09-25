// Audit Part 02: emit a psql script that EXPLAINs the real SEARCH_SQL with
// the real parameter builder (searchArgs), as a guest would run it.
//
//   npx tsx src/bench/explain-search.ts [custom|generic] [query ...] > out.sql
//   docker exec -i flyleaf-pg psql -U flyleaf -d flyleaf < out.sql
//
// `generic` forces the plan Postgres would use for a NAMED prepared statement
// after five executions. The API does not use one (see #localSearch); this
// exists to show why it must not start.
import { SEARCH_SQL, searchArgs } from '../catalog/index.js';

// A deterministic 200-character string of random words: realistic nonsense,
// unlike a repeated pattern whose trigrams collapse to a handful.
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz     ';
const NONSENSE = Array.from({ length: 200 }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join('');

const QUERIES = ['a', 'th', 'the', 'harry', 'murakami', '村上', '村上春樹', 'the hobit', 'pir',
  '9780441478125', 'ishigoro', NONSENSE];

const generic = process.argv[2] === 'generic';
const lit = (v: unknown): string =>
  v === null ? 'NULL'
    : Array.isArray(v) ? `ARRAY[${v.map(lit).join(', ')}]::text[]`
    : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v);
const label = (q: string) => (q.length > 40 ? `${q.slice(0, 20)}...(${q.length})` : q).replace(/'/g, '');

const out: string[] = ['SET statement_timeout = 180000;'];
if (generic) out.push('SET plan_cache_mode = force_generic_plan;');
out.push(`PREPARE s(text, text, text, text, int, boolean, text[]) AS ${SEARCH_SQL};`);
const queries = process.argv.slice(3).length ? process.argv.slice(3) : QUERIES;
for (const q of queries) {
  out.push(`SELECT '===== ${label(q)}' AS query;`);
  out.push(`EXPLAIN (ANALYZE, BUFFERS) EXECUTE s(${searchArgs(q, 20, false).map(lit).join(', ')});`);
}
console.log(out.join('\n'));
