// Route inventory (audit Part 01). `npm run bench:routes`.
//
// Generated from the REAL application, not by hand: buildApp() is called
// exactly as server.ts calls it, and every route it registers is captured
// through an onRoute hook. The hook has to exist before the first route is
// registered, and buildApp() creates its Fastify instance internally, so it
// is attached through Fastify's `fastify.initialization` diagnostics channel,
// which fires inside the Fastify() factory before any plugin runs.
//
// The app runs on PGlite (a fresh in-memory database), never the dev
// database: the guest/auth probes below send real requests, and some routes
// write.
//
// Writes docs/audit/route-inventory.md.

import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, RouteOptions } from 'fastify';
import YAML from 'yaml';
import { sql } from 'drizzle-orm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const API_SRC = path.join(ROOT, 'apps/api/src');
const OUT = path.join(ROOT, 'docs/audit/route-inventory.md');

interface CapturedRoute {
  method: string;
  url: string;
  file: string;
  hasRequestSchema: boolean;
  requestParts: string[];
  hasResponseSchema: boolean;
  hidden: boolean;
  handlerSource: string;
  handler: unknown;
  instance: number;
}

const captured: CapturedRoute[] = [];
let instanceCount = 0;

diagnostics.channel('fastify.initialization').subscribe((msg) => {
  const { fastify } = msg as { fastify: FastifyInstance };
  const instance = ++instanceCount;
  fastify.addHook('onRoute', (opts: RouteOptions) => {
    // The first stack frame inside src/ that is not this file is where the
    // route was declared.
    const frame = (new Error().stack ?? '')
      .split('\n')
      .map((l) => l.replace(/\\/g, '/'))
      .find((l) => l.includes('/apps/api/src/') && !l.includes('/src/bench/routes.ts'));
    const file = frame?.match(/apps\/api\/(src\/[^:)]+)/)?.[1] ?? '?';
    const schema = (opts.schema ?? {}) as Record<string, unknown>;
    const requestParts = ['body', 'querystring', 'params', 'headers'].filter((k) => schema[k]);
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const method of methods) {
      if (method === 'HEAD') continue; // Fastify's automatic HEAD twin of every GET
      captured.push({
        method,
        url: opts.url,
        file,
        hasRequestSchema: requestParts.length > 0,
        requestParts,
        hasResponseSchema: Boolean(schema.response),
        hidden: Boolean(schema.hide),
        handlerSource: [opts.handler, opts.preHandler, opts.onRequest, opts.preValidation]
          .flat()
          .filter(Boolean)
          .map((f) => String(f))
          .join('\n'),
        handler: opts.handler,
        instance,
      });
    }
  });
});

// Imported after the subscription so nothing can create an instance first.
const { buildApp } = await import('../app.js');
const { freshDrizzle } = await import('../test/pg.js');
const { IdentityService, signAccessToken } = await import('../identity/index.js');
const { CatalogService } = await import('../catalog/index.js');
const { ReadingService } = await import('../reading/index.js');
const { MemoryCache, MemoryEmailSender, PgRateLimiter } = await import('../platform/index.js');

const { db } = await freshDrizzle();
const limiter = new PgRateLimiter(db);
// Same services server.ts wires, minus GapFillService: a probe that misses
// search must not go to the network. Gap-fill adds no routes.
const app = await buildApp({
  db,
  identity: new IdentityService(db, limiter, new MemoryEmailSender()),
  catalog: new CatalogService(db, new MemoryCache()),
  reading: new ReadingService(db),
  limiter,
});
await app.ready();

// ------------------------------------------------------------------ probes

const [user] = await db.execute<{ id: string }>(sql`
  INSERT INTO users (email, password_hash, date_of_birth)
  VALUES ('inventory@example.invalid', 'x', '1990-01-01') RETURNING id
`);
await db.execute(sql`INSERT INTO profiles (user_id, username) VALUES (${user!.id}, 'inventory_probe')`);
const userToken = await signAccessToken(user!.id);

const fillParams = (url: string) =>
  url.replace(/:([A-Za-z_]+)/g, (_m, name: string) =>
    /id$/i.test(name) ? randomUUID() : name === 'isbn' ? '9780000000002' : 'x',
  );

async function probe(r: CapturedRoute, token: string | null): Promise<number> {
  if (r.url.includes('*')) return -1;
  const res = await app.inject({
    method: r.method as 'GET',
    url: fillParams(r.url),
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(['POST', 'PUT', 'PATCH'].includes(r.method) ? { payload: {} } : {}),
  });
  return res.statusCode;
}

// ------------------------------------------------------------ cross-refs

const openapi = YAML.parse(fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};
const specKeys = new Set<string>();
for (const [p, ops] of Object.entries(openapi.paths ?? {})) {
  for (const m of Object.keys(ops)) specKeys.add(`${m.toUpperCase()} ${p.replace(/\{[^}]+\}/g, ':p')}`);
}
// Swagger strips the `/v1` server base from paths; unprefixed routes keep theirs.
const specKey = (method: string, url: string) =>
  `${method} ${url.replace(/^\/v1(?=\/)/, '').replace(/:[A-Za-z_]+/g, ':p')}`;

// api-client: every `this.request(PATH, { method })` call, where PATH is a
// string/template literal or a variable assigned one shortly before.
const clientSrc = fs.readFileSync(path.join(ROOT, 'packages/api-client/src/client.ts'), 'utf8');
const clientKeys = new Set<string>();
{
  const re = /this\.request(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\s*(?:([`'])([^`']+)\1|([A-Za-z_]\w*)\s*,)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clientSrc))) {
    let literal = m[2];
    if (m[3]) {
      // `const endpoint = \`/users/${id}/followers${qs ? \`?${qs}\` : ''}\``
      const before = clientSrc.slice(Math.max(0, m.index - 600), m.index);
      const assigned = [...before.matchAll(new RegExp(`(?:const|let)\\s+${m[3]}\\s*=\\s*([\`'])(.*)$`, 'gm'))].at(-1);
      if (!assigned) continue;
      literal = assigned[2]!;
    }
    // Drop the query string, however it is spelled: a literal `?`, a
    // `${query}` suffix, or a conditional `${qs ? ... : ''}`.
    const rawPath = literal!
      .split('?')[0]!
      .replace(/\$\{(?:query|q|qs|queryString)\}/g, '')
      .replace(/\$\{[^}]*$/, '');
    const norm = rawPath.replace(/\$\{[^}]+\}/g, ':p').replace(/\/$/, '') || '/';
    const tail = clientSrc.slice(m.index, m.index + 400);
    const end = tail.indexOf('});');
    const method = tail.slice(0, end === -1 ? 400 : end).match(/method:\s*'([A-Z]+)'/)?.[1] ?? 'GET';
    clientKeys.add(`${method} ${norm}`);
  }
}
const clientKey = (method: string, url: string) =>
  `${method} ${url.replace(/^\/v1(?=\/)/, '').replace(/:[A-Za-z_]+/g, ':p')}`;

// Tests: which test files mention the path (params matched loosely).
const testDirs = [path.join(API_SRC, 'test'), path.join(ROOT, 'apps/mobile/src')];
const testFiles: { name: string; text: string }[] = [];
const walk = (dir: string) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.test\.tsx?$/.test(e.name)) {
      testFiles.push({ name: path.relative(ROOT, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
    }
  }
};
testDirs.forEach(walk);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function testsFor(url: string): string[] {
  const body = url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/\'"`?\\s]+' : escapeRe(seg)))
    .join('/');
  // A route with no params also matches its own prefix in longer paths, so
  // require a terminator after it.
  const re = new RegExp(`['"\`]${body}(?:[?'"\`]|$)`, 'm');
  return testFiles.filter((f) => re.test(f.text)).map((f) => path.basename(f.name));
}

// PRD §24.4 groups. Heuristic by path and method, stated as such in the output.
function rateGroup(method: string, url: string): string {
  const u = url.replace(/^\/v1/, '');
  if (u.startsWith('/admin')) return 'Global';
  if (u.startsWith('/auth/')) return 'Auth';
  if (u.startsWith('/search')) return 'Search';
  if (/\/progress$/.test(u) && method === 'POST') return 'Progress events';
  if (/\/comments/.test(u) && method !== 'GET') return 'Comments';
  if (/^\/users\/:[^/]+\/follow$/.test(u) || /\/follow/.test(u) && method !== 'GET') return 'Follows';
  if (u.startsWith('/imports') && method === 'POST') return 'Import';
  if (u.startsWith('/exports') && method === 'POST') return 'Export';
  if (method !== 'GET' && /^\/(reads|reviews|shelves|me\/shelves)/.test(u)) return 'Writes';
  return 'Global';
}
// Enforced limits found by reading the code (grep `limiter.allow`), keyed to
// the route that reaches them. Verified in identity/index.ts and
// interactions/index.ts; nothing else in src/ calls a limiter.
const ENFORCED: Record<string, string> = {
  'POST /v1/auth/login': 'yes: 10/min per email (no per-IP limit)',
  'POST /v1/auth/resend-verification': 'yes: 1/min per user (not a §24.4 number)',
  'POST /v1/auth/forgot-password': 'yes: 5/15 min per email (not a §24.4 number)',
  'POST /v1/reads/:id/comments': 'yes: 5/min per user',
};

function authMode(r: CapturedRoute, guest: number, signed: number): string {
  const src = r.handlerSource;
  if (/requireAdmin\(/.test(src)) return 'admin';
  if (/requireModerator\(/.test(src)) return 'moderator';
  if (/requireViewer\(/.test(src)) return 'signed in';
  if (guest === 302 && signed === 302) return 'admin (web: redirects to login)';
  if (guest === 401 && signed !== 401) return 'signed in (probe)';
  if (guest === 401 && signed === 401) return 'admin? (probe: 401 for user too)';
  return 'guest OK';
}

// ------------------------------------------------------------------ build

type Row = CapturedRoute & {
  guest: number; signed: number; auth: string; inSpec: boolean; inClient: boolean;
  tests: string[]; group: string; enforced: string; flags: string[];
};
const rows: Row[] = [];
for (const r of captured) {
  const guest = await probe(r, null);
  const signed = await probe(r, userToken);
  const key = `${r.method} ${r.url}`;
  rows.push({
    ...r,
    guest,
    signed,
    auth: authMode(r, guest, signed),
    inSpec: specKeys.has(specKey(r.method, r.url)),
    inClient: clientKeys.has(clientKey(r.method, r.url)),
    tests: testsFor(r.url),
    group: rateGroup(r.method, r.url),
    enforced: ENFORCED[key] ?? 'no',
    flags: [],
  });
}
await app.close();

// Duplicates / aliases: the same handler FUNCTION (by identity, not by
// source text -- two one-line arrows can print identically and do different
// things) mounted at two URLs, or two URLs that collapse to the same spec key.
const byHandler = new Map<unknown, Row[]>();
for (const r of rows) {
  byHandler.set(r.handler, [...(byHandler.get(r.handler) ?? []), r]);
}
for (const group of byHandler.values()) {
  if (group.length > 1) {
    for (const r of group) {
      r.flags.push(`same handler as ${group.filter((g) => g !== r).map((g) => `\`${g.method} ${g.url}\``).join(', ')}`);
    }
  }
}
const bySpecKey = new Map<string, Row[]>();
for (const r of rows) {
  const k = specKey(r.method, r.url);
  bySpecKey.set(k, [...(bySpecKey.get(k) ?? []), r]);
}
for (const group of bySpecKey.values()) {
  if (group.length > 1) {
    for (const r of group) {
      const others = group.filter((g) => g !== r).map((g) => `\`${g.method} ${g.url}\``).join(', ');
      r.flags.push(`same path with and without the /v1 prefix as ${others} (one spec entry for both)`);
    }
  }
}
for (const r of rows) {
  if (!r.inSpec && !r.hidden) r.flags.push('missing from openapi.yaml');
  if (r.tests.length === 0) r.flags.push('no test mentions this path');
  if (r.url.startsWith('/v1') && !r.inClient) r.flags.push('no api-client method');
  if (!r.hasResponseSchema) r.flags.push('no response schema');
  if (r.guest >= 500 || r.signed >= 500) r.flags.push(`probe returned ${Math.max(r.guest, r.signed)}`);
}

rows.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));

const yes = (b: boolean) => (b ? 'yes' : '**no**');
const lines: string[] = [];
lines.push('# Route inventory');
lines.push('');
lines.push(`Generated by \`npm run bench:routes\` (apps/api/src/bench/routes.ts) on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand; re-run it.`);
lines.push('');
lines.push('## How each column is derived');
lines.push('');
lines.push('- **Routes**: every route `buildApp()` registers, as wired in `server.ts` (identity, catalog, reading, db, limiter), captured by an `onRoute` hook. Automatic HEAD twins are omitted. `server.ts` passes no `boss`, `storage` or `mailer`, and neither does this script, so the routes are the ones production serves.');
lines.push('- **File**: first stack frame under `apps/api/src/` when the route was registered.');
lines.push('- **Auth**: `requireAdmin` / `requireModerator` / `requireViewer` found in the handler source (or its route-level hooks). If none is found, the route was probed: the guest status (no token) and the signed-in status (valid token for a fresh user) come from `app.inject` against a fresh PGlite database with random UUID params and `{}` bodies. `guest OK` means no auth call in the handler and the guest probe was not 401. A 422 guest probe can hide an auth check that runs after validation; the source check covers those.');
lines.push('- **Req / Resp schema**: `schema.body|querystring|params|headers` / `schema.response` present on the route.');
lines.push('- **Spec**: the method + path (with `/v1` stripped, which is how the swagger servers base renders it) is a key in `openapi.yaml`.');
lines.push('- **Client**: a `this.request(...)` call in `packages/api-client/src/client.ts` with that method and path.');
lines.push('- **Tests**: `*.test.ts(x)` files under `apps/api/src/test` and `apps/mobile/src` containing the path as a string literal (params matched loosely). A mention is not proof the behaviour is asserted.');
lines.push('- **RL group**: PRD §24.4 group, assigned by path/method heuristic. **Enforced**: from grepping `limiter.allow` in `src/`; only four call sites exist.');
lines.push('');

const total = rows.length;
const missingSpec = rows.filter((r) => !r.inSpec);
const noTests = rows.filter((r) => r.tests.length === 0);
const noResp = rows.filter((r) => !r.hasResponseSchema);
const noClient = rows.filter((r) => !r.inClient && r.url.startsWith('/v1'));
const aliases = rows.filter((r) => r.flags.some((f) => f.startsWith('same handler')));
const server5xx = rows.filter((r) => r.flags.some((f) => f.startsWith('probe returned')));
lines.push('## Summary');
lines.push('');
lines.push(`| | Count |`);
lines.push(`|---|---|`);
lines.push(`| Routes (excluding HEAD) | ${total} |`);
lines.push(`| Missing from openapi.yaml | ${missingSpec.length} |`);
lines.push(`| No response schema | ${noResp.length} |`);
lines.push(`| No test file mentions the path | ${noTests.length} |`);
lines.push(`| \`/v1\` routes with no api-client method | ${noClient.length} |`);
lines.push(`| Routes sharing a handler with another URL (aliases) | ${aliases.length} |`);
lines.push(`| Routes whose probe returned 5xx | ${server5xx.length} |`);
lines.push(`| Routes with an enforced rate limit | ${rows.filter((r) => r.enforced !== 'no').length} |`);
lines.push('');

lines.push('## Flags');
lines.push('');
for (const r of rows.filter((x) => x.flags.length)) {
  lines.push(`- \`${r.method} ${r.url}\` (${r.file}): ${r.flags.join('; ')}`);
}
lines.push('');

lines.push('## All routes');
lines.push('');
lines.push('| Method | Path | File | Auth | Guest / user probe | Req schema | Resp schema | Spec | Client | Tests | RL group | Enforced |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${r.method} | \`${r.url}\` | ${r.file.replace(/^src\//, '')} | ${r.auth} | ${r.guest} / ${r.signed} | ` +
      `${r.hasRequestSchema ? r.requestParts.join(', ') : '—'} | ${yes(r.hasResponseSchema)} | ${yes(r.inSpec)} | ` +
      `${r.url.startsWith('/v1') ? yes(r.inClient) : 'n/a'} | ${r.tests.length ? r.tests.join(', ') : '**none**'} | ${r.group} | ${r.enforced} |`,
  );
}
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`route inventory: ${total} routes -> ${path.relative(ROOT, OUT)}`);
process.exit(0);
