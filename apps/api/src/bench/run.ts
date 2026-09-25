// Bench runner (audit Part 01).
//
//   npm run bench -- [--only <regex>] [--label <name>] [--duration <s>] [--connections <n>]
//
// Starts nothing. Expects the API running locally (BENCH_URL, default
// http://localhost:3000) against the database seeded by `npm run bench:seed`.
// For query counts, start the API with BENCH_COUNT_QUERIES=1.
//
// Two passes per scenario:
//   1. Sequential: 15 requests, one at a time. Records status codes, unloaded
//      latency, and the per-request SQL statement count from the
//      x-bench-query-count header. Counts are only exact when one request is
//      in flight (see bench/query-counter.ts), which is why they come from
//      this pass and never from the load pass.
//   2. Load: autocannon, 10 connections for 10 s by default. Latency
//      percentiles are computed here from every response time autocannon
//      reports (its own summary has no p95).
//
// Writes docs/audit/perf/<label>.md and <label>.json.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';
import { signAccessToken } from '../identity/index.js';
import { makeDb, closeDb, MemoryCache } from '../platform/index.js';
import { CatalogService } from '../catalog/index.js';
import { QUERY_COUNT_HEADER } from './query-counter.js';
import { TOKENS_PATH, BENCH_EMAIL_DOMAIN } from './seed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const PERF_DIR = path.join(ROOT, 'docs/audit/perf');

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const BASE = (process.env.BENCH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const LABEL = arg('label') ?? 'run';
const ONLY = arg('only') ? new RegExp(arg('only')!, 'i') : null;
const DURATION = Number(arg('duration') ?? 10);
const CONNECTIONS = Number(arg('connections') ?? 10);
const SEQUENTIAL_N = 15;
/** Per-request limits. A timed-out request is counted at this value (a lower bound). */
const LOAD_TIMEOUT_S = 10;
const SEQUENTIAL_TIMEOUT_MS = 30_000;
const SEQUENTIAL_BUDGET_MS = 60_000;

// Budgets: PRD §43 / 00-method.md.
const BUDGET = { p50: 100, p95: 300, p99: 800, feedP95: 200, searchP95: 300 };

// ----------------------------------------------------------------- inputs

if (!fs.existsSync(TOKENS_PATH)) {
  console.error(`${TOKENS_PATH} not found. Run: npm run bench:seed`);
  process.exit(1);
}
const seedFile = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) as {
  generated_at: string;
  password: string;
  personas: Record<string, { user_id: string; username: string; email: string; following: number; followers: number }>;
  ids: Record<string, string | number | null>;
  counts: Record<string, number>;
};
type PersonaName = keyof typeof seedFile.personas;

// Tokens in tokens.json live 15 minutes; mint fresh ones from the ids.
const tokens: Record<string, string> = {};
async function refreshTokens() {
  for (const [name, p] of Object.entries(seedFile.personas)) tokens[name] = await signAccessToken(p.user_id);
}

const ids = seedFile.ids;
const P = seedFile.personas;

// -------------------------------------------------------------- scenarios

interface Scenario {
  name: string;
  group: 'search' | 'feed' | 'api' | 'auth';
  method: 'GET' | 'POST';
  persona: PersonaName | null;
  /** Called once per request. */
  path: () => string;
  body?: (phase: 'sequential' | 'load') => unknown;
  connections?: number;
  duration?: number;
  /** Fixed request count instead of a duration. */
  amount?: number;
  notes?: string[];
}

const rotate = (xs: string[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};
const q = (s: string) => `/v1/search?q=${encodeURIComponent(s)}`;

/** Search queries by kind. Filtered by preflightSearch() before use. */
const SEARCH: Record<string, string[]> = {
  prefix: ['h', 'ha', 'th', 'st', 'a', 'lo'],
  common: ['the', 'love', 'war', 'night', 'house', 'girl'],
  author: ['tolkien', 'stephen king', 'murakami', 'agatha christie', 'jane austen', 'haruki murakami'],
  cjk: ['村上', '村上春樹', 'ハリー'],
  typo: ['harry pottr', 'atomc habits', 'the hobit', 'pride and prejudise', 'lord of the rigns'],
  isbn: [],
};

async function preflightSearch(): Promise<string[]> {
  // Gap-fill (FN-32) runs on a search with < 5 local results and a query of
  // 3+ characters: it calls openlibrary.org live and WRITES the results into
  // the catalog. The load pass must do neither, so every query is checked
  // first through CatalogService WITHOUT gap-fill, read-only, against the
  // same database, and anything that would miss is dropped and reported.
  const notes: string[] = [];
  const db = makeDb(undefined, { max: 2, quiet: true });
  try {
    const catalog = new CatalogService(db, new MemoryCache());
    const [isbn] = await db.$client<{ isbn_13: string }[]>`
      SELECT e.isbn_13 FROM editions e
      WHERE e.work_id = ${String(ids.hot_work_id)} AND e.isbn_13 IS NOT NULL
      LIMIT 1
    `;
    if (isbn) SEARCH.isbn = [isbn.isbn_13, isbn.isbn_13.replace(/^(\d{3})(\d)(\d{4})(\d{4})(\d)$/, '$1-$2-$3-$4-$5')];
    for (const [kind, list] of Object.entries(SEARCH)) {
      const kept: string[] = [];
      for (const s of list) {
        if (s.trim().length < 3) { kept.push(s); continue; } // gap-fill needs 3+ characters
        const n = (await catalog.search(null, s)).length;
        // An ISBN that resolves to an edition never reaches gap-fill (it is
        // in the no-ISBN-match branch of CatalogService.search).
        const isbnHit = /^[\d\s-]{10,17}[\dXx]?$/.test(s.trim()) && n >= 1;
        if (s.trim().length >= 3 && n < 5 && !isbnHit) notes.push(`search:${kind} dropped "${s}" (${n} local results; would trigger live gap-fill)`);
        else kept.push(s);
      }
      SEARCH[kind] = kept;
    }
  } finally {
    await closeDb(db);
  }
  return notes;
}

function buildScenarios(cursors: Record<string, string | null>): Scenario[] {
  const s: Scenario[] = [];
  for (const [kind, list] of Object.entries(SEARCH)) {
    if (list.length) s.push({ name: `search:${kind}`, group: 'search', method: 'GET', persona: null, path: ((r) => () => q(r()))(rotate(list)) });
  }
  const works = [String(ids.hot_work_id)];
  s.push(
    { name: 'work:guest', group: 'api', method: 'GET', persona: null, path: () => `/v1/works/${works[0]}`, notes: ['served from a 60 s in-process cache after the first request'] },
    { name: 'work:signed-in', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/works/${works[0]}`, notes: ['served from a 60 s in-process cache after the first request'] },
    { name: 'work-reviews:friends:heavy', group: 'api', method: 'GET', persona: 'heavy', path: () => `/v1/works/${ids.hot_work_id}/reviews?sort=friends` },
    { name: 'work-reviews:friends:guest', group: 'api', method: 'GET', persona: null, path: () => `/v1/works/${ids.hot_work_id}/reviews?sort=friends` },
    { name: 'review:get', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/reviews/${ids.hot_review_id}` },
    // Part 05: single-resource authorization paths (profile, read, review).
    { name: 'read:get', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/reads/${ids.thread_read_id}` },
    { name: 'user:get', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/users/${P.heavy!.user_id}` },
    { name: 'reads:mine:reading', group: 'api', method: 'GET', persona: 'heavy', path: () => '/v1/reads?status=reading' },
    { name: 'reads:user', group: 'api', method: 'GET', persona: 'heavy', path: () => `/v1/users/${P.typical!.user_id}/reads` },
    {
      name: 'progress:post', group: 'api', method: 'POST', persona: 'typical',
      path: () => `/v1/reads/${ids.typical_reading_read_id}/progress`,
      body: () => ({ client_event_id: randomUUID(), page: 1 + Math.floor(Math.random() * 300), minutes: 20 }),
      notes: ['writes a progress_events row per request to a bench read (removed by --clean)'],
    },
    { name: 'stats:me', group: 'api', method: 'GET', persona: 'heavy', path: () => '/v1/me/stats' },
    { name: 'stats:user', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/users/${P.heavy!.user_id}/stats` },
  );
  for (const persona of ['heavy', 'typical', 'new'] as const) {
    s.push({ name: `feed:friends:${persona}`, group: 'feed', method: 'GET', persona, path: () => '/v1/feed?tab=friends' });
    const c = cursors[persona];
    s.push(c
      ? { name: `feed:friends:${persona}:page2`, group: 'feed', method: 'GET', persona, path: () => `/v1/feed?tab=friends&cursor=${encodeURIComponent(c)}` }
      : { name: `feed:friends:${persona}:page2`, group: 'feed', method: 'GET', persona, path: () => '', notes: ['SKIPPED: page 1 returned no next_cursor'] });
  }
  s.push(
    { name: 'feed:popular:guest', group: 'feed', method: 'GET', persona: null, path: () => '/v1/feed?tab=popular' },
    { name: 'followers:celebrity', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/users/${P.celebrity!.user_id}/followers` },
    { name: 'shelves:browse', group: 'api', method: 'GET', persona: 'typical', path: () => '/v1/shelves/browse' },
    { name: 'shelves:big:items', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/shelves/${ids.big_shelf_id}/items` },
    { name: 'shelves:saved', group: 'api', method: 'GET', persona: 'heavy', path: () => '/v1/shelves/saved' },
    { name: 'comments:thread', group: 'api', method: 'GET', persona: 'typical', path: () => `/v1/reads/${ids.thread_read_id}/comments` },
    { name: 'imports:list', group: 'api', method: 'GET', persona: 'heavy', path: () => '/v1/imports' },
    { name: 'exports:list', group: 'api', method: 'GET', persona: 'heavy', path: () => '/v1/exports' },
  );
  // Login: argon2 dominates by design, so low concurrency and a fixed count.
  // Each request uses a different bench account, because login is limited to
  // 10/min per email: 40 accounts at one attempt each stays under it even if
  // the scenario is re-run within the minute.
  const loginEmails = Array.from({ length: 40 }, (_, i) => `bench_u${String(2001 + i).padStart(5, '0')}@${BENCH_EMAIL_DOMAIN}`);
  const seqEmails = Array.from({ length: SEQUENTIAL_N }, (_, i) => `bench_u${String(2101 + i).padStart(5, '0')}@${BENCH_EMAIL_DOMAIN}`);
  const loadEmail = rotate(loginEmails);
  const seqEmail = rotate(seqEmails);
  s.push({
    name: 'auth:login', group: 'auth', method: 'POST', persona: null, path: () => '/v1/auth/login',
    body: (phase) => ({ email: phase === 'sequential' ? seqEmail() : loadEmail(), password: seedFile.password }),
    connections: 2, amount: loginEmails.length,
    notes: ['2 connections, 40 requests, one per account (limit is 10/min per email); creates refresh_tokens rows for bench users (removed by --clean)'],
  });
  return s;
}

// ---------------------------------------------------------------- measure

const headersFor = (persona: PersonaName | null, hasBody: boolean) => ({
  ...(persona ? { authorization: `Bearer ${tokens[persona]}` } : {}),
  ...(hasBody ? { 'content-type': 'application/json' } : {}),
});

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]! : NaN;
const median = (xs: number[]) => pct([...xs].sort((a, b) => a - b), 50);

interface SequentialResult { statuses: Record<string, number>; latencyP50: number; queries: number[] | null; sampleError: string | null; n: number }
async function sequentialPass(sc: Scenario): Promise<SequentialResult> {
  const statuses: Record<string, number> = {};
  const lat: number[] = [];
  const queries: number[] = [];
  let sampleError: string | null = null;
  const started = performance.now();
  for (let i = 0; i < SEQUENTIAL_N && performance.now() - started < SEQUENTIAL_BUDGET_MS; i++) {
    const body = sc.body?.('sequential');
    const t0 = performance.now();
    let res: Response;
    let text: string;
    try {
      res = await fetch(BASE + sc.path(), {
        method: sc.method,
        headers: headersFor(sc.persona, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(SEQUENTIAL_TIMEOUT_MS),
      });
      text = await res.text();
    } catch {
      lat.push(SEQUENTIAL_TIMEOUT_MS);
      statuses.timeout = (statuses.timeout ?? 0) + 1;
      await drain(); // the server is still working on it
      continue;
    }
    lat.push(performance.now() - t0);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    if (res.status >= 300 && !sampleError) sampleError = `${res.status} ${text.slice(0, 200)}`;
    const qc = res.headers.get(QUERY_COUNT_HEADER);
    if (qc !== null) queries.push(Number(qc));
  }
  return { statuses, latencyP50: median(lat), queries: queries.length ? queries : null, sampleError, n: lat.length };
}

// The server keeps executing a request whose client gave up (autocannon's
// timeout, or ours), so a slow scenario leaves a backlog that would be
// charged to the next one. Wait until Postgres has no active statement from
// anyone else before moving on, and report how long that took.
const statDb = makeDb(undefined, { max: 1, quiet: true });
async function drain(maxMs = 300_000): Promise<number> {
  const t0 = performance.now();
  let idle = 0;
  for (;;) {
    const [row] = await statDb.$client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()
    `;
    // A queue of pending queries shows brief gaps with nothing active, so
    // require two seconds of consecutive idle readings.
    idle = row!.n ? 0 : idle + 1;
    if (idle >= 8 || performance.now() - t0 > maxMs) return performance.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface LoadResult {
  requests: number; completed: number; unfinished: number; rps: number; p50: number; p95: number; p99: number; max: number;
  statuses: Record<string, number>; errors: number; timeouts: number; drainMs: number;
}
async function loadPass(sc: Scenario): Promise<LoadResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const instance = autocannon({
    url: BASE,
    connections: sc.connections ?? CONNECTIONS,
    timeout: LOAD_TIMEOUT_S,
    ...(sc.amount ? { amount: sc.amount } : { duration: sc.duration ?? DURATION }),
    requests: [{
      method: sc.method,
      setupRequest: (req: Record<string, unknown>) => {
        const body = sc.body?.('load');
        return {
          ...req,
          method: sc.method,
          path: sc.path(),
          headers: headersFor(sc.persona, body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        };
      },
    }],
  });
  instance.on('response', (_client: unknown, statusCode: number, _bytes: number, responseTime: number) => {
    latencies.push(responseTime);
    statuses[statusCode] = (statuses[statusCode] ?? 0) + 1;
  });
  const result = await instance;
  const completed = latencies.length;
  // Requests still in flight when the duration ends are dropped by autocannon
  // (neither a response nor a timeout). One per connection is normal; it only
  // matters when requests are so slow that few completed at all (see
  // `saturated` in the report).
  // autocannon counts a timeout as an error too, so errors ⊇ timeouts.
  const unfinished = Math.max(0, (result.requests?.sent ?? 0) - completed - result.errors);
  // autocannon reports no response for a timed-out request, so percentiles
  // over completed requests alone would describe only the fast survivors.
  // Each timeout enters the distribution at the timeout value instead.
  for (let i = 0; i < result.timeouts; i++) latencies.push(LOAD_TIMEOUT_S * 1000);
  latencies.sort((a, b) => a - b);
  const drainMs = await drain();
  return {
    requests: latencies.length, completed, unfinished,
    rps: Math.round((completed / Math.max(0.001, result.duration)) * 10) / 10,
    p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: latencies.at(-1) ?? NaN,
    statuses, errors: result.errors - result.timeouts, timeouts: result.timeouts, drainMs,
  };
}

// ------------------------------------------------------------------- main

const health = await fetch(`${BASE}/healthz`).catch(() => null);
if (!health?.ok) {
  console.error(`API not reachable at ${BASE}. Start it: cd apps/api && npm run dev (or BENCH_COUNT_QUERIES=1 npm run start)`);
  process.exit(1);
}
await refreshTokens();

const runNotes = await preflightSearch();

const cursors: Record<string, string | null> = {};
for (const persona of ['heavy', 'typical', 'new'] as const) {
  const res = await fetch(`${BASE}/v1/feed?tab=friends`, { headers: headersFor(persona, false) });
  const body = (await res.json().catch(() => ({}))) as { next_cursor?: string | null };
  cursors[persona] = body.next_cursor ?? null;
}

const scenarios = buildScenarios(cursors);
const selected = scenarios.filter((sc) => !ONLY || ONLY.test(sc.name));

const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { cwd: ROOT }).toString().trim(); } catch { return '?'; } };
const meta = {
  label: LABEL,
  date: new Date().toISOString(),
  base_url: BASE,
  commit: git('rev-parse --short HEAD'),
  dirty: git('status --porcelain') !== '',
  node: process.version,
  connections: CONNECTIONS,
  duration_s: DURATION,
  sequential_n: SEQUENTIAL_N,
  seed_generated_at: seedFile.generated_at,
  seed_counts: seedFile.counts,
  personas: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { username: v.username, following: v.following, followers: v.followers }])),
  notes: runNotes,
};

interface Row { scenario: Scenario; seq: SequentialResult | null; load: LoadResult | null; skipped: string | null }
const results: Row[] = [];
let queryCountingSeen = false;
for (const sc of selected) {
  if (sc.notes?.some((n) => n.startsWith('SKIPPED'))) {
    results.push({ scenario: sc, seq: null, load: null, skipped: sc.notes.find((n) => n.startsWith('SKIPPED'))! });
    console.log(`- ${sc.name}: skipped`);
    continue;
  }
  await refreshTokens(); // 15-minute tokens; a full run takes longer than that
  await drain();
  const seq = await sequentialPass(sc);
  if (seq.queries) queryCountingSeen = true;
  const load = await loadPass(sc);
  results.push({ scenario: sc, seq, load, skipped: null });
  const non2xx = Object.entries(load.statuses).filter(([c]) => !c.startsWith('2')).map(([c, n]) => `${c}×${n}`).join(' ');
  console.log(
    `- ${sc.name.padEnd(30)} p50 ${load.p50.toFixed(0).padStart(5)} p95 ${load.p95.toFixed(0).padStart(5)} p99 ${load.p99.toFixed(0).padStart(5)} ms` +
      `  ${String(load.rps).padStart(7)} rps  q=${seq.queries ? median(seq.queries) : '-'}${non2xx ? `  NON-2XX ${non2xx}` : ''}${load.timeouts ? `  TIMEOUTS ${load.timeouts}` : ''}${saturated(sc, load) ? `  SATURATED (${load.completed} completed)` : ''}  drain ${(load.drainMs / 1000).toFixed(1)}s`,
  );
}

// ------------------------------------------------------------------ report

function saturated(sc: Scenario, l: LoadResult) {
  return !sc.amount && l.completed < (sc.connections ?? CONNECTIONS) * 3;
}
const budgetFor = (sc: Scenario) => (sc.group === 'feed' ? BUDGET.feedP95 : sc.group === 'search' ? BUDGET.searchP95 : BUDGET.p95);
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(n < 10 ? 1 : 0) : '—');
const statusStr = (s: Record<string, number>) => Object.entries(s).map(([c, n]) => `${c}×${n}`).join(' ');

const md: string[] = [];
md.push(`# Bench: ${LABEL}`);
md.push('');
md.push(`${meta.date} · commit \`${meta.commit}\`${meta.dirty ? ' (working tree dirty)' : ''} · ${meta.base_url} · Node ${meta.node}`);
md.push('');
md.push(`Load pass: autocannon, ${CONNECTIONS} connections × ${DURATION} s per scenario (login: 2 connections × 40 requests), ${LOAD_TIMEOUT_S} s request timeout. **A timed-out request is counted in the percentiles at ${LOAD_TIMEOUT_S * 1000} ms**, so a percentile equal to that value means "at least". Sequential pass: up to ${SEQUENTIAL_N} requests one at a time (${SEQUENTIAL_TIMEOUT_MS / 1000} s timeout each, ${SEQUENTIAL_BUDGET_MS / 1000} s budget per scenario), for status codes, unloaded p50 and SQL statement counts.`);
md.push(`Between scenarios the runner waits for Postgres to have no active statement (the server keeps executing requests their clients abandoned); **Drain** is how long that took after the load pass. A large drain means the scenario left a backlog. Requests still in flight when the duration ends are dropped by autocannon (one per connection is normal). A duration scenario that completed fewer than 3 requests per connection is marked **saturated**: most of its requests never finished inside the window, so its percentiles describe only the few that did and the unloaded p50 is the better guide.`);
md.push(`Query counts: ${queryCountingSeen ? 'from `x-bench-query-count` (API started with `BENCH_COUNT_QUERIES=1`), median of the sequential pass, includes BEGIN/COMMIT' : '**not collected**: the API was not started with `BENCH_COUNT_QUERIES=1`'}.`);
md.push(`Budgets (PRD §43): p95 < ${BUDGET.p95} ms overall, feed p95 < ${BUDGET.feedP95} ms, search p95 < ${BUDGET.searchP95} ms; p50 < ${BUDGET.p50}, p99 < ${BUDGET.p99}. ⚠ marks a breach **under this load**, which is 10 concurrent connections on one local process, not a production traffic model.`);
md.push('');
md.push('| Scenario | As | Load p50 | p95 | p99 | max | req/s | Completed | Non-2xx / timeouts (load) | Drain s | Unloaded p50 | Queries/req | Sequential statuses |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const sc = r.scenario;
  if (r.skipped || !r.load || !r.seq) {
    md.push(`| ${sc.name} | ${sc.persona ?? 'guest'} | — | — | — | — | — | — | — | — | — | — | ${r.skipped ?? ''} |`);
    continue;
  }
  const l = r.load;
  const breach = [
    saturated(sc, l) ? 'saturated' : null,
    l.p50 > BUDGET.p50 ? 'p50' : null,
    l.p95 > budgetFor(sc) ? 'p95' : null,
    l.p99 > BUDGET.p99 ? 'p99' : null,
  ].filter(Boolean);
  const non2xx = Object.fromEntries(Object.entries(l.statuses).filter(([c]) => !c.startsWith('2')));
  const qs = r.seq.queries;
  md.push(
    `| ${sc.name}${breach.length ? ` ⚠ ${breach.join('/')}` : ''} | ${sc.persona ?? 'guest'} | ${fmt(l.p50)} | ${fmt(l.p95)} | ${fmt(l.p99)} | ${fmt(l.max)} | ${l.rps} | ${l.completed} | ` +
      `${Object.keys(non2xx).length || l.errors || l.timeouts || saturated(sc, l) ? `**${statusStr(non2xx)}${l.errors ? ` errors×${l.errors}` : ''}${l.timeouts ? ` timeouts×${l.timeouts}` : ''}${saturated(sc, l) ? ` unfinished×${l.unfinished}` : ''}**` : '0'} | ` +
      `${(l.drainMs / 1000).toFixed(1)} | ${fmt(r.seq.latencyP50)} | ${qs ? `${median(qs)} (${Math.min(...qs)}–${Math.max(...qs)})` : '—'} | ${statusStr(r.seq.statuses)} |`,
  );
}
md.push('');
const withNotes = results.filter((r) => r.scenario.notes?.length || r.seq?.sampleError);
if (withNotes.length || runNotes.length) {
  md.push('## Notes');
  md.push('');
  for (const n of runNotes) md.push(`- ${n}`);
  for (const r of withNotes) {
    for (const n of r.scenario.notes ?? []) md.push(`- \`${r.scenario.name}\`: ${n}`);
    if (r.seq?.sampleError) md.push(`- \`${r.scenario.name}\`: first non-2xx body: \`${r.seq.sampleError.replace(/`/g, "'")}\``);
  }
  md.push('');
}
md.push('## Personas');
md.push('');
md.push('| Persona | Username | Following | Followers |');
md.push('|---|---|---|---|');
for (const [k, v] of Object.entries(meta.personas)) md.push(`| ${k} | ${v.username} | ${v.following} | ${v.followers} |`);
md.push('');
md.push(`Seed: ${Object.entries(meta.seed_counts).map(([k, v]) => `${k} ${v}`).join(', ')} (generated ${meta.seed_generated_at}).`);
md.push('');

fs.mkdirSync(PERF_DIR, { recursive: true });
fs.writeFileSync(path.join(PERF_DIR, `${LABEL}.md`), md.join('\n'), 'utf8');
fs.writeFileSync(
  path.join(PERF_DIR, `${LABEL}.json`),
  JSON.stringify({
    meta,
    results: results.map((r) => ({
      scenario: r.scenario.name, group: r.scenario.group, method: r.scenario.method, persona: r.scenario.persona,
      notes: r.scenario.notes ?? [], skipped: r.skipped, sequential: r.seq, load: r.load,
    })),
  }, null, 2),
  'utf8',
);
console.log(`\nwrote docs/audit/perf/${LABEL}.md and .json`);
await closeDb(statDb);
