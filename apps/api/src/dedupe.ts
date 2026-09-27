// Duplicate detection pass (FN-50). architecture.md §9 runs this monthly,
// after an ingest.
//
//   npm run dedupe -- --dry-run                  what it would do, changing nothing
//   npm run dedupe -- --dry-run --sample 25      …plus 25 random pairs of each kind
//   npm run dedupe                               detect, and queue pairs for review
//   npm run dedupe -- --auto-merge               also merge the unambiguous pairs
//   npm run dedupe -- --auto-merge --cap 50      a cautious first merge pass
//
//   npm run dedupe -- --backlog --dry-run        one backlog batch: what it would merge
//   npm run dedupe -- --backlog [--limit 5000]   merge one batch of the backlog
//
// Merging is OFF unless asked for (Audit 03b), here and in the scheduled job
// (DEDUPE_AUTO_MERGE=true). ALWAYS DRY-RUN FIRST on a catalog you care about.
// Merges are reversible for 30 days by design (PRD §40.3, FN-51) via undoMerge
// or the admin console.
//
// The monthly job's 200-merge cap is for NEW duplicates. The backlog the first
// pass finds is cleared by hand with --backlog batches (Audit 03c, D6): each
// batch writes 25 random merged pairs to dedupe-batches/, and the procedure in
// the README says when to stop.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { config, makeDb, waitForDb, closeDb, type Db } from './platform/index.js';
import {
  BACKLOG_SAMPLE_SIZE, DEFAULT_BACKLOG_LIMIT, DEFAULT_MERGE_CAP, describeWorks, randomSample, runBacklogBatch,
  runDedupe, type BacklogPair, type Stage12Pair, type WorkSummary,
} from './catalog/dedupe.js';

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

const describe = (w: WorkSummary | null | undefined) =>
  w ? `${JSON.stringify(w.title)} (${w.year ?? '?'}) by ${w.authors ?? '?'}` : '?';

async function printSample(db: Db, label: string, pairs: Stage12Pair[]) {
  if (pairs.length === 0) return;
  const byId = await describeWorks(db, pairs.flatMap((p) => [p.survivorId, p.loserId]));
  const show = (id: string) => (byId.has(id) ? describe(byId.get(id)) : id);
  console.log(`\n${label}`);
  for (const [i, p] of pairs.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. [stage ${p.stages.join('+')}] ${p.reason}`);
    console.log(`      keep  ${show(p.survivorId)}  ${p.survivorId}`);
    console.log(`      merge ${show(p.loserId)}  ${p.loserId}`);
  }
}

/** The batch's sample as Markdown: what a person reads before running the next batch. */
export function sampleFile(
  when: Date, database: string, dryRun: boolean,
  r: Awaited<ReturnType<typeof runBacklogBatch>>,
): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const work = (w: WorkSummary | null, id: string) => `${cell(describe(w))} \`${id}\``;
  return [
    `# Dedupe backlog batch, ${when.toISOString()}${dryRun ? ' (DRY RUN: nothing merged)' : ''}`,
    '',
    `Database: ${database}`,
    '',
    `| Found (this batch) | Attempted | Merged | Skipped (already merged) | More after this batch | Authors scanned |`,
    `|---|---|---|---|---|---|`,
    `| ${commas(r.found)} | ${commas(r.attempted)} | ${commas(r.merged)} | ${commas(r.skipped)} | ${r.more ? 'yes' : 'no'} | ${commas(r.authorsScanned)} |`,
    '',
    `Held back for review by the D5 rules among the authors scanned (a pair can count twice): group of more than two ${commas(r.held.group)}, ` +
      `series positions ${commas(r.held.series)}, volume marker ${commas(r.held.volume)}, page counts ${commas(r.held.pages)}.`,
    '',
    `**Check every pair below.** If 2 or more of these ${r.sample.length} are different books, stop: do not run the ` +
      'next batch until the rules are tightened. A wrong merge can be undone for 30 days from `/admin/merges` ' +
      '(or `undoMerge` with its merge id).',
    '',
    `| # | Stage | Why | Keep (survivor) | ${dryRun ? 'Would merge' : 'Merged'} (loser) | Merge id |`,
    `|---|---|---|---|---|---|`,
    ...r.sample.map((p: BacklogPair, i) =>
      `| ${i + 1} | ${p.stages.join('+')} | ${cell(p.reason)} | ${work(p.survivor, p.survivorId)} | ` +
      `${work(p.loser, p.loserId)} | ${p.mergeId ?? '-'} |`),
    '',
  ].join('\n');
}

async function backlog(db: Db, argv: string[], dryRun: boolean) {
  const limit = intFlag(argv, '--limit', DEFAULT_BACKLOG_LIMIT);
  if (limit < 1) throw new Error('--limit needs to be at least 1');
  console.log(dryRun
    ? `  backlog batch, dry run: nothing will be merged (limit ${commas(limit)})\n`
    : `  backlog batch: merging up to ${commas(limit)} pairs\n`);

  const started = Date.now();
  let merged = 0;
  const r = await runBacklogBatch(db, {
    limit,
    dryRun,
    onMerge: () => {
      if (++merged % 100 === 0) console.log(`  merged ${commas(merged)} in ${Math.round((Date.now() - started) / 1000)} s`);
    },
    onBatch: (authors, found) => {
      console.log(`  scanned ${commas(authors)} authors, ${commas(found)} pairs found, ${Math.round((Date.now() - started) / 1000)} s`);
    },
  });

  const when = new Date();
  const dir = path.resolve('dedupe-batches');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backlog-${when.toISOString().replace(/[:.]/g, '-')}${dryRun ? '-dry-run' : ''}.md`);
  writeFileSync(file, sampleFile(when, config.databaseUrl.replace(/:[^:@]*@/, ':***@'), dryRun, r));

  console.log(
    `\n${dryRun ? 'dry run' : 'batch done'} in ${Math.round((Date.now() - started) / 1000)} s\n` +
    `  auto-mergeable pairs found             ${commas(r.found)} (authors scanned ${commas(r.authorsScanned)})\n` +
    `  attempted / merged / skipped           ${commas(r.attempted)} / ${commas(r.merged)} / ${commas(r.skipped)}\n` +
    `  more left for later batches            ${r.more ? 'yes' : 'no'}\n` +
    `  ${r.sample.length} random ${dryRun ? 'would-merge' : 'merged'} pairs: ${file}\n` +
    `\nRead the sample. If 2 or more of the ${BACKLOG_SAMPLE_SIZE} are different books, stop and tighten the rules.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const isBacklog = argv.includes('--backlog');
  if (!isBacklog && argv.includes('--limit')) throw new Error('--limit is for --backlog batches; a monthly-style pass takes --cap');
  if (isBacklog && (argv.includes('--cap') || argv.includes('--auto-merge'))) {
    throw new Error('--backlog merges by itself, up to --limit; --cap and --auto-merge are for the monthly-style pass');
  }
  const autoMerge = argv.includes('--auto-merge');
  const mergeCap = intFlag(argv, '--cap', DEFAULT_MERGE_CAP);
  const sampleSize = intFlag(argv, '--sample', 0);

  console.log(`connecting to ${config.databaseUrl.replace(/:[^:@]*@/, ':***@')}…`);
  const db = makeDb(config.databaseUrl, { max: 1, quiet: true });
  await waitForDb(db);

  try {
    if (isBacklog) {
      await backlog(db, argv, dryRun);
      return;
    }
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
      `  stage 3 pairs (fuzzy, review only)     ${commas(report.stage3)} ` +
        `(also found by stages 1-2: ${commas(report.stage3AlreadyFound)}, dismissed: ${commas(report.stage3Dismissed)})\n` +
      `  stage 3 also probed works created after ${report.stage3Since ?? '(first run: none)'}\n` +
      `  held back from auto-merge (D5)         group ${commas(report.held.group)}, series ${commas(report.held.series)}, ` +
        `volume marker ${commas(report.held.volume)}, pages ${commas(report.held.pages)}\n` +
      `  review queue: open at start            ${commas(report.queueOpen)} (of this pass's pairs already pending: ${commas(report.alreadyPending)})\n` +
      `  ${dryRun ? 'would queue' : 'planned to queue'} (stages 1-2 / stage 3)  ${commas(report.planned.stage12)} / ${commas(report.planned.stage3)}\n` +
      `  ${dryRun ? 'would record' : 'recorded'} as candidates         cold ${commas(report.notQueued.cold)}, ` +
        `queue full ${commas(report.notQueued.queueFull)}, stage-3 share ${commas(report.notQueued.stage3Share)}\n` +
      (dryRun
        ? `\nNothing was changed.`
        : `  newly queued (stages 1-2 / stage 3)    ${commas(report.queued)} / ${commas(report.stage3Queued)}\n` +
          `  merged                                 ${commas(report.merged)}${report.autoMerge ? '' : ' (auto-merge off)'}\n` +
          `  skipped (already merged)               ${commas(report.skipped)}\n` +
          `  left for the next run (merge cap)      ${commas(report.deferred)}`));

    if (sampleSize > 0) {
      await printSample(db, `${sampleSize} random AUTO-MERGEABLE pairs`, randomSample(detected.filter((p) => p.auto), sampleSize));
      await printSample(db, `${sampleSize} random REVIEW-QUEUE pairs`, randomSample(detected.filter((p) => !p.auto), sampleSize));
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
