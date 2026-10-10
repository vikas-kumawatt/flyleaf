// Import and export cost (audit 12). Dev-only.
//
//   npx tsx src/bench/import-cost.ts --rows 5000 [--export] [--keep]
//
// Builds a Goodreads-format file from works sampled out of the catalog the
// API points at (DATABASE_URL): half with their ISBN, a third by exact title
// and author, a tenth with a misspelt title, the rest not in the catalog.
// Imports it for a throwaway user through the real processor (memory
// storage), and with --export builds that user's export the way the worker
// does. Prints rows, time, SQL statements and statements per row, then
// deletes the user (cascade) unless --keep.
//
// Statements are counted with postgres.js's `debug` hook, which fires once
// per statement sent, BEGIN/COMMIT included. Run it alone: the numbers are
// for one import at a time.

import crypto from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { config, TRIGRAM_THRESHOLD, type Db } from '../platform/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { processImport } from '../imports/processor.js';
import { formatAsCsv, generateExportData } from '../exports/generator.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ROWS = value('rows', 5000);

let statements = 0;
const client = postgres(config.databaseUrl, {
  max: 4,
  onnotice: () => {},
  connection: { 'pg_trgm.similarity_threshold': String(TRIGRAM_THRESHOLD) },
  debug: () => {
    statements++;
  },
});
const db = drizzle(client, { schema }) as unknown as Db;

function measure<T>(fn: () => Promise<T>): Promise<{ ms: number; statements: number; result: T }> {
  const before = statements;
  const t0 = performance.now();
  return fn().then((result) => ({ ms: Math.round(performance.now() - t0), statements: statements - before, result }));
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const misspell = (s: string) => (s.length > 4 ? s.slice(0, -2) + s.slice(-1) + s.slice(-2, -1) : s + 'x');

async function main() {
  const sample = await db.execute<{ title: string; author: string | null; isbn13: string | null }>(sql`
    SELECT w.title,
      (SELECT a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id ORDER BY wa.position LIMIT 1) AS author,
      (SELECT e.isbn_13 FROM editions e WHERE e.work_id = w.id AND e.isbn_13 IS NOT NULL LIMIT 1) AS isbn13
    FROM works w TABLESAMPLE SYSTEM (5)
    WHERE w.merged_into_id IS NULL AND w.is_provisional = false
    LIMIT ${ROWS}`);
  if (sample.length < ROWS) throw new Error(`only ${sample.length} works sampled; use a bigger catalog or fewer --rows`);

  const lines = ['Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Read,Bookshelves,My Review'];
  sample.forEach((w, i) => {
    const kind = i % 10; // 0-4 isbn, 5-7 exact, 8 misspelt, 9 not in the catalog
    const title = kind === 8 ? misspell(w.title) : kind === 9 ? `Zq ${crypto.randomUUID()}` : w.title;
    const isbn = kind < 5 && w.isbn13 ? `="${w.isbn13}"` : '=""';
    lines.push([i + 1, q(title), q(w.author ?? ''), '=""', isbn, i % 6, 'read', '2024/01/02', q(i % 4 === 0 ? 'bench-tag' : ''), q(i % 7 === 0 ? 'Bench review.' : '')].join(','));
  });
  const csv = Buffer.from(lines.join('\n') + '\n');

  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `bench_import_${Date.now()}@bench.test`,
    passwordHash: 'unused',
    dateOfBirth: '1990-01-01',
    emailVerifiedAt: new Date(),
  });
  await db.insert(schema.profiles).values({ userId, username: `bench_import_${Date.now().toString(36)}` });

  try {
    const storage = new MemoryObjectStorage();
    const key = `uploads/${userId}/${crypto.randomUUID()}`;
    await storage.put(key, csv, 'text/csv');
    const [imp] = await db
      .insert(schema.imports)
      .values({
        userId,
        source: 'goodreads',
        state: 'queued',
        fileKey: key,
        fileSizeBytes: csv.length,
        contentHash: crypto.createHash('sha256').update(csv).digest('hex'),
      })
      .returning();

    const run = await measure(() => processImport(db, storage, imp!.id));
    const out: Record<string, unknown> = {
      database: config.databaseUrl.replace(/\/\/[^@]*@/, '//'),
      rows: ROWS,
      fileBytes: csv.length,
      matched: run.result.matched,
      unmatched: run.result.unmatched,
      importMs: run.ms,
      importStatements: run.statements,
      statementsPerRow: Number((run.statements / ROWS).toFixed(2)),
    };

    if (flag('export')) {
      const heap0 = process.memoryUsage().heapUsed;
      const exp = await measure(async () => formatAsCsv(await generateExportData(db, userId)));
      Object.assign(out, {
        exportReads: run.result.matched,
        exportMs: exp.ms,
        exportStatements: exp.statements,
        exportBytes: Buffer.byteLength(exp.result),
        exportHeapDeltaMb: Number(((process.memoryUsage().heapUsed - heap0) / 1048576).toFixed(1)),
      });
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    if (!flag('keep')) await db.delete(schema.users).where(sql`id = ${userId}::uuid`);
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
