// Audit 08 (SL-56): N concurrent "start again" requests for a finished book,
// through the real ReadingService on a real Postgres (PGlite serialises
// transactions, so it cannot show this race). Creates its own user and work.
//
//   Run it against a THROWAWAY database only; it commits:
//   DATABASE_URL=…/flyleaf_race npx tsx src/bench/attempt-race.ts [--n 8]
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, closeDb } from '../platform/index.js';
import { ReadingService } from '../reading/index.js';

async function main() {
  const i = process.argv.indexOf('--n');
  const n = i === -1 ? 8 : Number(process.argv[i + 1]);
  const db = makeDb(undefined, { max: n + 2, quiet: true });
  try {
    const user = randomUUID();
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, date_of_birth)
      VALUES (${user}, ${`race-${user}@example.invalid`}, 'unused', '1990-01-01')`);
    await db.execute(sql`INSERT INTO profiles (user_id, username, display_name) VALUES (${user}, ${`race_${user.slice(0, 8)}`}, 'race')`);
    const [w] = await db.execute<{ id: string }>(sql`INSERT INTO works (title) VALUES ('Race') RETURNING id`);
    const service = new ReadingService(db);
    await service.upsert(user, w!.id, 'finished');

    const results = await Promise.allSettled(
      Array.from({ length: n }, () => service.upsert(user, w!.id, 'reading')));
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => {
        const e = r.reason as { code?: string; cause?: { code?: string }; statusCode?: number; message?: string };
        return e.code ?? e.cause?.code ?? e.statusCode ?? e.message;
      });
    const rows = await db.execute<{ attempt_no: number; status: string }>(sql`
      SELECT attempt_no, status FROM reads WHERE user_id = ${user} ORDER BY attempt_no`);
    console.log(`${n} concurrent starts: ${results.length - errors.length} ok, ${errors.length} failed ${JSON.stringify(errors)}`);
    console.log(`attempts: ${rows.map((r) => `${r.attempt_no}:${r.status}`).join(', ')}`);
  } finally {
    await closeDb(db);
  }
}

void main();
