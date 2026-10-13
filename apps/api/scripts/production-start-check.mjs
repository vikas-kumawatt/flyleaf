// Do the COMPILED API and worker start as production starts them? (deploy kit)
//
//   npm run build && npm run start:check        DATABASE_URL must reach a migrated database
//
// `npm run dev` and `npm run worker` run TypeScript through tsx. Production
// runs `node dist/server.js` and `node dist/worker.js` (deploy/systemd), so a
// mistake that only the compiled output has -- a path that resolves from src/
// but not dist/, a dev-only import -- would otherwise first show up on the
// server. This starts both exactly as the systemd units do, with
// NODE_ENV=production and a complete set of production variables, and checks:
//
//   1. the API answers /healthz and /readyz, then exits 0 on SIGTERM;
//   2. the worker logs "worker ready", then exits 0 on SIGTERM;
//   3. each refuses to start on a development adapter, naming the variable
//      (architecture §4.2 rule 2), and the API refuses a missing JWT_SECRET.
//
// The provider credentials are syntactically valid and point at nothing
// (127.0.0.1:9, the discard port): no adapter connects at start-up, which is
// itself part of what this proves. Nothing here sends mail or touches S3.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://flyleaf:flyleaf@localhost:5432/flyleaf';

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** What deploy/env.production.example sets, with harmless values. */
const productionEnv = (port) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'production',
  DATABASE_URL,
  PORT: String(port),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  JWT_SECRET: randomBytes(48).toString('base64'),
  TRUST_PROXY: '127.0.0.1',
  APP_BASE_URL: 'https://flyleaf.example.test',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'flyleaf',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'check',
  S3_SECRET_ACCESS_KEY: 'check-secret',
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_FORCE_PATH_STYLE: 'true',
  EMAIL_DRIVER: 'smtp',
  SMTP_URL: 'smtps://check%40example.test:app-password@127.0.0.1:9',
  EMAIL_FROM: 'Flyleaf <check@example.test>',
  PUSH_DRIVER: 'expo',
});

/** Starts `node <script>` and collects its output. */
function start(script, env) {
  const child = spawn(process.execPath, [script], { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, out, exited };
}

const within = (ms, promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms).unref()),
  ]);

async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${ms} ms: ${what}`);
}

const get = async (url) => {
  try {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: '' };
  }
};

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    checks.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${err.message.replace(/\n/g, '\n    ')}`);
  }
};

const tail = (text) => text.trim().split('\n').slice(-8).join('\n');

await check('API: dist/server.js serves /healthz and /readyz, exits 0 on SIGTERM', async () => {
  const port = await freePort();
  const api = start('dist/server.js', productionEnv(port));
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await get(`${base}/healthz`)).status === 200, 30_000,
      `/healthz never answered 200. Output:\n${tail(api.out.text)}`);
    const ready = await get(`${base}/readyz`);
    if (ready.status !== 200) throw new Error(`/readyz answered ${ready.status}: ${ready.body}`);
    // Production logs are JSON, one object per line (pino), never pino-pretty.
    const firstLine = api.out.text.trim().split('\n')[0] ?? '';
    JSON.parse(firstLine);
  } finally {
    api.child.kill('SIGTERM');
  }
  const { code } = await within(15_000, api.exited, 'API shutdown');
  if (code !== 0) throw new Error(`exit code ${code} after SIGTERM. Output:\n${tail(api.out.text)}`);
  if (!api.out.text.includes('shutdown complete')) throw new Error('no "shutdown complete" in the log');
});

await check('worker: dist/worker.js reaches "worker ready", exits 0 on SIGTERM', async () => {
  const worker = start('dist/worker.js', productionEnv(await freePort()));
  try {
    await waitFor(async () => worker.out.text.includes('worker ready'), 60_000,
      `no "worker ready". Output:\n${tail(worker.out.text)}`);
  } finally {
    worker.child.kill('SIGTERM');
  }
  const { code } = await within(40_000, worker.exited, 'worker shutdown');
  if (code !== 0) throw new Error(`exit code ${code} after SIGTERM. Output:\n${tail(worker.out.text)}`);
});

const refuses = (script, override, variable) => async () => {
  const env = { ...productionEnv(await freePort()), ...override };
  for (const [k, v] of Object.entries(override)) if (v === undefined) delete env[k];
  const proc = start(script, env);
  const { code } = await within(20_000, proc.exited, `${script} should have refused to start`).catch((err) => {
    proc.child.kill('SIGKILL');
    throw err;
  });
  if (code === 0) throw new Error(`${script} exited 0`);
  if (!proc.out.text.includes(variable)) throw new Error(`the refusal does not name ${variable}:\n${tail(proc.out.text)}`);
};

await check('API refuses STORAGE_DRIVER=disk', refuses('dist/server.js', { STORAGE_DRIVER: 'disk' }, 'STORAGE_DRIVER'));
await check('API refuses a missing JWT_SECRET', refuses('dist/server.js', { JWT_SECRET: undefined }, 'JWT_SECRET'));
await check('worker refuses EMAIL_DRIVER=console', refuses('dist/worker.js', { EMAIL_DRIVER: 'console' }, 'EMAIL_DRIVER'));

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} failed` : `\nall ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
