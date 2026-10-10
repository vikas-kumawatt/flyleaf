// EXPLAIN (ANALYZE, BUFFERS) of every read statement one feed request sends
// (Audit 14 hand-over, run in 15b). Part 14's plans were taken by hand in the
// sandbox; this makes them repeatable on `flyleaf_dev`:
//
//   npx tsx src/bench/feed-explain.ts [--persona heavy] [--tab friends|popular] [--page 2]
//
// Builds the real app in this process against DATABASE_URL, records every
// statement (text and parameters) the request sends through postgres.js's
// `debug` hook, then runs EXPLAIN (ANALYZE, BUFFERS) on each SELECT/WITH that
// writes nothing. Statements that write (Popular's exposure count) are listed
// but not explained, so the run changes nothing beyond what the request
// itself does. Needs the bench seed (`npm run bench:seed`) for the personas.

import fs from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../db/schema.js';
import { buildApp } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { config, PgRateLimiter } from '../platform/index.js';
import { TOKENS_PATH } from './seed.js';

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? d : String(process.argv[i + 1]);
};
const persona = arg('persona', 'heavy');
const tab = arg('tab', 'friends');
const page = Number(arg('page', '1'));

let who: { user_id: string } | null = null;
if (persona !== 'guest') {
  if (!fs.existsSync(TOKENS_PATH)) {
    console.error(`${TOKENS_PATH} not found. Run: npm run bench:seed`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) as { personas: Record<string, { user_id: string }> };
  who = seed.personas[persona] ?? null;
  if (!who) throw new Error(`no persona ${persona} in ${TOKENS_PATH}`);
}

let recording = false;
const seen: { query: string; params: unknown[] }[] = [];
const client = postgres(config.databaseUrl, {
  max: 4,
  idle_timeout: 30,
  onnotice: () => {},
  debug: (_conn, query, params) => {
    if (recording) seen.push({ query, params: params as unknown[] });
  },
});
const db = drizzle(client, { schema });
const app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), reading: new ReadingService(db) });
await app.ready();

try {
  const headers: Record<string, string> = who ? { authorization: `Bearer ${await signAccessToken(who.user_id)}` } : {};
  // Warm-up: the first connection fetches type metadata; keep it out.
  await app.inject({ method: 'GET', url: `/v1/feed?tab=${tab}&limit=20`, headers });
  let cursor: string | null = null;
  for (let p = 1; p <= page; p++) {
    recording = p === page;
    const url: string = `/v1/feed?tab=${tab}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const t0 = performance.now();
    const res: { statusCode: number; body: string; json: () => any } = await app.inject({ method: 'GET', url, headers });
    const ms = performance.now() - t0;
    if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
    const body: { items: unknown[]; next_cursor: string | null } = res.json();
    if (p === page) console.log(`# GET ${url} as ${persona}: ${res.statusCode}, ${body.items.length} items, ${ms.toFixed(1)} ms, ${seen.length} statements\n`);
    cursor = body.next_cursor;
    if (!cursor && p < page) throw new Error(`no page ${p + 1}`);
  }
  recording = false;
  for (const [i, s] of seen.entries()) {
    const text = s.query.trim();
    const reads = /^(select|with)\b/i.test(text) && !/\b(insert|update|delete)\b/i.test(text);
    console.log(`## Statement ${i + 1}${reads ? '' : ' (writes or control: not explained)'}\n\n${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}\n`);
    if (!reads) continue;
    const plan = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, s.params as never[]);
    console.log('```\n' + plan.map((r) => r['QUERY PLAN']).join('\n') + '\n```\n');
  }
} finally {
  await app.close();
  await client.end({ timeout: 5 });
}
