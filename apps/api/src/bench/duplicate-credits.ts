// A-03-027 (Audit 15): works credited to two author records with the same
// name, and what an author-dedupe pass for such records would merge.
// READ-ONLY. For the laptop session (docs/audit/15b-laptop.md):
//
//   npx tsx src/bench/duplicate-credits.ts [--sample 25]
//
// Prints:
//   1. live works with a same-name double credit (Part 03c measured 11,112
//      works / 12,524 pairs on `flyleaf`), and how long the count took;
//   2. same-name author-record pairs that share at least one work: the
//      candidates for an author merge (the "measure before choosing" step);
//   3. a random sample of (2), with each record's credited-work count.
// Runs under the dedupe profile (work_mem 64 MB, 30 min statement timeout,
// one parallel worker) and in a READ ONLY transaction.

import { sql } from 'drizzle-orm';
import { closeDb, config, JOB_DB_SETTINGS, makeDb } from '../platform/index.js';

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const SAMPLE = arg('sample', 25);

const db = makeDb(config.databaseUrl, { max: 1, quiet: true, settings: JOB_DB_SETTINGS.dedupe });
console.log(`database: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const t0 = Date.now();
    const [works] = await tx.execute<{ works: number; pairs: number }>(sql`
      SELECT count(DISTINCT x.work_id)::int AS works, count(*)::int AS pairs
      FROM work_authors x
      JOIN work_authors y ON y.work_id = x.work_id AND y.author_id > x.author_id
      JOIN authors ax ON ax.id = x.author_id
      JOIN authors ay ON ay.id = y.author_id
      JOIN works w ON w.id = x.work_id AND w.merged_into_id IS NULL
      WHERE lower(btrim(ax.name)) = lower(btrim(ay.name))`);
    console.log(`\n1. live works credited twice under one name: ${works?.works} works, ${works?.pairs} pairs (${Date.now() - t0} ms)`);

    const t1 = Date.now();
    const [records] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT DISTINCT x.author_id, y.author_id
        FROM work_authors x
        JOIN work_authors y ON y.work_id = x.work_id AND y.author_id > x.author_id
        JOIN authors ax ON ax.id = x.author_id
        JOIN authors ay ON ay.id = y.author_id
        WHERE lower(btrim(ax.name)) = lower(btrim(ay.name))) p`);
    console.log(`2. same-name author-record pairs sharing a work (merge candidates): ${records?.n} (${Date.now() - t1} ms)`);

    const sample = await tx.execute<{ name: string; a: string; b: string; a_works: number; b_works: number; shared: number }>(sql`
      WITH p AS (
        SELECT x.author_id AS a, y.author_id AS b, count(*)::int AS shared
        FROM work_authors x
        JOIN work_authors y ON y.work_id = x.work_id AND y.author_id > x.author_id
        JOIN authors ax ON ax.id = x.author_id
        JOIN authors ay ON ay.id = y.author_id
        WHERE lower(btrim(ax.name)) = lower(btrim(ay.name))
        GROUP BY 1, 2)
      SELECT au.name, aa.ol_author_key AS a, ab.ol_author_key AS b,
        (SELECT count(*)::int FROM work_authors WHERE author_id = p.a) AS a_works,
        (SELECT count(*)::int FROM work_authors WHERE author_id = p.b) AS b_works,
        p.shared
      FROM p
      JOIN authors au ON au.id = p.a
      JOIN authors aa ON aa.id = p.a
      JOIN authors ab ON ab.id = p.b
      ORDER BY random() LIMIT ${SAMPLE}`);
    console.log(`\n3. sample of ${sample.length}:`);
    console.log('| name | record A (works) | record B (works) | shared |');
    console.log('|---|---|---|---|');
    for (const r of sample) console.log(`| ${r.name} | ${r.a} (${r.a_works}) | ${r.b} (${r.b_works}) | ${r.shared} |`);
  });
} finally {
  await closeDb(db);
}
