// Reading Open Library dumps (FN-20).
//
// The dumps are gzipped TSV, five columns:
//
//   type \t key \t revision \t last_modified \t JSON
//
// Sizes as of 2026: authors 0.5 GB, works 2.9 GB, editions 9.2 GB compressed.
// The editions dump is roughly 45 GB uncompressed, so nothing here may hold
// more than one line at a time.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

export type DumpType = 'authors' | 'works' | 'editions';

/** Compressed bytes consumed, for progress reporting. */
export type DumpProgress = { bytesRead: number; totalBytes: number };

export type DumpRecord = {
  /** OL key, e.g. "/works/OL45804W". */
  key: string;
  /** The parsed JSON record. */
  json: Record<string, unknown>;
  /** Line number, 1-based. The resume checkpoint. */
  line: number;
};

export const DUMP_URLS: Record<DumpType | 'reading-log' | 'ratings', string> = {
  authors: 'https://openlibrary.org/data/ol_dump_authors_latest.txt.gz',
  works: 'https://openlibrary.org/data/ol_dump_works_latest.txt.gz',
  editions: 'https://openlibrary.org/data/ol_dump_editions_latest.txt.gz',
  // 65 MB and 5 MB. Keyed by work, so they give a real popularity signal for
  // the seed slice without touching the 9 GB editions dump.
  'reading-log': 'https://openlibrary.org/data/ol_dump_reading-log_latest.txt.gz',
  ratings: 'https://openlibrary.org/data/ol_dump_ratings_latest.txt.gz',
};

/**
 * Stream a dump line by line.
 *
 * `skipLines` resumes an interrupted run. It re-decompresses from the start
 * -- unavoidable with gzip -- but skips without parsing, which is roughly an
 * order of magnitude cheaper than the work it is skipping.
 *
 * Malformed lines are counted and skipped rather than thrown. A single bad
 * record in forty million must not end the run.
 */
export async function* readDump(
  filePath: string,
  opts: {
    skipLines?: number;
    onMalformed?: (line: number, err: unknown) => void;
    /**
     * Decide from the KEY ALONE, before the JSON is parsed.
     *
     * This is the whole cost of a seeded works pass. The dump is tens of
     * millions of records and `--seed` discards most of them, but the key is
     * column two and the payload is column five -- so without this every
     * discarded record still pays for a `JSON.parse` of a couple of kilobytes
     * to produce an object nothing reads.
     */
    accept?: (key: string) => boolean;
    /**
     * Mutable counter the caller can read for progress.
     *
     * COMPRESSED bytes, because that is the only quantity whose total is
     * known up front. Line counts are not: finding out how many lines a
     * gzipped dump holds means decompressing all of it, which is the job
     * itself. Percentage-of-bytes is honest from the first second.
     */
    progress?: DumpProgress;
  } = {},
): AsyncGenerator<DumpRecord> {
  const skip = opts.skipLines ?? 0;

  const file = fs.createReadStream(filePath);

  if (opts.progress) {
    const p = opts.progress;
    p.totalBytes = fs.statSync(filePath).size;
    file.on('data', (chunk) => { p.bytesRead += chunk.length; });
  }

  const stream = file
    // 45 GB of gzip: a bigger window costs a little memory and saves a lot of
    // syscalls.
    .pipe(zlib.createGunzip({ chunkSize: 1 << 20 }));

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let line = 0;
  for await (const text of rl) {
    line++;
    if (line <= skip) continue;
    if (!text) continue;

    // Split only as far as needed: the JSON column contains tabs of its own
    // inside string values, so a naive split('\t') would corrupt it.
    const first = text.indexOf('\t');
    const second = text.indexOf('\t', first + 1);
    const third = text.indexOf('\t', second + 1);
    const fourth = text.indexOf('\t', third + 1);
    if (fourth === -1) continue;

    const key = text.slice(first + 1, second);
    if (opts.accept && !opts.accept(key)) continue;

    const payload = text.slice(fourth + 1);

    try {
      yield { key, json: JSON.parse(payload) as Record<string, unknown>, line };
    } catch (err) {
      opts.onMalformed?.(line, err);
    }
  }
}

/** Count lines in a gzipped dump. Only used for progress reporting. */
export async function countLines(filePath: string): Promise<number> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath).pipe(zlib.createGunzip({ chunkSize: 1 << 20 })),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const _ of rl) n++;
  return n;
}

/**
 * Work keys worth ingesting, from the reading-log and ratings dumps.
 *
 * This is the accelerator's layer 1. Those two files are 65 MB and 5 MB
 * against the works dump's 2.9 GB, and "somebody put this on a shelf or rated
 * it" is a far better popularity signal than anything derivable from the work
 * record itself.
 *
 * Both are plain TSV whose first column is the work key -- not the 5-column
 * record format above.
 */
export async function popularWorkKeys(filePaths: string[]): Promise<Set<string>> {
  const keys = new Set<string>();

  for (const filePath of filePaths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath).pipe(zlib.createGunzip({ chunkSize: 1 << 20 })),
      crlfDelay: Infinity,
    });
    for await (const text of rl) {
      if (!text) continue;
      const tab = text.indexOf('\t');
      const key = (tab === -1 ? text : text.slice(0, tab)).trim();
      if (key.startsWith('/works/')) keys.add(key);
    }
  }

  return keys;
}

/**
 * How many times each work appears across the reading-log and ratings dumps.
 *
 * This is the popularity signal, and it costs one pass over 74 MB of files we
 * already have. Without it `works.log_count` is 0 for all 3.2 million works,
 * the `ln(1 + log_count)` term in the ranking contributes exactly nothing,
 * and a search for "piranesi" ranks a 1910 monograph on the architect above
 * the novel almost everybody means.
 *
 * A shelving and a rating both count as one. They measure slightly different
 * things -- intent to read versus having finished -- but at this stage the
 * distinction is not worth two columns.
 */
export async function workPopularity(
  filePaths: string[],
  progress?: DumpProgress,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (progress) {
    progress.totalBytes = filePaths.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  }

  for (const filePath of filePaths) {
    const file = fs.createReadStream(filePath);
    if (progress) {
      const p = progress;
      file.on('data', (chunk) => { p.bytesRead += chunk.length; });
    }

    const rl = readline.createInterface({
      input: file.pipe(zlib.createGunzip({ chunkSize: 1 << 20 })),
      crlfDelay: Infinity,
    });
    for await (const text of rl) {
      if (!text) continue;
      const tab = text.indexOf('\t');
      const key = (tab === -1 ? text : text.slice(0, tab)).trim();
      if (key.startsWith('/works/')) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}
