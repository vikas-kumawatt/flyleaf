// Baseline vs after, per scenario (Audit 15 §3). Reads two reports written by
// `npm run bench -- --label <name>` and prints docs/audit/perf/comparison.md:
//
//   npx tsx src/bench/compare.ts baseline-dev 15-after > ../../docs/audit/perf/comparison.md
//
// Budgets as the runner applies them (PRD §43 / 00-method.md): p50 < 100,
// p95 < 300 (feed < 200, search < 300), p99 < 800, all under the runner's
// load (10 connections on one local process). A scenario missing from the
// "after" report prints "TBD in 15b".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET = { p50: 100, p95: 300, p99: 800, feedP95: 200, searchP95: 300 };
const PERF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/audit/perf');

interface Result {
  scenario: string;
  group: string;
  persona: string | null;
  skipped: string | null;
  sequential?: { latencyP50: number | null; queries: number[] };
  load?: { p50: number; p95: number; p99: number; rps: number; errors: number; timeouts: number; statuses: Record<string, number> };
}
interface Report { meta: { label: string; date: string; commit: string; dirty: boolean }; results: Result[] }

const [beforeLabel, afterLabel] = process.argv.slice(2);
if (!beforeLabel || !afterLabel) {
  console.error('usage: compare.ts <before-label> <after-label>');
  process.exit(2);
}
const load = (label: string): Report | null => {
  const file = path.join(PERF, `${label}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Report) : null;
};
const before = load(beforeLabel);
if (!before) throw new Error(`no ${beforeLabel}.json in ${PERF}`);
const after = load(afterLabel);

const p95Budget = (g: string) => (g === 'feed' ? BUDGET.feedP95 : g === 'search' ? BUDGET.searchP95 : BUDGET.p95);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const ms = (x: number | null | undefined) => (x == null ? '–' : x < 10 ? x.toFixed(1) : String(Math.round(x)));
const trio = (r?: Result) => (r?.load ? `${ms(r.load.p50)} / ${ms(r.load.p95)} / ${ms(r.load.p99)}` : '–');
const breaches = (r: Result) => {
  if (!r.load) return [];
  const out: string[] = [];
  if (r.load.p50 >= BUDGET.p50) out.push('p50');
  if (r.load.p95 >= p95Budget(r.group)) out.push('p95');
  if (r.load.p99 >= BUDGET.p99) out.push('p99');
  return out;
};
const non2xx = (r?: Result) =>
  r?.load ? Object.entries(r.load.statuses).filter(([s]) => !s.startsWith('2')).reduce((n, [, c]) => n + c, 0) + r.load.timeouts : 0;

const md: string[] = [];
md.push(`# Performance: ${beforeLabel} vs ${afterLabel}`);
md.push('');
md.push(`Before: \`${beforeLabel}\` (${before.meta.date}, commit \`${before.meta.commit}\`${before.meta.dirty ? ', dirty' : ''}). ` +
  (after ? `After: \`${afterLabel}\` (${after.meta.date}, commit \`${after.meta.commit}\`${after.meta.dirty ? ', dirty' : ''}).` : `After: **TBD in 15b** (\`${afterLabel}.json\` not found).`));
md.push('');
md.push(`Load pass: 10 connections × 10 s per scenario on one local process (the Part 01 runner). Budgets (PRD §43): p50 < ${BUDGET.p50} ms, p95 < ${BUDGET.p95} ms (feed < ${BUDGET.feedP95}, search < ${BUDGET.searchP95}), p99 < ${BUDGET.p99} ms. **Pass** means the *after* run meets all three under that load. Queries are the median statements per request from the sequential pass (\`BENCH_COUNT_QUERIES=1\`).`);
md.push('');
md.push('| Scenario | As | p95 budget | Before p50 / p95 / p99 ms | After p50 / p95 / p99 ms | p95 change | Queries before → after | After non-2xx | Result |');
md.push('|---|---|---|---|---|---|---|---|---|');
const afterBy = new Map((after?.results ?? []).map((r) => [r.scenario, r]));
const names = [...before.results.map((r) => r.scenario), ...(after?.results ?? []).map((r) => r.scenario).filter((n) => !before.results.some((b) => b.scenario === n))];
let pass = 0, fail = 0, tbd = 0;
for (const name of names) {
  const b = before.results.find((r) => r.scenario === name);
  const a = afterBy.get(name);
  const group = (a ?? b)!.group;
  const qb = median(b?.sequential?.queries ?? []);
  const qa = median(a?.sequential?.queries ?? []);
  let change = '–';
  if (a?.load && b?.load) change = `${b.load.p95 >= a.load.p95 ? '' : '+'}${(((a.load.p95 - b.load.p95) / b.load.p95) * 100).toFixed(0)} %`;
  let result: string;
  if (!a || a.skipped || !a.load) { result = 'TBD in 15b'; tbd++; }
  else {
    const br = breaches(a);
    if (br.length) { result = `❌ ${br.join(', ')}`; fail++; } else { result = '✅'; pass++; }
  }
  md.push(`| ${name}${b ? '' : ' (new)'} | ${(a ?? b)!.persona ?? 'guest'} | ${p95Budget(group)} | ${trio(b)} | ${a ? trio(a) : 'TBD in 15b'} | ${change} | ${qb ?? '–'} → ${qa ?? (a ? '–' : 'TBD')} | ${a ? non2xx(a) : '–'} | ${result} |`);
}
md.push('');
md.push(`**${pass} pass, ${fail} over budget, ${tbd} TBD.** Each scenario still over budget needs its own entry below with its EXPLAIN evidence and a plan.`);
md.push('');
md.push('## Still over budget');
md.push('');
md.push(fail ? '(one entry per ❌ row: EXPLAIN (ANALYZE, BUFFERS), cause, concrete plan)' : (tbd ? 'TBD in 15b.' : 'None.'));
console.log(md.join('\n'));
