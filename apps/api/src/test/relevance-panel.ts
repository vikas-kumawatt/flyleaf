// The FN-43 relevance corpus and panel, shared by relevance.test.ts (PGlite)
// and bench/relevance-panel.ts (a real database), so both judge the SAME
// queries with the same expectations. Moved here unchanged in audit 08.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

type CorpusAuthor = { name: string; alternate_names: string[] | null };
export type CorpusWork = {
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
export function loadCorpus(): CorpusWork[] {
  const raw = fs.readFileSync(CORPUS_PATH, 'utf8').replace(/^﻿/, '').trim();
  const rows = JSON.parse(raw) as CorpusWork[];
  return rows
    .filter((w) => w.title && (w.authors?.length ?? 0) > 0)
    .sort((a, b) => b.log_count - a.log_count);
}

/** The most-logged work whose title matches exactly — what an exact-title query means. */
function bestByTitle(corpus: CorpusWork[], title: string): CorpusWork | undefined {
  const wanted = title.trim().toLowerCase();
  return corpus.find((w) => w.title.trim().toLowerCase() === wanted);
}

export type Case = { q: string; expect: string; within: number; kind: string };

/**
 * Queries derived from the corpus, so expectations come from the data rather
 * than from my memory of which books are popular.
 *
 * Deterministic — no sampling. A failure has to be reproducible or nobody
 * will chase it.
 */
export function buildPanel(corpus: CorpusWork[]): Case[] {
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
    const best = bestByTitle(corpus, w.title);
    if (best) add(w.title.toLowerCase(), best.ol_work_key, 1, 'exact title');
  }

  // 2. Prefixes. Every keystroke but the last is a prefix — the regression
  //    that shipped in Phase 0 was exactly this.
  for (const w of corpus.slice(0, 80)) {
    if (w.title.length < 9) continue;
    const best = bestByTitle(corpus, w.title);
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
    const best = bestByTitle(corpus, w.title);
    const cut = Math.floor(w.title.length / 2);
    if (best) {
      add((w.title.slice(0, cut) + w.title.slice(cut + 1)).toLowerCase(),
          best.ol_work_key, 5, 'typo');
    }
  }

  return cases;
}
