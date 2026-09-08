// Open Library dump ingest (FN-20 -> FN-26).
//
//   npm run ingest -- --type authors  --file data/ol_dump_authors_latest.txt.gz
//   npm run ingest -- --type works    --file data/ol_dump_works_latest.txt.gz --seed data/ol_dump_reading-log_latest.txt.gz
//   npm run ingest -- --type editions --file data/ol_dump_editions_latest.txt.gz
//   npm run ingest -- --finalise
//
// ORDER NO LONGER MATTERS. An authorship link whose author has not been
// ingested yet is parked in `pending_work_authors`, and `--finalise`
// resolves whatever has become resolvable. Running authors first is still
// marginally more efficient, but nothing is lost by not doing it -- which
// means you can load the books you actually want to look at without first
// waiting out ~17 million author records.
//
// Flags:
//   --seed <file...>  keep only works appearing in the reading-log/ratings
//                     dumps. 65 MB and 5 MB, against 2.9 GB. This is the
//                     accelerator's layer 1 (phases.md) and turns a multi-day
//                     ingest into an evening.
//   --limit <n>       stop after n written rows. For trying it out.
//   --no-raw          skip raw_payloads retention. Saves disk, costs you the
//                     ability to reprocess without re-downloading.
//   --restart         ignore any checkpoint and start from line 1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { config, makeDb, waitForDb, closeDb } from './platform/index.js';
import { readDump, popularWorkKeys, workPopularity, DUMP_URLS, type DumpType, type DumpProgress } from './catalog/ingest/dump.js';
import {
  normaliseAuthor, normaliseWork, normaliseEdition,
  type AuthorRow, type WorkRow, type EditionRow,
} from './catalog/ingest/normalise.js';
import {
  createStaging, dropStaging, writeAuthors, writeWorks, writeEditions, writeRawPayloads,
  RESOLVE_PENDING_WORK_AUTHORS,
} from './catalog/ingest/writer.js';

// architecture.md §5.1 says 5,000. That is right for the COPY itself, but
// the cost here is the ON CONFLICT merge probing a large unique index, and
// that amortises better over a larger batch.
const BATCH = 20_000;
const CHECKPOINT_EVERY = 50_000;  // lines, not rows

type Args = {
  type?: DumpType;
  file?: string;
  seed: string[];
  limit: number;
  raw: boolean | null;      // null = use the per-type default
  restart: boolean;
  finalise: boolean;
  status: boolean;
  popularity: boolean;
  onlyReferenced: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    seed: [], limit: Infinity, raw: null, restart: false, finalise: false, status: false,
    popularity: false, onlyReferenced: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') out.type = argv[++i] as DumpType;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--no-raw') out.raw = false;
    else if (a === '--raw') out.raw = true;
    else if (a === '--restart') out.restart = true;
    else if (a === '--finalise' || a === '--finalize') out.finalise = true;
    else if (a === '--status') out.status = true;
    else if (a === '--popularity') out.popularity = true;
    else if (a === '--only-referenced') out.onlyReferenced = true;
    else if (a === '--seed') {
      while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) out.seed.push(argv[++i]!);
    }
  }
  return out;
}

/**
 * Retain raw payloads for works and editions, but NOT authors.
 *
 * Raw retention exists so that improving the normaliser or the maturity
 * classifier is a reprocess rather than a re-download. That argument is
 * strong for works (subjects, descriptions, classification) and editions
 * (formats, ISBNs, page counts). It is weak for authors, which are a name
 * and a couple of dates with nothing to reinterpret.
 *
 * It is also expensive: ~17 million records means tens of gigabytes of jsonb,
 * TOASTed and upserted, to answer a question nobody will ask.
 *
 * HONESTY NOTE: turning this off was first sold as the fix for a slow authors
 * pass. It was not. Instrumenting the loop showed `merge 94% raw 0%` -- the
 * real cost is the ON CONFLICT probe into a large unique index, addressed by
 * BULK_LOAD_SETTINGS and a bigger BATCH. Skipping author payloads is still
 * right on its own merits; it just was not the bottleneck.
 *
 * `--raw` forces it back on.
 */
const RAW_BY_DEFAULT: Record<DumpType, boolean> = {
  authors: false,
  works: true,
  editions: true,
};

/**
 * What the process is waiting on, for the exit handler to report.
 *
 * A run ended silently three times: the event loop drained while something
 * awaited never settled, and Node calls that success. Knowing WHICH await is
 * the whole diagnosis, and no stack trace exists for a promise that is simply
 * never resolved.
 */
let stage = 'startup';

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
const commas = (n: number) => n.toLocaleString('en-US');

const done = (p: { bytesRead: number; totalBytes: number }) =>
  p.totalBytes ? `${((p.bytesRead / p.totalBytes) * 100).toFixed(1).padStart(5)}%` : '  ?  ';

/**
 * Time remaining, from COMPRESSED bytes consumed.
 *
 * Lines cannot give you this: knowing how many lines a gzipped dump holds
 * means decompressing all of it, which is the job. Bytes are known from
 * `stat` before the first record is read.
 */
function eta(p: { bytesRead: number; totalBytes: number }, elapsedMs: number): string {
  if (!p.totalBytes || p.bytesRead === 0) return 'ETA ?';
  const remaining = ((p.totalBytes - p.bytesRead) / p.bytesRead) * elapsedMs;
  const secs = Math.round(remaining / 1000);

  // Seconds below a minute. Rounding 40 seconds to "0m" reads as a bug, and
  // it is the range you are in exactly when you are watching most closely.
  if (secs < 60) return `ETA ${secs}s`;
  const mins = Math.round(secs / 60);
  return mins >= 60
    ? `ETA ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`
    : `ETA ${mins}m`;
}

/**
 * Run something slow while printing elapsed seconds on one line.
 *
 * `CREATE INDEX`, `ANALYZE` and `DROP INDEX` report nothing at all, and on a
 * 3-million-row table a GIN rebuild is minutes. Without this the terminal
 * sits blank and there is no way to tell "working" from "wedged" -- which has
 * already cost an hour once in this project.
 */
async function withHeartbeat<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  process.stdout.write(`  ${label}…`);
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${label}… ${secs()}s   `);
  }, 5_000);

  try {
    const result = await fn();
    clearInterval(timer);
    process.stdout.write(`\r  ${label} — ${secs()}s\n`);
    return result;
  } catch (err) {
    clearInterval(timer);
    process.stdout.write('\n');
    throw err;
  }
}

/**
 * Session settings for a bulk load. Applied to a SINGLE pinned connection,
 * which is why the ingest uses a pool of one -- a `SET` only affects the
 * connection it ran on, so with a pool of ten it would apply to whichever
 * one happened to serve the statement.
 *
 * `synchronous_commit = off` is the one that matters. It stops Postgres
 * waiting for an fsync before acknowledging each commit, which on Docker
 * Desktop for Windows is most of the cost of a small write. The trade is
 * that a hard crash can lose the last fraction of a second of commits --
 * which for THIS job is free, because the ingest is checkpointed and replay
 * is a no-op. It is a per-session setting and never touches the API.
 */
const BULK_LOAD_SETTINGS = [
  'SET synchronous_commit = off',
  `SET work_mem = '64MB'`,
  `SET maintenance_work_mem = '256MB'`,
];

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Say something before the first network call. Silence at startup used to
  // be ambiguous between "connecting", "waiting on a lock" and "hung", and a
  // killed run whose server-side statement is still executing looks exactly
  // like a hang -- Postgres only notices the client is gone when it next
  // tries to write to it, which a long UPDATE does not do until it finishes.
  console.log(`connecting to ${config.databaseUrl.replace(/:[^:@]*@/, ':***@')}…`);

  const db = makeDb(config.databaseUrl, { max: 1, quiet: true });
  await waitForDb(db);

  // Anything already running is either another ingest or the remains of one
  // that was killed. Either way it holds locks and I/O, and saying so beats
  // sitting in front of a blank terminal.
  const busy = await db.execute<{ pid: number; runtime: string; query: string }>(sql`
    SELECT pid,
           to_char(now() - query_start, 'HH24:MI:SS') AS runtime,
           left(query, 60) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state <> 'idle'
      AND query_start < now() - interval '30 seconds'`);

  if (busy.length) {
    console.warn('\n  WARNING: something is already running on this database:');
    for (const b of busy) {
      console.warn(`    pid ${b.pid} · ${b.runtime} · ${b.query.replace(/\s+/g, ' ')}`);
    }
    console.warn(
      '\n  If that is a run you killed, its statement is still executing server-side.\n' +
      '  Stop it with:\n' +
      `    docker exec flyleaf-pg psql -U flyleaf -d flyleaf -c "SELECT pg_terminate_backend(${busy[0]!.pid});"\n`);
  }

  const client = db.$client;

  try {
    if (args.status) {
      await printStatus(db);
      return;
    }

    if (args.popularity) {
      if (args.seed.length === 0) {
        console.error('--popularity needs --seed <reading-log.txt.gz> [ratings.txt.gz]');
        process.exitCode = 1;
        return;
      }
      await loadPopularity(db, args.seed);
      return;
    }

    if (args.finalise) {
      await finalise(db);
      return;
    }

    if (!args.type || !args.file) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }
    if (!fs.existsSync(args.file)) {
      console.error(`Not found: ${args.file}\n\nDownload it from:\n  ${DUMP_URLS[args.type]}`);
      process.exitCode = 1;
      return;
    }

    const retainRaw = args.raw ?? RAW_BY_DEFAULT[args.type];

    // ---------------------------------------------------------- checkpoint
    const absolute = path.resolve(args.file);
    let skipLines = 0;
    let runId: string;

    // Set by the signal handler below; read by the loop.
    let stopping = false;
    // False until the first record is yielded. Everything before that -- the
    // referenced-key query and the resume skip -- has nothing worth saving,
    // so a signal there should end the process rather than wait for a
    // checkpoint that will not arrive.
    let reading = false;

    const [previous] = args.restart ? [] : await db.execute<{ id: string; lines_read: number }>(sql`
      SELECT id, lines_read FROM ingest_runs
      WHERE dump_type = ${args.type} AND source_file = ${absolute}
        AND status IN ('running', 'interrupted')
      ORDER BY started_at DESC LIMIT 1
    `);

    if (previous) {
      skipLines = Number(previous.lines_read);
      runId = previous.id;
      console.log(`resuming at line ${commas(skipLines)}`);
      await db.execute(sql`UPDATE ingest_runs SET status='running', updated_at=now() WHERE id=${runId}`);
    } else {
      const [row] = await db.execute<{ id: string }>(sql`
        INSERT INTO ingest_runs (dump_type, source_file, file_size)
        VALUES (${args.type}, ${absolute}, ${fs.statSync(absolute).size})
        RETURNING id
      `);
      runId = row!.id;
    }

    /**
     * Ctrl+C, wherever it lands.
     *
     * This used to be registered immediately before the read loop. Everything
     * that runs first -- the 1.66M-row referenced-key query, and on a resume
     * the decompression of every skipped line -- was therefore covered by
     * NODE'S DEFAULT handler, which terminates the process instantly with no
     * output and leaves the run row saying 'running'.
     *
     * That is indistinguishable from a crash: no error, no summary, just the
     * prompt back, and `--status` reporting a run that looks live. Registering
     * here means an interrupt is always announced and always recorded.
     */
    const onSignal = () => {
      if (stopping) process.exit(130);          // second one: go now
      stopping = true;
      if (reading) {
        process.stdout.write('\n  stopping at the next checkpoint…\n');
        return;
      }
      process.stdout.write('\n  interrupted before reading began — nothing new to save\n');
      void db
        .execute(sql`UPDATE ingest_runs SET status='interrupted', updated_at=now() WHERE id=${runId}`)
        .finally(() => process.exit(130));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // ---------------------------------------------------------- seed slice
    let keep: Set<string> | null = null;
    if (args.seed.length && args.type === 'works') {
      console.log('reading the popularity slice…');
      keep = await popularWorkKeys(args.seed);
      console.log(`  ${commas(keep.size)} works have been shelved or rated by somebody`);
    }

    // Re-running authors to pick up a new field does NOT need all 15.4M of
    // them -- only the ~1M that works actually reference. Same trick as
    // --seed and the editions filter: decide from the key, before parsing.
    if (args.type === 'authors' && args.onlyReferenced) {
      console.log('loading referenced author keys…');
      // EXISTS, not DISTINCT over a join.
      //
      // The join produces one row per authorship link -- 3.79M of them for
      // 1.66M authors -- and DISTINCT then has to sort or hash all of it,
      // which spilled to temp files (`wait_event = BuffileWrite`) and ran for
      // minutes. EXISTS is a semi-join: the planner stops at the first
      // matching link per author and never materialises the duplicates.
      const rows = await db.execute<{ ol_author_key: string }>(sql`
        SELECT a.ol_author_key
        FROM authors a
        WHERE a.ol_author_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM work_authors wa WHERE wa.author_id = a.id)`);
      keep = new Set(rows.map((r) => r.ol_author_key));
      console.log(`  ${commas(keep.size)} authors are actually credited on a work`);
      if (keep.size === 0) {
        console.error('\nNo authorship links yet. Drop --only-referenced.');
        process.exitCode = 1;
        return;
      }
    }

    // The editions dump is ~45 million records, and an edition whose work we
    // never kept is discarded by a JOIN inside MERGE_EDITIONS -- AFTER it has
    // been escaped, COPYed into staging and index-probed. Filtering in memory
    // first skips all of that. The set is the same shape as --seed and costs
    // a few hundred MB for a few million keys.
    if (args.type === 'editions') {
      console.log('loading kept work keys…');
      const rows = await db.execute<{ ol_work_key: string }>(
        sql`SELECT ol_work_key FROM works WHERE ol_work_key IS NOT NULL`);
      keep = new Set(rows.map((r) => r.ol_work_key));
      console.log(`  ${commas(keep.size)} works in the catalog to attach editions to`);
      if (keep.size === 0) {
        console.error('\nNo works ingested yet. Run the works pass first.');
        process.exitCode = 1;
        return;
      }
    }

    // Announced, like every other step that can take a moment. These two sit
    // in the gap between "loading referenced author keys…" and the first line
    // of the read loop, which is precisely where three runs have vanished
    // without a word.
    await withHeartbeat('applying bulk-load settings', async () => {
      for (const setting of BULK_LOAD_SETTINGS) await client.unsafe(setting);
    });
    await withHeartbeat('creating staging tables', () => createStaging(client));

    // ---------------------------------------------------------- the loop
    let written = 0, skipped = 0, malformed = 0, lastLine = skipLines;
    const started = Date.now();
    // Where the time actually goes. Guessing at this cost hours once.
    let msMerge = 0, msRaw = 0;
    const progress: DumpProgress = { bytesRead: 0, totalBytes: 0 };

    let authorBatch: AuthorRow[] = [];
    let workBatch: WorkRow[] = [];
    let editionBatch: EditionRow[] = [];
    let rawBatch: { key: string; json: unknown }[] = [];

    const flush = async () => {
      const t0 = Date.now();
      if (args.type === 'authors' && authorBatch.length) {
        stage = `writeAuthors(${authorBatch.length} rows)`;
        written += await writeAuthors(client, authorBatch);
        msMerge += Date.now() - t0;
        const t1 = Date.now();
        if (retainRaw) await writeRawPayloads(client, 'author', rawBatch);
        msRaw += Date.now() - t1;
        authorBatch = [];
      } else if (args.type === 'works' && workBatch.length) {
        written += await writeWorks(client, workBatch);
        msMerge += Date.now() - t0;
        const t1 = Date.now();
        if (retainRaw) await writeRawPayloads(client, 'work', rawBatch);
        msRaw += Date.now() - t1;
        workBatch = [];
      } else if (args.type === 'editions' && editionBatch.length) {
        written += await writeEditions(client, editionBatch);
        msMerge += Date.now() - t0;
        const t1 = Date.now();
        if (retainRaw) await writeRawPayloads(client, 'edition', rawBatch);
        msRaw += Date.now() - t1;
        editionBatch = [];
      }
      rawBatch = [];
      stage = 'reading';
    };

    const checkpoint = async () => {
      stage = 'checkpoint';
      await db.execute(sql`
        UPDATE ingest_runs
        SET lines_read = ${lastLine}, rows_written = ${written},
            rows_skipped = ${skipped}, updated_at = now()
        WHERE id = ${runId}`);
    };

    /**
     * Say something during the resume skip.
     *
     * gzip has no index, so resuming at line 3,904,610 means decompressing
     * 3,904,610 lines before the loop body runs even once -- minutes in which
     * nothing at all appears. Every other slow step in this file got a
     * heartbeat for exactly this reason (see withHeartbeat); the resume path
     * was the one that did not, and silence there reads as a hang.
     */
    const skipTicker = skipLines
      ? setInterval(() => {
          process.stdout.write(
            `\r  skipping to line ${commas(skipLines)} · ` +
            `${done(progress)} of the file decompressed   `);
        }, 2_000)
      : null;
    const stopSkipTicker = () => {
      if (skipTicker) {
        clearInterval(skipTicker);
        process.stdout.write('\r' + ' '.repeat(72) + '\r');
      }
    };

    for await (const record of readDump(absolute, {
      skipLines,
      onMalformed: () => { malformed++; },
      progress,
      // Reject on the key before the payload is parsed. On a seeded works
      // pass this is the difference between parsing 40 million JSON objects
      // and parsing the one or two million we keep.
      // Works and authors only. For editions `keep` holds WORK keys while
      // the record key is an EDITION key, so applying it here would reject
      // every line.
      accept: keep && (args.type === 'works' || args.type === 'authors')
        ? (key) => {
            if (keep!.has(key)) return true;
            skipped++;
            return false;
          }
        : undefined,
    })) {
      if (!reading) { reading = true; stopSkipTicker(); stage = 'reading'; }

      lastLine = record.line;   // accept-rejected lines are covered too: the
                                // next yielded line is always beyond them.

      if (args.type === 'authors') {
        const row = normaliseAuthor(record.key, record.json);
        if (!row) { skipped++; }
        else { authorBatch.push(row); if (retainRaw) rawBatch.push(record); }
      } else if (args.type === 'works') {
        // The seed filter already ran in `accept`, before parsing.
        const row = normaliseWork(record.key, record.json);
        if (!row) { skipped++; }
        else { workBatch.push(row); if (retainRaw) rawBatch.push(record); }
      } else {
        // Editions are keyed by EDITION, and the filter is on their WORK, so
        // this one cannot move into `accept` -- the work key is inside the
        // payload. Still skipped before it reaches the database, rather than
        // by a JOIN after being escaped, COPYed and index-probed.
        const row = normaliseEdition(record.key, record.json);
        if (!row || (keep && !keep.has(row.workKey))) { skipped++; }
        else { editionBatch.push(row); if (retainRaw) rawBatch.push(record); }
      }

      const pending = authorBatch.length + workBatch.length + editionBatch.length;
      if (pending >= BATCH) {
        await flush();
        if (record.line % CHECKPOINT_EVERY < BATCH) {
          await checkpoint();
          // (line - skipLines), not line. Dividing the absolute line number
          // by the elapsed time of a RESUMED run counts the skipped lines as
          // work and reports a rate several hundred times too high -- which
          // is exactly how a slowdown got mistaken for a speed-up once.
          const processed = record.line - skipLines;
          const rate = Math.round(processed / ((Date.now() - started) / 1000));
          const elapsed = Date.now() - started;
          console.log(
            `  ${done(progress)} · line ${commas(record.line)} · kept ${commas(written)} · ` +
            `${commas(rate)} lines/s · ` +
            `merge ${Math.round((msMerge / elapsed) * 100)}% raw ${Math.round((msRaw / elapsed) * 100)}% · ` +
            `${eta(progress, elapsed)}`);
        }
      }

      if (stopping || written >= args.limit) break;
    }

    stopSkipTicker();   // the dump can end inside the skip: resumed at EOF
    await flush();
    await checkpoint();

    const status = stopping ? 'interrupted' : 'done';
    await db.execute(sql`
      UPDATE ingest_runs SET status = ${status}, finished_at = now(), updated_at = now()
      WHERE id = ${runId}`);
    await dropStaging(client);

    const seconds = Math.round((Date.now() - started) / 1000);
    const human = seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}m`
      : `${Math.round(seconds / 60)}m`;
    console.log(
      `\n${status} — read ${commas(lastLine)} lines in ${human}\n` +
      `  kept      ${commas(written)}\n` +
      `  filtered  ${commas(skipped)} (${pct(skipped, lastLine)})\n` +
      `  malformed ${commas(malformed)}`);

    if (status === 'interrupted') {
      console.log('\nRe-run the same command to resume from the checkpoint.');
    } else if (args.type !== 'authors') {
      console.log('\nWhen every pass is done, run:  npm run ingest -- --finalise');
    }
  } finally {
    await closeDb(db);
  }
}

/**
 * The two GIN indexes on `works`, dropped before a bulk UPDATE and rebuilt
 * after. Kept here so `--finalise` can also recreate them, which is the
 * recovery path if a popularity run is killed midway.
 */
const WORKS_INDEXES: [name: string, ddl: string][] = [
  ['works_search_idx', 'CREATE INDEX IF NOT EXISTS works_search_idx ON works USING gin (search_vector)'],
  ['works_title_trgm_idx', 'CREATE INDEX IF NOT EXISTS works_title_trgm_idx ON works USING gin (title gin_trgm_ops)'],
  ['works_log_count_idx', 'CREATE INDEX IF NOT EXISTS works_log_count_idx ON works (log_count)'],
];

/**
 * Populate `works.log_count` from the reading-log and ratings dumps (FN-41).
 *
 * WHY THIS DROPS INDEXES FIRST. Updating three million rows through the two
 * GIN indexes is not slow, it is effectively unbounded. Postgres can skip
 * index maintenance on an UPDATE only via a HOT update, which requires that
 * no INDEXED column changed -- and `log_count` is indexed -- and that the
 * page has room, which after a bulk load it does not. So every row change
 * re-inserts into both GIN indexes: roughly five lexemes per title in
 * `works_search_idx` and twenty-odd trigrams in `works_title_trgm_idx`, so
 * on the order of eighty million GIN insertions to change one integer.
 *
 * Measured: the naive single UPDATE ran for over 50 minutes with no end in
 * sight. Dropping the indexes, updating, and building them once from scratch
 * is minutes -- a bulk build sorts the entries instead of inserting them one
 * at a time.
 *
 * If this is interrupted between the drop and the rebuild, search still
 * WORKS -- it just sequential-scans. `npm run ingest -- --finalise` recreates
 * them, and the failure path below says so.
 */
async function loadPopularity(db: ReturnType<typeof makeDb>, files: string[]) {
  const client = db.$client;
  for (const setting of BULK_LOAD_SETTINGS) await client.unsafe(setting);

  console.log('counting shelvings and ratings…');
  const readProgress: DumpProgress = { bytesRead: 0, totalBytes: 0 };
  const countStarted = Date.now();
  const countTicker = setInterval(() => {
    process.stdout.write(
      `\r  ${done(readProgress)} · ${eta(readProgress, Date.now() - countStarted)}   `);
  }, 2_000);

  let counts: Map<string, number>;
  try {
    counts = await workPopularity(files, readProgress);
  } finally {
    clearInterval(countTicker);
    process.stdout.write('\r');
  }
  console.log(`  ${commas(counts.size)} works with at least one shelving or rating`);

  console.log('writing counts to a staging table…');
  await client.unsafe('DROP TABLE IF EXISTS stage_popularity');
  await client.unsafe(`CREATE UNLOGGED TABLE stage_popularity (
    id int NOT NULL, ol_work_key text NOT NULL, n int NOT NULL)`);

  const CHUNK = 100_000;

  // Iterate the Map directly rather than [...counts.entries()].
  //
  // That spread allocates 3.3 million two-element arrays on top of a Map that
  // is already several hundred megabytes. On a laptop also running Docker
  // Desktop, a Postgres with 256MB maintenance_work_mem and a WSL2 VM, that
  // extra copy is enough to push the machine into swap -- and the thing that
  // falls over is usually Docker, which looks like a database outage rather
  // than a memory problem.
  const copyChunk = async (lines: string[]) => {
    const writable = await client.unsafe(
      'COPY stage_popularity (id, ol_work_key, n) FROM STDIN').writable();
    // `close` as well as `finish`/`error` — see copyIn() in writer.ts. Without
    // it, a connection lost mid-copy settles nothing and the process exits
    // silently with status 0.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      writable.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))));
      writable.on('finish', () => settle());
      writable.on('close', () => settle(
        new Error('COPY into stage_popularity ended without finishing — connection lost mid-copy')));
      writable.end(lines.join('\n') + '\n');
    });
  };

  let total = 0;
  let buffer: string[] = [];
  for (const [key, n] of counts) {
    buffer.push(`${total}\t${key}\t${n}`);
    total++;
    if (buffer.length >= CHUNK) {
      await copyChunk(buffer);
      buffer = [];
      process.stdout.write(
        `\r  ${((total / counts.size) * 100).toFixed(0).padStart(3)}% · ${commas(total)} staged   `);
    }
  }
  if (buffer.length) await copyChunk(buffer);
  process.stdout.write(`\r  100% · ${commas(total)} staged            \n`);
  counts.clear();   // several hundred MB, and the rest of this needs none of it

  await withHeartbeat('indexing the staging table',
    () => client.unsafe('CREATE INDEX ON stage_popularity (id)'));
  await client.unsafe('ANALYZE stage_popularity');

  try {
    console.log('dropping GIN indexes (rebuilt below — see the docblock for why)');
    for (const [name] of WORKS_INDEXES) {
      await withHeartbeat(`dropping ${name}`,
        () => client.unsafe(`DROP INDEX IF EXISTS ${name}`));
    }

    console.log('applying counts…');
    const started = Date.now();
    let updated = 0;
    for (let from = 0; from < total; from += CHUNK) {
      const res = await client.unsafe(`
        UPDATE works w SET log_count = s.n
        FROM stage_popularity s
        WHERE w.ol_work_key = s.ol_work_key
          AND s.id >= $1 AND s.id < $2
          AND w.log_count IS DISTINCT FROM s.n`, [from, from + CHUNK]);
      updated += (res as unknown as { count?: number }).count ?? 0;
      const elapsed = Date.now() - started;
      const pctDone = Math.min(1, (from + CHUNK) / total);
      const leftMs = elapsed / pctDone - elapsed;
      const leftMin = Math.floor(leftMs / 60_000);
      const leftSec = Math.round((leftMs % 60_000) / 1000);
      process.stdout.write(
        `\r  ${(pctDone * 100).toFixed(0).padStart(3)}% · ${commas(updated)} works scored · ` +
        `${Math.round(elapsed / 1000)}s elapsed · ETA ${leftMin}m${String(leftSec).padStart(2, '0')}s   `);
    }
    process.stdout.write('\n');
  } finally {
    console.log('rebuilding indexes (a GIN build on 3.2M rows takes minutes)');
    for (const [name, ddl] of WORKS_INDEXES) {
      try {
        await withHeartbeat(`building ${name}`, () => client.unsafe(ddl));
      } catch (err) {
        console.error(
          `\n  FAILED to rebuild ${name}. Search still works but will be slow.\n` +
          `  Recreate it with:  npm run ingest -- --finalise\n  ${String(err)}`);
      }
    }
    await client.unsafe('DROP TABLE IF EXISTS stage_popularity');
    await withHeartbeat('ANALYZE works', () => client.unsafe('ANALYZE works'));
  }

  const [top] = await db.execute<{ title: string; log_count: number }>(sql`
    SELECT title, log_count FROM works ORDER BY log_count DESC LIMIT 1`);
  const [scored] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM works WHERE log_count > 0`);

  console.log(
    `\n  ${commas(scored?.n ?? 0)} works have a popularity score\n` +
    `  most logged: ${top?.title} (${commas(Number(top?.log_count ?? 0))})`);
}

/** Where every run got to, and what is in the catalog right now. */
async function printStatus(db: ReturnType<typeof makeDb>) {
  const runs = await db.execute<{
    dump_type: string; status: string; lines_read: number;
    rows_written: number; rows_skipped: number; started_at: string; finished_at: string | null;
  }>(sql`
    SELECT dump_type, status, lines_read, rows_written, rows_skipped, started_at, finished_at
    FROM ingest_runs ORDER BY started_at DESC LIMIT 10`);

  if (runs.length === 0) {
    console.log('no ingest runs yet');
  } else {
    console.log('runs (newest first)\n');
    for (const r of runs) {
      const mark = r.status === 'done' ? 'done       '
        : r.status === 'interrupted' ? 'INTERRUPTED'
        : r.status === 'running' ? 'running    ' : 'FAILED     ';
      console.log(
        `  ${mark} ${r.dump_type.padEnd(9)} line ${commas(Number(r.lines_read)).padStart(12)} · ` +
        `kept ${commas(Number(r.rows_written)).padStart(11)} · skipped ${commas(Number(r.rows_skipped))}`);
    }
    const resumable = runs.find((r) => r.status === 'interrupted' || r.status === 'running');
    if (resumable) {
      console.log(
        `\nRe-run the ${resumable.dump_type} command exactly as before and it resumes ` +
        `from line ${commas(Number(resumable.lines_read))}.`);
    }
  }

  const [counts] = await db.execute<{
    works: number; editions: number; authors: number; links: number; raw: number;
  }>(sql`
    SELECT (SELECT count(*) FROM works)::int        AS works,
           (SELECT count(*) FROM editions)::int     AS editions,
           (SELECT count(*) FROM authors)::int      AS authors,
           (SELECT count(*) FROM work_authors)::int AS links,
           (SELECT count(*) FROM raw_payloads)::int AS raw`);

  console.log(
    `\ncatalog\n` +
    `  works        ${commas(counts!.works)}\n` +
    `  editions     ${commas(counts!.editions)}\n` +
    `  authors      ${commas(counts!.authors)}\n` +
    `  authorship   ${commas(counts!.links)}\n` +
    `  raw payloads ${commas(counts!.raw)}`);
}

/**
 * Post-load pass (FN-26).
 *
 * Indexes are built after the bulk load, not during: maintaining a GIN index
 * across millions of inserts is several times slower than building it once at
 * the end. Here that means ANALYZE and a cover backfill rather than a rebuild,
 * because the indexes are created by migration -- if you are loading the full
 * dump rather than a seed slice, dropping works_search_idx and
 * works_title_trgm_idx first and recreating them here is worth the trouble.
 */
async function finalise(db: ReturnType<typeof makeDb>) {
  console.log('resolving parked authorship links…');
  const [pendingBefore] = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM pending_work_authors`);
  await db.execute(sql.raw(RESOLVE_PENDING_WORK_AUTHORS));
  const [pendingAfter] = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM pending_work_authors`);
  console.log(
    `  ${commas(pendingBefore!.n - pendingAfter!.n)} resolved, ` +
    `${commas(pendingAfter!.n)} still waiting on an author`);

  console.log('backfilling work covers from editions…');
  // A work with no cover of its own borrows its newest edition's.
  const covers = await db.execute(sql`
    UPDATE works w
    SET ol_cover_id = e.ol_cover_id
    FROM (
      SELECT DISTINCT ON (work_id) work_id, ol_cover_id
      FROM editions
      WHERE ol_cover_id IS NOT NULL
      ORDER BY work_id, publish_year DESC NULLS LAST
    ) e
    WHERE e.work_id = w.id AND w.ol_cover_id IS NULL`);
  console.log(`  ${commas((covers as unknown as { count?: number }).count ?? 0)} works given a cover`);

  console.log('setting default editions…');
  await db.execute(sql`
    UPDATE works w
    SET default_edition_id = e.id
    FROM (
      SELECT DISTINCT ON (work_id) work_id, id
      FROM editions
      -- Prefer an edition that actually knows how long the book is.
      ORDER BY work_id, (page_count IS NOT NULL) DESC, publish_year DESC NULLS LAST
    ) e
    WHERE e.work_id = w.id AND w.default_edition_id IS NULL`);

  // Recovery path: if a popularity run was killed between dropping the GIN
  // indexes and rebuilding them, this puts them back. IF NOT EXISTS, so it is
  // free when they are already there.
  console.log('ensuring indexes…');
  for (const [name, ddl] of WORKS_INDEXES) {
    const t0 = Date.now();
    await db.execute(sql.raw(ddl));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (secs > 1) console.log(`  rebuilt ${name} (${secs}s)`);
  }

  console.log('ANALYZE…');
  for (const t of ['works', 'editions', 'authors', 'work_authors']) {
    await db.execute(sql.raw(`ANALYZE ${t}`));
  }

  const [counts] = await db.execute<{
    works: number; editions: number; authors: number; covered: number;
  }>(sql`
    SELECT (SELECT count(*) FROM works)::int    AS works,
           (SELECT count(*) FROM editions)::int AS editions,
           (SELECT count(*) FROM authors)::int  AS authors,
           (SELECT count(*) FROM works WHERE ol_cover_id IS NOT NULL)::int AS covered`);

  console.log(
    `\ncatalog\n` +
    `  works     ${commas(counts!.works)}\n` +
    `  editions  ${commas(counts!.editions)}\n` +
    `  authors   ${commas(counts!.authors)}\n` +
    `  covers    ${commas(counts!.covered)} (${pct(counts!.covered, counts!.works)} of works)`);
}

function usage() {
  return `
Open Library ingest

  npm run ingest -- --type <authors|works|editions> --file <dump.txt.gz> [options]
  npm run ingest -- --finalise

Order matters: authors, then works, then editions.

Options
  --seed <files...>  keep only works present in the reading-log/ratings dumps
  --limit <n>        stop after n rows (for a trial run)
  --no-raw / --raw   override raw-payload retention
                     (default: off for authors, on for works and editions)
  --restart          ignore the checkpoint and start over
  --status           show every run, where it stopped, and the catalog size
  --only-referenced  (authors) skip authors no work credits — ~1M not 15.4M
  --popularity       fill works.log_count from --seed dumps (ranking depends on it)

Downloads
${Object.entries(DUMP_URLS).map(([k, v]) => `  ${k.padEnd(12)} ${v}`).join('\n')}
`.trim();
}

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  /**
   * Make the exit say how it happened.
   *
   * This run has now ended three times with no output whatsoever: no error,
   * no summary, just the shell prompt back. `main().catch()` cannot report
   * that. It never runs if the process is terminated from outside, and it
   * never runs if the event loop simply drains while a promise is still
   * pending -- which Node treats as success and exits silently.
   *
   * The three handlers below are a discriminator. Exactly one pattern shows:
   *
   *   "event loop drained" then "exit"  -- something awaited never settled.
   *                                        The last line printed says where.
   *   "exit N" alone                    -- an orderly exit; N says why.
   *   nothing at all                    -- killed from outside the process
   *                                        (a console Ctrl+C, taskkill, the
   *                                        OOM killer). Node ran no code.
   *
   * Guessing between those three cost two rounds already.
   */
  process.on('uncaughtException', (err) => {
    console.error('\nUNCAUGHT EXCEPTION\n', err);
    process.exit(70);
  });
  process.on('unhandledRejection', (err) => {
    console.error('\nUNHANDLED REJECTION\n', err);
    process.exit(71);
  });
  // `beforeExit` also fires on a clean finish, so it only means something
  // once we know main() did not return.
  let finished = false;
  process.on('beforeExit', () => {
    if (finished) return;
    console.error(
      `\n  event loop drained with work outstanding — never settled while: ${stage}\n` +
      `  active handles: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  });
  process.on('exit', (code) => {
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    const m = process.memoryUsage();
    console.error(`  exit ${code} · heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB · rss ${mb(m.rss)} MB`);
  });

  main()
    .then(() => { finished = true; })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { main, finalise, printStatus };
