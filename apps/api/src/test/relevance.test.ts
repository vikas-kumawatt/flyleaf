// The relevance panel (FN-43).
//
// WHY THE CORPUS IS REAL. A hand-written fixture cannot express the failures
// that actually happened here. "Piranesi the novel must outrank a 1910
// monograph on the architect" needs both records and their real popularity;
// "murakami must find Norwegian Wood" needs an author record named 村上春樹
// with Latin aliases. So the corpus is the 900 most-logged works of the real
// catalog, exported as ingested — titles, alternate titles, authors,
// alternate names and log counts — and committed.
//
// WHAT IT GUARDS. Search ranking has been changed four times for performance
// (see tasks.md FN-41) and each change silently moved results around. Two of
// those regressions — the dropped author-scoring term and the unordered
// `by_author` LIMIT — produced no error, no failing test, and a worse answer.
// This is the net under that.
//
// HOW IT JUDGES. Two different standards, on purpose:
//
//   Hard cases      asserted individually and must pass. These are the ones
//                   recorded in tasks.md because they were found broken.
//   The bulk panel  ~200 queries derived from the corpus, judged as a pass
//                   RATE against a floor. Some will always fail — the corpus
//                   contains genuinely ambiguous titles — and pinning every
//                   one would make the suite a nuisance rather than a signal.
//                   The floor is set just under what it measures today, so a
//                   real regression trips it and noise does not.
//
// Failures print the query, what was expected and what came back, because a
// bare "expected 0.94 to be at least 0.95" is useless.

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { SEARCH_SQL, buildSearchParams } from '../catalog/index.js';
import { freshDb } from './pg.js';

type CorpusAuthor = { name: string; alternate_names: string[] | null };
type CorpusWork = {
  ol_work_key: string;
  title: string;
  subtitle: string | null;
  alternate_titles: string[] | null;
  first_publish_year: number | null;
  ol_cover_id: number | null;
  log_count: number;
  authors: CorpusAuthor[] | null;
};

const CORPUS_PATH = fileURLToPath(new URL('./fixtures/relevance-corpus.json', import.meta.url));

/** BOM-tolerant: the export can be written by a shell that adds one. */
function loadCorpus(): CorpusWork[] {
  const raw = fs.readFileSync(CORPUS_PATH, 'utf8').replace(/^﻿/, '').trim();
  const rows = JSON.parse(raw) as CorpusWork[];
  return rows
    .filter((w) => w.title && (w.authors?.length ?? 0) > 0)
    .sort((a, b) => b.log_count - a.log_count);
}

const corpus = loadCorpus();
/** work key -> row, for reporting a failure in words rather than in uuids. */
const byKey = new Map(corpus.map((w) => [w.ol_work_key, w]));

let db: PGlite;
/** ol_work_key -> the uuid it was given on insert. */
const ids = new Map<string, string>();

beforeAll(async () => {
  db = await freshDb();

  // Multi-row inserts in chunks, not one statement per row. A few thousand
  // works plus their authors and links is ~6,000 round trips done naively,
  // which dominated this suite's runtime; batching makes it a dozen.
  const chunks = <T,>(xs: T[], n: number) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

  const names = [...new Set(corpus.flatMap((w) => (w.authors ?? []).map((a) => a.name)))];
  const aliasOf = new Map(
    corpus.flatMap((w) => (w.authors ?? []).map((a) => [a.name, a.alternate_names ?? []] as const)),
  );

  const authorIds = new Map<string, string>();
  for (const batch of chunks(names, 400)) {
    const values = batch.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
    const { rows } = await db.query<{ id: string; name: string }>(
      `INSERT INTO authors (name, alternate_names) VALUES ${values} RETURNING id, name`,
      batch.flatMap((n) => [n, aliasOf.get(n) ?? []]),
    );
    for (const r of rows) authorIds.set(r.name, r.id);
  }

  for (const batch of chunks(corpus, 300)) {
    const cols = 7;
    const values = batch
      .map((_, i) => `(${Array.from({ length: cols }, (_, c) => `$${i * cols + c + 1}`).join(',')})`)
      .join(',');
    const { rows } = await db.query<{ id: string; ol_work_key: string }>(
      `INSERT INTO works (ol_work_key, title, subtitle, alternate_titles,
                          first_publish_year, ol_cover_id, log_count)
       VALUES ${values} RETURNING id, ol_work_key`,
      batch.flatMap((w) => [w.ol_work_key, w.title, w.subtitle, w.alternate_titles ?? [],
                            w.first_publish_year, w.ol_cover_id, w.log_count]),
    );
    for (const r of rows) ids.set(r.ol_work_key, r.id);
  }

  const links = corpus.flatMap((w) =>
    (w.authors ?? []).map((a, position) => ({
      workId: ids.get(w.ol_work_key)!, authorId: authorIds.get(a.name)!, position,
    })).filter((l) => l.workId && l.authorId));

  for (const batch of chunks(links, 400)) {
    const values = batch
      .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, 'author', $${i * 3 + 3})`)
      .join(',');
    await db.query(
      `INSERT INTO work_authors (work_id, author_id, role, position)
       VALUES ${values} ON CONFLICT DO NOTHING`,
      batch.flatMap((l) => [l.workId, l.authorId, l.position]),
    );
  }

  // The planner will otherwise treat this as an empty table and choose plans
  // that never exercise the indexes the query was written for.
  await db.exec('ANALYZE works; ANALYZE authors; ANALYZE work_authors;');
}, 180_000);

afterAll(async () => { await db?.close(); });

async function search(q: string, limit = 10) {
  const p = buildSearchParams(q);
  const { rows } = await db.query<{ id: string; title: string; author_name: string }>(
    SEARCH_SQL, [p.raw, p.tsquery, p.like, p.prefix, limit],
  );
  return rows;
}

/** The most-logged work whose title matches exactly — what an exact-title query means. */
function bestByTitle(title: string): CorpusWork | undefined {
  const wanted = title.trim().toLowerCase();
  return corpus.find((w) => w.title.trim().toLowerCase() === wanted);
}

type Case = { q: string; expect: string; within: number; kind: string };

/**
 * Queries derived from the corpus, so expectations come from the data rather
 * than from my memory of which books are popular.
 *
 * Deterministic — no sampling. A failure has to be reproducible or nobody
 * will chase it.
 */
function buildPanel(): Case[] {
  const cases: Case[] = [];
  const seen = new Set<string>();
  const add = (q: string, key: string, within: number, kind: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 3 || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    cases.push({ q: trimmed, expect: key, within, kind });
  };

  // The `within` values measure POSITION, not membership.
  //
  // At top-10 this panel scored 217/217, which sounds good and proves almost
  // nothing: both ranking regressions this project actually shipped — the
  // dropped author-scoring term and the unordered `by_author` LIMIT — left
  // the right answer somewhere in the first ten and merely put the wrong one
  // above it. A membership check passes through both. So an exact title must
  // come FIRST, and everything else must make the top five.

  // 1. Exact titles. The most-logged work with that title must rank #1 —
  //    including "piranesi", where nine architecture monographs compete.
  for (const w of corpus.slice(0, 90)) {
    const best = bestByTitle(w.title);
    if (best) add(w.title.toLowerCase(), best.ol_work_key, 1, 'exact title');
  }

  // 2. Prefixes. Every keystroke but the last is a prefix — the regression
  //    that shipped in Phase 0 was exactly this.
  for (const w of corpus.slice(0, 80)) {
    if (w.title.length < 9) continue;
    const best = bestByTitle(w.title);
    if (best) add(w.title.slice(0, 6).toLowerCase(), best.ol_work_key, 5, 'prefix');
  }

  // 3. Author names. The author's most-logged work must surface.
  const byAuthor = new Map<string, CorpusWork>();
  for (const w of corpus) {
    const name = w.authors?.[0]?.name;
    if (name && !byAuthor.has(name)) byAuthor.set(name, w);
  }
  for (const [name, w] of [...byAuthor].slice(0, 40)) {
    const surname = name.trim().split(/\s+/).at(-1) ?? '';
    if (surname.length >= 4) add(surname.toLowerCase(), w.ol_work_key, 5, 'author');
  }

  // 4. Typos. Drop one character from the middle of the title.
  for (const w of corpus.slice(0, 30)) {
    if (w.title.length < 10) continue;
    const best = bestByTitle(w.title);
    const cut = Math.floor(w.title.length / 2);
    if (best) {
      add((w.title.slice(0, cut) + w.title.slice(cut + 1)).toLowerCase(),
          best.ol_work_key, 5, 'typo');
    }
  }

  return cases;
}

describe('the hard cases', () => {
  // Every one of these was found BROKEN against the real catalog and is
  // recorded in tasks.md. They are asserted individually, not averaged.

  it('murakami finds Haruki Murakami, whose author record is 村上春樹', async () => {
    const rows = await search('murakami', 20);
    const titles = rows.map((r) => r.title);
    // Norwegian Wood is the most-logged Murakami work in the catalog.
    expect(titles.some((t) => /norwegian wood|海辺のカフカ|1Q84/i.test(t))).toBe(true);
  });

  it.each([
    ['piranese', /piranesi/i],
    ['the hobit', /hobbit/i],
  ])('absorbs the typo %j', async (q, pattern) => {
    const rows = await search(q, 10);
    expect(rows.some((r) => pattern.test(r.title))).toBe(true);
  });

  it('piranesi ranks the novel above the architecture monographs', async () => {
    // The corpus holds Susanna Clarke's Piranesi (561 logs) and nine works
    // about Giovanni Battista Piranesi (1-5 logs each). Popularity is the
    // whole tiebreaker here; before FN-41 loaded log_count, a 1910 monograph
    // won this.
    const [top] = await search('piranesi', 10);
    expect(top?.author_name).toBe('Susanna Clarke');
  });

  it('guin matches a LATER part of the author name', async () => {
    const rows = await search('guin', 20);
    expect(rows.some((r) => /le guin/i.test(r.author_name))).toBe(true);
  });

  it.each([
    ['pir', /piranesi/i],
    ['hobb', /hobbit/i],
    ['orwel', /orwell/i],
  ])('a prefix still finds it: %j', async (q, pattern) => {
    const rows = await search(q, 20);
    expect(rows.some((r) => pattern.test(r.title) || pattern.test(r.author_name))).toBe(true);
  });

  /**
   * The `1984` gap, and why ingesting harder will not close it.
   *
   * FN-21 reads `alternate_titles`, `other_titles` and `alternative_title`
   * from each work record. MEASURED against the dump: across 1,053,422
   * sampled work records, all three fields appear **zero** times, while
   * `subtitle` appears 15,434 times in the same sample. Open Library's WORK
   * records simply do not carry alternate titles.
   *
   * So `works.alternate_titles` is always empty, the weight-C term in the
   * search vector contributes nothing today, and no amount of re-running the
   * works pass will make "1984" find Nineteen Eighty-Four. The only place
   * that string exists in Open Library is on EDITION records — the 9.2 GB
   * pass nobody has run. See tasks.md FN-43.
   *
   * Asserted as still-broken, in this project's usual style: the day it
   * starts working, this test fails and somebody deletes it deliberately.
   */
  it('cannot find "1984" — the work is titled Nineteen Eighty-Four', async () => {
    const rows = await search('1984', 20);
    expect(rows.some((r) => /nineteen eighty/i.test(r.title))).toBe(false);
  });
});

describe('the panel', () => {
  /**
   * The floor: 0.98, against a measured 216/217 (99.5%).
   *
   * Set from the measurement, not from a number that sounded respectable.
   * The corpus is committed and the queries are generated deterministically,
   * so there is no run-to-run noise to absorb — identical results on Windows
   * and Linux. The gap to 0.98 exists only to tolerate tie-break differences
   * between engines, and it means any regression costing five queries or more
   * turns this red.
   *
   * Raise it if the rate rises. Never lower it to make a red build green:
   * that is the single change that turns this file into decoration.
   *
   * THE ONE MISS IS REAL, AND IS NOT FIXED HERE. `king` returns King of
   * Wrath / Pride / Greed ahead of Stephen King's It (12,372 logs), because a
   * title beginning with the query scores 0.30 while an author match scores
   * 0.20, and the popularity term does not close the gap. Whether an author
   * surname should outrank a title prefix is a product decision, and tuning
   * the weights to fix one query is exactly the overfitting this panel exists
   * to prevent. Recorded in tasks.md FN-43; the panel is the instrument for
   * deciding it, not a reason to change ranking as a side effect of writing a
   * test.
   */
  const FLOOR = 0.98;

  it('holds its pass rate across ~200 queries', async () => {
    const panel = buildPanel();
    expect(panel.length).toBeGreaterThanOrEqual(150);

    const failures: string[] = [];
    const byKind = new Map<string, { pass: number; total: number }>();

    for (const c of panel) {
      const rows = await search(c.q, c.within);
      const hit = rows.some((r) => r.id === ids.get(c.expect));

      const tally = byKind.get(c.kind) ?? { pass: 0, total: 0 };
      tally.total++;
      if (hit) tally.pass++;
      byKind.set(c.kind, tally);

      if (!hit) {
        const want = byKey.get(c.expect);
        failures.push(
          `  ${c.kind.padEnd(11)} ${JSON.stringify(c.q).padEnd(34)} ` +
          `want ${JSON.stringify(want?.title ?? c.expect)} (${want?.log_count} logs) ` +
          `got [${rows.slice(0, 3).map((r) => r.title).join(' | ')}]`,
        );
      }
    }

    const passed = panel.length - failures.length;
    const rate = passed / panel.length;

    console.log(`\nrelevance panel — ${passed}/${panel.length} (${(rate * 100).toFixed(1)}%)`);
    for (const [kind, t] of byKind) {
      console.log(`  ${kind.padEnd(11)} ${t.pass}/${t.total} (${((t.pass / t.total) * 100).toFixed(0)}%)`);
    }
    if (failures.length) console.log('\nmisses:\n' + failures.join('\n'));

    expect(rate).toBeGreaterThanOrEqual(FLOOR);
  }, 300_000);
});
