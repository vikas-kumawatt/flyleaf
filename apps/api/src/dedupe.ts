// Duplicate detection pass (FN-50). architecture.md §9 runs this monthly,
// after an ingest.
//
//   npm run dedupe -- --dry-run                  what it would do, changing nothing
//   npm run dedupe -- --dry-run --sample 25      …plus 25 random pairs of each kind
//   npm run dedupe                               detect, and queue pairs for review
//   npm run dedupe -- --auto-merge               also merge the unambiguous pairs
//   npm run dedupe -- --auto-merge --cap 50      a cautious first merge pass
//
// Merging is OFF unless asked for (Audit 03b), here and in the scheduled job
// (DEDUPE_AUTO_MERGE=true). ALWAYS DRY-RUN FIRST on a catalog you care about.
// Merges are reversible for 30 days by design (PRD §40.3, FN-51) via undoMerge
// or the admin console.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { config, makeDb, waitForDb, closeDb, type Db } from './platform/index.js';
import { DEFAULT_MERGE_CAP, runDedupe, type Stage12Pair } from './catalog/dedupe.js';

const commas = (n: number) => n.toLocaleString('en-US');

function intFlag(argv: string[], name: string, fallback: number): number {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(argv[at + 1]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} needs a whole number, got ${JSON.stringify(argv[at + 1] ?? '')}`);
  }
  return value;
}

/** A random sample without replacement (Fisher-Yates on a copy). */
function sample<T>(items: T[], n: number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

async function printSample(db: Db, label: string, pairs: Stage12Pair[]) {
  if (pairs.length === 0) return;
  const ids = pairs.flatMap((p) => [p.survivorId, p.loserId]);
  const rows = await db.execute<{ id: string; title: string; year: number | null; authors: string | null }>(sql`
    SELECT w.id, w.title, w.first_publish_year AS year,
           (SELECT string_agg(a.name, ', ' ORDER BY wa.position)
            FROM work_authors wa JOIN authors a ON a.id = wa.author_id WHERE wa.work_id = w.id) AS authors
    FROM works w WHERE w.id = ANY (${`{${ids.join(',')}}`}::uuid[])`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const show = (id: string) => {
    const w = byId.get(id);
    return w ? `${JSON.stringify(w.title)} (${w.year ?? '?'}) by ${w.authors ?? '?'}` : id;
  };
  console.log(`\n${label}`);
  for (const [i, p] of pairs.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. [stage ${p.stages.join('+')}] ${p.reason}`);
    console.log(`      keep  ${show(p.survivorId)}  ${p.survivorId}`);
    console.log(`      merge ${show(p.loserId)}  ${p.loserId}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const autoMerge = argv.includes('--auto-merge');
  const mergeCap = intFlag(argv, '--cap', DEFAULT_MERGE_CAP);
  const sampleSize = intFlag(argv, '--sample', 0);

  console.log(`connecting to ${config.databaseUrl.replace(/:[^:@]*@/, ':***@')}…`);
  const db = makeDb(config.databaseUrl, { max: 1, quiet: true });
  await waitForDb(db);

  try {
    const [before] = await db.execute<{ live: number; merged: number }>(sql`
      SELECT count(*) FILTER (WHERE merged_into_id IS NULL)::int AS live,
             count(*) FILTER (WHERE merged_into_id IS NOT NULL)::int AS merged
      FROM works`);
    console.log(`  ${commas(before!.live)} live works, ${commas(before!.merged)} already merged away`);
    console.log(dryRun ? '  dry run: nothing will be written\n'
      : autoMerge ? `  auto-merge ON, at most ${commas(mergeCap)} merges\n`
      : '  auto-merge OFF: detect and queue only (--auto-merge to merge)\n');

    // Progress on one line per merge. A pass over a real catalog can run for
    // a while, and silence is indistinguishable from a hang -- the lesson
    // that cost four rounds during the ingest.
    let detected: Stage12Pair[] = [];
    const started = Date.now();
    const report = await runDedupe(db, {
      dryRun,
      autoMerge,
      mergeCap,
      onDetected: (pairs) => {
        detected = pairs;
        console.log(`  stages 1-2 detected in ${Math.round((Date.now() - started) / 1000)} s`);
      },
      onStage3: (t) => console.log(
        `  stage 3: ${commas(t.probeAuthors)} probe authors in ${Math.round(t.probeMs / 1000)} s, ` +
        `${commas(t.authorPairs)} similar author records in ${Math.round(t.peersMs / 1000)} s, ` +
        `title pairs in ${Math.round(t.pairsMs / 1000)} s`),
      onMerge: (c) => process.stdout.write(`  merged  stage ${c.stage}  ${c.reason}\n`),
    });

    console.log(
      `\n${dryRun ? 'dry run' : 'done'} in ${Math.round((Date.now() - started) / 1000)} s\n` +
      `  stage 1 pairs (shared ISBN-13)         ${commas(report.stage1)}\n` +
      `  stage 2 pairs (title + author)         ${commas(report.stage2)}\n` +
      `  unambiguous: auto-mergeable            ${commas(report.autoMergeable)}\n` +
      `  ambiguous: to the review queue         ${commas(report.toReview)}\n` +
      `  stage 3 pairs (fuzzy, review only)     ${commas(report.stage3)}\n` +
      `  stage 3 also probed works created after ${report.stage3Since ?? '(first run: none)'}\n` +
      (dryRun
        ? `\nNothing was changed.`
        : `  newly queued (stages 1-2 / stage 3)    ${commas(report.queued)} / ${commas(report.stage3Queued)}\n` +
          `  merged                                 ${commas(report.merged)}${report.autoMerge ? '' : ' (auto-merge off)'}\n` +
          `  skipped (already merged)               ${commas(report.skipped)}\n` +
          `  left for the next run (merge cap)      ${commas(report.deferred)}`));

    if (sampleSize > 0) {
      await printSample(db, `${sampleSize} random AUTO-MERGEABLE pairs`, sample(detected.filter((p) => p.auto), sampleSize));
      await printSample(db, `${sampleSize} random REVIEW-QUEUE pairs`, sample(detected.filter((p) => !p.auto), sampleSize));
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
