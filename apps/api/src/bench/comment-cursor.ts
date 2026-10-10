// Audit 14, A-14-020: walk one comment thread page by page on a real
// Postgres (PGlite's clock has only milliseconds, so the tests cannot see the
// bug). Seeds one read with 7 comments by bench-style users, walks it at
// limit 2, prints what it saw, and removes what it seeded.
//
//   DATABASE_URL=… npx tsx src/bench/comment-cursor.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, closeDb } from '../platform/index.js';
import { InteractionService } from '../interactions/index.js';

const db = makeDb();
const owner = randomUUID();
let workId: string | null = null;
const email = `comment-cursor-${owner}@bench.flyleaf.invalid`;
try {
  await db.execute(sql`INSERT INTO users (id, email, password_hash, date_of_birth, email_verified_at)
    VALUES (${owner}, ${email}, 'unused', '1990-01-01', now())`);
  await db.execute(sql`INSERT INTO profiles (user_id, username) VALUES (${owner}, ${`bench_cc_${owner.slice(0, 8)}`})`);
  const [w] = await db.execute<{ id: string }>(sql`INSERT INTO works (title) VALUES ('Comment cursor probe') RETURNING id`);
  workId = w!.id;
  const [r] = await db.execute<{ id: string }>(sql`
    INSERT INTO reads (user_id, work_id, status, attempt_no, visibility, finished_at, started_at)
    VALUES (${owner}, ${w!.id}, 'finished', 1, 'public', CURRENT_DATE, CURRENT_DATE) RETURNING id`);
  const posted: string[] = [];
  for (let i = 0; i < 7; i++) {
    const [c] = await db.execute<{ id: string }>(sql`
      INSERT INTO read_comments (read_id, user_id, body) VALUES (${r!.id}, ${owner}, ${`c${i}`}) RETURNING id`);
    posted.push(c!.id);
  }
  const svc = new InteractionService(db);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await svc.listComments(owner, r!.id, { cursor, limit: 2 });
    seen.push(...page.comments.map((c) => c.id));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  const short = (id: string) => `c${posted.indexOf(id)}`;
  console.log(`posted ${posted.length}, served ${seen.length}: ${seen.map(short).join(' ')}`);
  console.log(seen.length === posted.length && seen.every((id, i) => id === posted[i]) ? 'OK: each once, in order' : 'WRONG');
} finally {
  // The user first: their read and comments cascade, and then the work is free.
  await db.execute(sql`DELETE FROM users WHERE id = ${owner}`);
  if (workId) await db.execute(sql`DELETE FROM works WHERE id = ${workId}`);
  await closeDb(db);
}
