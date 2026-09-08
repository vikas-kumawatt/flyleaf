#!/usr/bin/env node
// FN-05. One definition of "is this repo green?".
//
// WHY A SCRIPT AND NOT JUST A WORKFLOW FILE. .github/workflows/ci.yml calls
// this rather than restating the steps in YAML, so the two cannot drift --
// drift is the usual way a green CI badge stops meaning anything, and the
// copy that rots is always the one nobody runs by hand. It also means the
// full check is available before pushing, which is the point: a failure you
// find in thirty seconds locally is cheaper than one you find in Actions.
//
// Node, not bash or PowerShell, because this has to run identically on the
// Windows machine it is developed on and on the Linux runner. The repo
// already has three .ps1 scripts that Actions could never execute.
//
// Assumes dependencies are installed. CI installs them itself (with caching);
// locally you already have them.
//
//   node scripts/ci.mjs            skip the migration check if no database
//   node scripts/ci.mjs --strict   fail instead of skipping (what CI uses)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://flyleaf:flyleaf@localhost:5432/flyleaf';

/**
 * The checks, in the order that fails fastest.
 *
 * typecheck before tests because it takes two seconds and catches the whole
 * class of mistake that would make the test run meaningless anyway.
 *
 * `audit --audit-level=high` rather than `moderate`: as of today the tree
 * carries 4 moderate advisories, all one esbuild dev-server issue reached
 * through drizzle-kit's loader. drizzle-kit is a devDependency, `dist/` is
 * built by tsc and never includes it, and the advisory needs you to be
 * running an esbuild dev server. Gating on `moderate` would mean a red build
 * every day for something that cannot affect us, and a check that is always
 * red is a check nobody reads.
 */
const STEPS = [
  { name: 'api · typecheck', cwd: 'apps/api', args: ['run', 'typecheck'] },
  { name: 'api · tests', cwd: 'apps/api', args: ['test'] },
  { name: 'api · build', cwd: 'apps/api', args: ['run', 'build'] },
  { name: 'api · audit', cwd: 'apps/api', args: ['audit', '--audit-level=high'] },
  { name: 'mobile · typecheck', cwd: 'apps/mobile', args: ['run', 'typecheck'] },
  {
    name: 'api · migrations on a real Postgres',
    cwd: 'apps/api',
    args: ['run', 'migrate'],
    // The test suite already applies every migration to an empty PGlite
    // database and asserts it is idempotent. This one runs them against the
    // actual server, which is where the differences that matter show up --
    // the generated column and the two GIN indexes both needed hand-editing
    // that no snapshot check would have caught.
    needsDatabase: true,
  },
];

const run = (step) =>
  new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', step.args, {
      cwd: path.join(ROOT, step.cwd),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, DATABASE_URL, FORCE_COLOR: '1' },
    });
    child.on('error', (err) => resolve({ code: 1, err }));
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });

/** Is anything listening? Two seconds, then assume not. */
function databaseReachable() {
  let host = 'localhost';
  let port = 5432;
  try {
    const u = new URL(DATABASE_URL);
    host = u.hostname || host;
    port = Number(u.port || 5432);
  } catch { /* fall through to the defaults */ }

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2_000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

const results = [];
const started = Date.now();

for (const step of STEPS) {
  if (step.needsDatabase && !(await databaseReachable())) {
    if (STRICT) {
      console.error(
        `\n✗ ${step.name}\n` +
        `  No database at ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}, and --strict ` +
        `forbids skipping it.\n`);
      results.push({ name: step.name, status: 'fail' });
      break;
    }
    console.log(`\n— ${step.name} — skipped, no database. \`make up\` to include it.`);
    results.push({ name: step.name, status: 'skip' });
    continue;
  }

  console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m`);
  const { code, err } = await run(step);
  if (err) console.error(`  could not start npm: ${err.message}`);
  results.push({ name: step.name, status: code === 0 ? 'pass' : 'fail' });
  if (code !== 0) break;   // stop at the first failure; the rest is noise
}

const mark = { pass: '\x1b[32m✓\x1b[0m', fail: '\x1b[31m✗\x1b[0m', skip: '\x1b[33m—\x1b[0m' };
const ran = new Set(results.map((r) => r.name));

console.log(`\n${'─'.repeat(52)}`);
for (const r of results) console.log(`  ${mark[r.status]} ${r.name}`);
for (const s of STEPS) if (!ran.has(s.name)) console.log(`    ${s.name} (not reached)`);
console.log(`${'─'.repeat(52)}`);

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');
const secs = Math.round((Date.now() - started) / 1000);

console.log(
  failed.length
    ? `\nFAILED after ${secs}s — ${failed.map((f) => f.name).join(', ')}\n`
    : `\ngreen in ${secs}s${skipped.length ? ` (${skipped.length} skipped)` : ''}\n`);

process.exit(failed.length ? 1 : 0);
