// Drives the API's main paths, and every background job, against an API and
// a worker that connect as flyleaf_app (deploy/db/roles.sql): rows only, no
// DDL. A statement that needs more than that fails here as a 500 or a failed
// job, with the Postgres error in the process logs. Run by sandbox-e2e.sh.
//
//   API_URL=http://127.0.0.1:3000 APP_DATABASE_URL=postgres://flyleaf_app:...@.../flyleaf \
//   ADMIN_DATABASE_URL=postgres://flyleaf:...@.../flyleaf node deploy/test/app-role-path.mjs
//
// ADMIN_DATABASE_URL is the superuser, used for one fixture step only: marking
// the two test accounts' email verified (reviews and follows require it, and
// the link would otherwise go to the console mailer's log).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_DIR = path.join(ROOT, 'apps/api');
const { default: postgres } = await import(path.join(API_DIR, 'node_modules/postgres/src/index.js'));
const { PgBoss } = await import(path.join(API_DIR, 'node_modules/pg-boss/dist/index.js'));
const { QUEUES } = await import(path.join(API_DIR, 'dist/jobs/index.js'));

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const APP_DB = process.env.APP_DATABASE_URL;
const ADMIN_DB = process.env.ADMIN_DATABASE_URL;
if (!APP_DB || !ADMIN_DB) throw new Error('APP_DATABASE_URL and ADMIN_DATABASE_URL are required');

let passed = 0;
const fail = (msg) => { console.error(`  FAIL ${msg}`); process.exit(1); };
const ok = (msg) => { passed++; console.log(`  ok ${msg}`); };

async function req(method, p, { body, token, raw, headers } = {}) {
  const res = await fetch(raw ? p : API + p, {
    method,
    headers: {
      ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
function expect(r, statuses, what) {
  if (!statuses.includes(r.status)) fail(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  ok(`${what} (${r.status})`);
  return r.json;
}
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---- guest ------------------------------------------------------------------
expect(await req('GET', '/healthz'), [200], 'healthz');
expect(await req('GET', '/readyz'), [200], 'readyz (as flyleaf_app)');
const search = expect(await req('GET', '/v1/search?q=piranesi'), [200], 'search');
const work = search?.data?.[0];
if (!work) fail('search returned nothing: was the seed loaded?');
expect(await req('GET', `/v1/works/${work.id}`), [200], 'work page');

// ---- accounts -----------------------------------------------------------------
const pw = 'correct horse battery staple 42';
const mk = async (name) => {
  const email = `${name}.${randomUUID().slice(0, 8)}@example.com`;
  const username = `${name}${randomUUID().slice(0, 6).replace(/-/g, '')}`;
  const r = expect(await req('POST', '/v1/auth/register', { body: { email, username, password: pw, dateOfBirth: '1990-01-01' } }),
    [201], `register ${name}`);
  return { token: r.accessToken, id: r.user.id, username, email };
};
const a = await mk('rolea');
const b = await mk('roleb');
const login = expect(await req('POST', '/v1/auth/login', { body: { email: a.email, password: pw } }), [200], 'login');
a.token = login.accessToken ?? a.token;
expect(await req('GET', '/v1/me', { token: a.token }), [200], 'me');

const admin = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
await admin`UPDATE users SET email_verified_at = now() WHERE id IN (${a.id}, ${b.id})`;
await admin.end();

// ---- reading ------------------------------------------------------------------
const read = expect(await req('POST', '/v1/reads', { token: a.token, body: { work_id: work.id, status: 'reading' } }), [200, 201], 'start reading');
expect(await req('POST', `/v1/reads/${read.id}/progress`, { token: a.token, body: { client_event_id: randomUUID(), page: 120 } }), [200], 'progress');
const fin = expect(await req('POST', '/v1/reads', { token: a.token, body: { work_id: work.id, status: 'finished', rating: 4.5, hearted: true } }), [200], 'finish with a rating');
expect(await req('POST', `/v1/reads/${fin.id}/review`, { token: a.token, body: { body: 'A labyrinth of a book. Read under the app role.' } }), [200, 201], 'review');
expect(await req('POST', `/v1/users/${a.id}/follow`, { token: b.token }), [200, 201], 'follow');
expect(await req('POST', `/v1/reads/${fin.id}/like`, { token: b.token }), [200, 201, 204], 'like');
expect(await req('POST', `/v1/reads/${fin.id}/comments`, { token: b.token, body: { body: 'Agreed.' } }), [200, 201], 'comment');
expect(await req('GET', '/v1/feed', { token: b.token }), [200], 'feed');
expect(await req('GET', '/v1/me/stats', { token: a.token }), [200], 'stats');
const { shelf } = expect(await req('POST', '/v1/shelves', { token: a.token, body: { name: 'Role test' } }), [200, 201], 'create shelf');
expect(await req('POST', `/v1/shelves/${shelf.id}/items`, { token: a.token, body: { work_id: work.id } }), [200, 201], 'shelve a book');

// ---- import: presigned upload, then the worker ------------------------------
const csv = 'Title,Author,ISBN13,My Rating,Exclusive Shelf,Date Read\n"Piranesi","Susanna Clarke","","4","read","2024/01/02"\n';
const bytes = Buffer.from(csv);
const up = expect(await req('POST', '/v1/uploads', { token: a.token, body: { purpose: 'import', content_type: 'text/csv', size: bytes.length, filename: 'role.csv' } }), [201], 'upload intent');
const put = await req(up.target.method, up.target.url, { raw: true, body: bytes, headers: up.target.headers });
if (put.status !== 200) fail(`PUT to the signed target: ${put.status} ${put.text.slice(0, 200)}`);
ok('PUT to the signed target');
expect(await req('POST', `/v1/uploads/${up.id}/complete`, { token: a.token }), [200], 'upload complete');
const imp = expect(await req('POST', '/v1/imports', { token: a.token, body: { upload_id: up.id, source: 'goodreads' } }), [201], 'import queued');
const impDone = await until('the worker to finish the import', async () => {
  const r = await req('GET', `/v1/imports/${imp.id}`, { token: a.token });
  return ['completed', 'failed'].includes(r.json?.state) ? r.json : null;
});
if (impDone.state !== 'completed') fail(`import ended ${impDone.state}: ${JSON.stringify(impDone).slice(0, 300)}`);
ok(`import processed by the worker (${impDone.state})`);

// ---- export --------------------------------------------------------------------
const exp = expect(await req('POST', '/v1/exports', { token: a.token, body: { format: 'csv' } }), [200, 201, 202], 'export queued');
const expDone = await until('the worker to finish the export', async () => {
  const r = await req('GET', `/v1/exports/${exp.id}`, { token: a.token });
  return ['completed', 'failed'].includes(r.json?.state) ? r.json : null;
});
if (expDone.state !== 'completed') fail(`export ended ${expDone.state}`);
ok('export processed by the worker');

// ---- every scheduled job, through the real worker ---------------------------
// The cron would run them overnight; sending one now runs the same handler
// in the worker, on its flyleaf_app pool.
const boss = new PgBoss({ connectionString: APP_DB, schema: 'pgboss', supervise: false, schedule: false });
boss.on('error', () => {});
await boss.start();
const scheduled = [
  QUEUES.reconcileShelves, QUEUES.reconcileFollows, QUEUES.reconcileReads, QUEUES.reconcileWorks,
  QUEUES.storageCleanup, QUEUES.pruneActivity, QUEUES.repairAuthors, QUEUES.retentionSweep,
  QUEUES.summariseZeroResults, QUEUES.refreshSearchSuggestions, QUEUES.notifyReminders,
  QUEUES.notifyReceipts, QUEUES.catalogDedupe, QUEUES.smokePing,
];
for (const queue of scheduled) {
  const id = await boss.send(queue, {});
  const job = await until(`job ${queue}`, async () => {
    const j = await boss.getJobById(queue, id);
    return j && ['completed', 'failed', 'cancelled'].includes(j.state) ? j : null;
  }, 300_000);
  if (job.state !== 'completed') fail(`job ${queue} ${job.state}: ${JSON.stringify(job.output).slice(0, 400)}`);
  ok(`job ${queue}`);
}
await boss.stop({ graceful: false });

console.log(`\n${passed} app-role path checks passed`);
