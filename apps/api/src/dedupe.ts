// Duplicate detection pass (FN-50). architecture.md §9 runs this monthly,
// after an ingest.
//
//   npm run dedupe -- --dry-run        what it would merge, changing nothing
//   npm run dedupe                     do it
//   npm run dedupe -- --limit 50       a cautious first pass
//
// ALWAYS DRY-RUN FIRST on a catalog you care about. A merge is reversible for
// 30 days by design (PRD §40.3) but the undo is FN-51 and does not exist yet,
// so today a wrong merge is undone by hand from `work_merges`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { config, makeDb, waitForDb, closeDb } from './platform/index.js';
import { runDedupe } from './catalog/dedupe.js';

const commas = (n: number) => n.toLocaleString('en-US');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg === -1 ? 1000 : Number(argv[limitArg + 1]);

  console.log(`connecting to ${config.databaseUrl.replace(/:[^:@]*@/, ':***@')}…`);
  const db = makeDb(config.databaseUrl, { max: 1, quiet: true });
  await waitForDb(db);

  try {
    const [before] = await db.execute<{ live: number; merged: number }>(sql`
      SELECT count(*) FILTER (WHERE merged_into_id IS NULL)::int AS live,
             count(*) FILTER (WHERE merged_into_id IS NOT NULL)::int AS merged
      FROM works`);
    console.log(`  ${commas(before!.live)} live works, ${commas(before!.merged)} already merged away\n`);

    // Progress on one line per merge. A pass over a real catalog can run for
    // a while, and silence is indistinguishable from a hang -- the lesson
    // that cost four rounds during the ingest.
    const report = await runDedupe(db, {
      limit,
      dryRun,
      onMerge: (c) => process.stdout.write(`  merged  stage ${c.stage}  ${c.reason}\n`),
    });

    console.log(
      `\n${dryRun ? 'dry run' : 'done'}\n` +
      `  stage 1 (shared ISBN-13)      ${commas(report.stage1)}\n` +
      `  stage 2 (title + author)      ${commas(report.stage2)}\n` +
      (dryRun
        ? `\nNothing was changed. Re-run without --dry-run to apply.`
        : `  merged                        ${commas(report.merged)}\n` +
          `  skipped (already merged)      ${commas(report.skipped)}`));

    if (report.stage1 === 0 && report.stage2 > 0) {
      console.log(
        `\nStage 1 found nothing, which is expected until the editions pass runs:\n` +
        `ISBNs live on editions, and a catalog with a handful of them has no\n` +
        `ISBN duplicates to find.`);
    }
  } finally {
    await closeDb(db);
  }
}

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
