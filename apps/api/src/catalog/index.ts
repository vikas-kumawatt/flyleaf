// Works and editions.
//
// Phase -1: 102 books from a CSV, searched with trigram similarity. No Open
// Library ingest, no gap-fill, no rate limiter on outbound calls — FN-2x/3x.
//
// What this phase is testing: whether the work/edition split is workable in a
// real UI, or whether it forces an edition picker into every flow.

import { sql, eq, desc, asc } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { Cache, Db } from '../platform/index.js';
import type { GapFillService } from './gapfill.js';
import { editions, reads, progressEvents } from '../db/schema.js';
import { ApiError } from '../http.js';
import { detectIsbn, type DetectedIsbn } from './isbn.js';
import { resolveWorkId } from './resolve.js';

export type Edition = {
  id: string;
  isbn13: string | null;
  page_count: number | null;
  format: string;
  cover_id: number | null;
  /** GET /works/:id only: the edition picker names each copy (SL-42). */
  publisher?: string | null;
  publish_year?: number | null;
};

export type EditionDetail = {
  id: string;
  work_id: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string | null;
  publisher: string | null;
  publish_year: number | null;
  page_count: number | null;
  format: string;
  cover_id: number | null;
};

export type Maturity = 'general' | 'mature' | 'explicit' | 'unclassified';

export type EditionLookupResult = {
  work: Work;
  edition: EditionDetail;
  maturity: Maturity;
  content_warning: boolean;
};

export type YourRead = {
  id: string;
  status: string;
  rating: number | null;
  hearted: boolean;
  page: number | null;
  percent: number | null;
  review_id?: string | null;
};

export type Work = {
  id: string;
  title: string;
  author_name: string;
  first_publish_year: number | null;
  cover_id: number | null;
  log_count: number;
  avg_rating?: number | null;
  weighted_rating?: number | null;
  rating_count?: number;
  heart_count?: number;
  editions?: Edition[];
  your_read?: YourRead;
  /** Set when the requested id was merged into this work (D3): the body is the survivor's. */
  merged_into?: string;
  /** GET /works/:id only (PRD §7.8, A-02-019). */
  maturity?: Maturity;
  /** GET /works/:id only: explicit, and search would hide it from this viewer. The client shows its interstitial. */
  content_warning?: boolean;
  /** GET /works/:id only (audit 08, SL-41 / SL-43). */
  description?: string | null;
  authors?: { id: string; name: string }[];
  series?: { id: string; name: string; position: number | null }[];
  /** Readers per half-star rating, "0.5" to "5.0", each reader once at their latest rated attempt (PRD §9.6, audit 09b). */
  rating_distribution?: Record<RatingBucket, number>;
};

/** The ten half-star values a rating can take, as the histogram's keys (numeric(2,1) as text). */
export const RATING_BUCKETS = ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0'] as const;
export type RatingBucket = (typeof RATING_BUCKETS)[number];

/** An author's page (SL-43): their works by popularity, through work_authors. */
export type AuthorDetail = {
  id: string;
  name: string;
  alternate_names: string[];
  bio: string | null;
  works_count: number;
  /** The viewer's finished attempts among these works; 0 for a guest. */
  read_count: number;
  works: Work[];
};

/** A series page (SL-43) with the viewer's status on each entry. */
export type SeriesDetail = {
  id: string;
  name: string;
  entries: { work_id: string; position: number | null; title: string; author_name: string; cover_id: number | null; your_status: string | null }[];
  /** Entries the viewer has finished; 0 for a guest. */
  read_books: number;
};

/**
 * Search parameters, built in TypeScript rather than in SQL.
 *
 * This is not cosmetic. The previous version computed the tsquery and the
 * LIKE pattern inside a CTE and cross-joined it to `works`:
 *
 *     FROM works w, p WHERE ... w.title ILIKE p.esc ...
 *
 * Postgres cannot use an index when the comparison value is a column from
 * another relation it has to evaluate per row. So it sequential-scanned all
 * 3.2 million works and ran the author EXISTS subquery once per row.
 * Measured on a real catalog: **32 to 40 seconds per search.**
 *
 * Bound parameters are constants at plan time, and every arm below becomes
 * an index scan.
 */
export function buildSearchParams(q: string) {
  const raw = cleanQuery(q);

  // Accents are NOT folded here. SEARCH_SQL passes the tsquery through
  // `flyleaf_unaccent`, the function the vector was built with, so both
  // sides fold identically. Folding in JS disagreed with it: NFD-stripping
  // turned 'толстой' into 'толстои', which unaccent keeps as 'толстой'.
  // NFC so a decomposed "Café" is one word, like the stored title.
  const words = raw
    .toLowerCase()
    .normalize('NFC')
    // to_tsquery is a PARSER: an apostrophe or a colon in raw input is a
    // syntax error, not a character to match on. Splitting (not deleting)
    // mirrors the tsvector parser, which stores "O'Brien" as 'o' + 'brien'.
    // Letters of every script survive: 'simple' indexes Cyrillic and CJK.
    // Marks stay inside the word (Devanagari vowel signs are marks).
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);

  // A one-letter prefix ('p:*') expands to every lexeme starting with that
  // letter and costs seconds on the full catalog. Mid-typing ("harry potter
  // and the p") the other terms already carry the query.
  const tokens = words.some((t) => t.length > 1) ? words.filter((t) => t.length > 1) : words;

  // LIKE metacharacters. Without escaping, a query of "%" matches everything.
  const esc = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  return {
    raw,
    tsquery: tokens.length ? tokens.map((t) => `${t}:*`).join(' & ') : null,
    // A two-character '%q%' contains no complete trigram, so no index can
    // serve it: on the full catalog title ILIKE '%村上%' seq-scanned works
    // (25 s). Anchored, the pattern has trigrams again. Titles only: the
    // author arm keeps the substring (see by_author in SEARCH_SQL).
    like: Array.from(raw).length < 3 ? `${esc}%` : `%${esc}%`,
    prefix: `${esc}%`,
    // Author names: a substring from 3 characters. Below that '%q%' has no
    // trigram (a seq scan of authors for 村上), so two characters match the
    // start of a name or of any later word in it ("Ur" -> Ursula K. Le Guin,
    // "le" -> Le Guin). Decided in audit 02b (A-02-012).
    authorLike: Array.from(raw).length < 3 ? [`${esc}%`, `% ${esc}%`] : [`%${esc}%`],
  };
}

/**
 * Longer input is cut rather than rejected: search runs on every keystroke,
 * and every word adds a prefix term and trigrams. Measured on the full
 * catalog, a 200-character query spent 12 s in the prefix arm and 12 s in
 * the trigram arm. No title a person types is longer than this.
 */
export const MAX_QUERY_CHARS = 100;

/** NUL cannot reach Postgres in a text parameter (22021 -> a 500). */
function cleanQuery(q: string): string {
  return Array.from(q.replace(/\u0000/g, '').trim()).slice(0, MAX_QUERY_CHARS).join('').trim();
}

/** SEARCH_SQL's parameters, in order. The one place that knows the order. */
export function searchArgs(q: string, limit: number, allowExplicit: boolean) {
  const p = buildSearchParams(q);
  return [p.raw, p.tsquery, p.like, p.prefix, limit, allowExplicit, p.authorLike];
}

/**
 * Search. Exported as a string so `search.test.ts` runs THIS query rather
 * than a copy of it.
 *
 *   $1 raw text   $2 tsquery (or NULL)   $3 '%like%'   $4 'prefix%'   $5 limit
 *   $6 allow explicit works (PRD §7.8)   $7 author name patterns (text[])
 *   -- build these with searchArgs()
 *
 * Every arm repeats the exclusions (merged, provisional, explicit). The
 * final select alone is too late: an arm's LIMIT has already been spent on
 * rows that are then thrown away, and enough of them push a live work out of
 * every arm.
 *
 * Shape: gather a small candidate set from several INDEPENDENT indexed arms,
 * union them, then rank only those. Each arm fails at something the others
 * cover:
 *
 *   - PREFIX full-text (`token:*`) — the one that matters for search as you
 *     type. `plainto_tsquery('harr')` seeks the exact lexeme 'harr' and never
 *     matches 'harry', so without it every keystroke returns nothing until
 *     the word is finished.
 *   - ILIKE substring — matches inside a word ("otter"), which a prefix
 *     query cannot. Uses the trigram GIN index.
 *   - Author name — a separate arm because authorship is a join table.
 *   - Typos, in titles ("piranese", "the hobit") and author names
 *     ("ishigoro", AC-7) — only when the three EXACT arms above cannot fill
 *     the page. Their candidates carry no prefix or exact-title score, so on
 *     a query the exact arms answer they rank below it anyway, and a common
 *     word ("harry") is exactly where word similarity is most expensive.
 *
 * The per-arm LIMITs are what keep this bounded: a common word can match
 * hundreds of thousands of rows, and ranking those would be the seq scan
 * again by another name. Each arm takes its most-logged rows and stops.
 */
export const SEARCH_SQL = `
  WITH fts AS (
    SELECT id FROM works
    WHERE $2::text IS NOT NULL
      -- Unaccented like the vector was, so "łódź" and "straße" match.
      AND search_vector @@ to_tsquery('simple', flyleaf_unaccent($2::text))
      AND merged_into_id IS NULL AND NOT is_provisional
      AND (maturity <> 'explicit' OR $6::boolean)
    ORDER BY log_count DESC
    LIMIT 300
  ),
  title_like AS (
    SELECT id FROM works
    WHERE title ILIKE $3::text
      AND merged_into_id IS NULL AND NOT is_provisional
      AND (maturity <> 'explicit' OR $6::boolean)
    ORDER BY log_count DESC
    LIMIT 300
  ),
  by_author AS (
    -- ORDER BY log_count, like every other arm. Without it this took an
    -- ARBITRARY 300 works by authors matching the pattern -- and there are
    -- many Murakamis with many books, so Haruki's novels simply were not in
    -- the 300 that came back. An unordered LIMIT is a silent quality bug:
    -- the query looks right and quietly discards the best results.
    SELECT w.id
    FROM authors a
    JOIN work_authors wa ON wa.author_id = a.id
    JOIN works w ON w.id = wa.work_id
    -- Name PLUS aliases. Open Library files Haruki Murakami's novels under
    -- an author record named 村上春樹, so matching a.name alone can never
    -- reach them. Must be the same call as the index expression in
    -- authors_credited_trgm_idx, or Postgres will not use it.
    --
    -- has_works: only the 1.66M of 15.4M authors credited on a work (0019).
    -- Matching all of them made this arm's cost grow with the authors table
    -- ("pir": 16,771 authors probed, 9 s). $7 is '%q%', or for two
    -- characters 'q%' + '% q%' (a name or a word in it starts with q):
    -- '%q%' has no trigram at two characters and seq-scanned authors.
    WHERE a.has_works
      AND flyleaf_author_names(a.name, a.alternate_names) ILIKE ANY ($7::text[])
      AND w.merged_into_id IS NULL AND NOT w.is_provisional
      AND (w.maturity <> 'explicit' OR $6::boolean)
    ORDER BY w.log_count DESC
    -- 50 at two characters. An anchored pair is sparse, so the planner's
    -- walk of works by popularity runs long before it finds 300 matches
    -- ("th": 14k works walked, 122k buffers); 50 costs 16.7k, below the
    -- pre-audit '%th%'. A two-character page needs no more (audit 02b).
    LIMIT CASE WHEN char_length($1::text) < 3 THEN 50 ELSE 300 END
  ),
  exact AS (
    SELECT id FROM fts
    UNION SELECT id FROM title_like
    UNION SELECT id FROM by_author
  ),
  -- The typo arms. WORD similarity (%>, threshold 0.6) finds the candidates,
  -- not similarity (%, 0.45): in "the hobit" the word "the" holds 4 of the
  -- 10 trigrams, and at 0.45 any title with "the" and an h-word qualified
  -- (167k index candidates, 1.3M rows rechecked on the full catalog). %> needs
  -- 6 of 10: 46k candidates, 25k rechecked (audit 02b, A-02-016).
  --
  -- Under 4 characters every title sharing a word-initial pair is a
  -- candidate ("th": 1.1M of 3.2M titles), and a typo means nothing that
  -- short; the prefix arm covers it.
  --
  -- ORDER BY log_count + 0 so the popularity index cannot serve the ORDER
  -- BY. Word similarity on a common word is estimated at tens of thousands
  -- of rows, and the planner then walks works by popularity filtering row by
  -- row ("harry": 2.8M rows, 98 s) instead of collecting the candidates from
  -- the trigram index and sorting those.
  title_fuzzy AS (
    SELECT id FROM works
    WHERE char_length($1::text) >= 4
      AND (SELECT count(*) FROM exact) < $5
      AND title %> $1::text
      -- The whole query must still resemble the title at 0.45, the arm's
      -- rule before audit 02b; word similarity is never below similarity,
      -- so this only narrows the old candidates. Not '%': that operator is
      -- indexable, and as an index condition it brings back "the".
      AND similarity(title, $1::text) >= current_setting('pg_trgm.similarity_threshold')::real
      AND merged_into_id IS NULL AND NOT is_provisional
      AND (maturity <> 'explicit' OR $6::boolean)
    ORDER BY log_count + 0 DESC
    LIMIT 150
  ),
  author_fuzzy AS (
    -- AC-7: "ishigoro" finds Kazuo Ishiguro. Credited authors only, through
    -- the same partial index as by_author; unaffordable over all 15.4M.
    SELECT w.id
    FROM authors a
    JOIN work_authors wa ON wa.author_id = a.id
    JOIN works w ON w.id = wa.work_id
    WHERE char_length($1::text) >= 4
      AND (SELECT count(*) FROM exact) < $5
      AND a.has_works
      AND flyleaf_author_names(a.name, a.alternate_names) %> $1::text
      AND w.merged_into_id IS NULL AND NOT w.is_provisional
      AND (w.maturity <> 'explicit' OR $6::boolean)
    ORDER BY w.log_count + 0 DESC
    LIMIT 150
  ),
  candidate AS (
    SELECT id FROM exact
    UNION SELECT id FROM title_fuzzy
    UNION SELECT id FROM author_fuzzy
  )
  SELECT
    w.id, w.title, w.first_publish_year, w.log_count,
    (SELECT a.name
       FROM work_authors wa JOIN authors a ON a.id = wa.author_id
      WHERE wa.work_id = w.id
      ORDER BY wa.position, a.name
      LIMIT 1) AS author_name,
    -- The work's own cover, set at ingest; an edition's only as a fallback.
    COALESCE(w.ol_cover_id, (
      SELECT e.ol_cover_id
        FROM editions e
       WHERE e.work_id = w.id AND e.ol_cover_id IS NOT NULL
       ORDER BY e.publish_year DESC NULLS LAST
       LIMIT 1)) AS cover_id
  FROM candidate c
  JOIN works w ON w.id = c.id
  WHERE w.merged_into_id IS NULL      -- a merged work is never a result
    AND w.is_provisional = false      -- user-created, not yet promoted
    AND (w.maturity <> 'explicit' OR $6::boolean)
  ORDER BY
      (CASE WHEN w.title ILIKE $4::text THEN 0.30 ELSE 0 END)
    + (CASE WHEN lower(w.title) = lower($1::text) THEN 0.20 ELSE 0 END)
    -- Matching the AUTHOR is a first-class signal, not just a way of finding
    -- candidates. Without this term "murakami" surfaces books with Murakami
    -- in the TITLE and scores Norwegian Wood at zero, which is the opposite
    -- of what someone typing an author's name wants.
    + (CASE WHEN EXISTS (
        SELECT 1 FROM work_authors wa JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND flyleaf_author_names(a.name, a.alternate_names) ILIKE ANY ($7::text[])
      ) THEN 0.20 ELSE 0 END)
    + similarity(w.title, $1::text) * 0.10
    -- Popularity, from the reading-log and ratings dumps (--popularity).
    -- ln() so 10,000 logs beats 100 without burying everything else; the cap
    -- stops one runaway title dominating every query it happens to match.
    -- This is the term that puts Susanna Clarke's Piranesi above a 1910
    -- monograph on the architect.
    --
    -- 0.60, not 0.35 (audit 02d). At 0.35 the whole range of this term was
    -- smaller than the 0.40 an exact title earns over an author match, so on
    -- the real catalog a 12-log book titled "Orwell" outranked every Orwell
    -- novel: the relevance panel scored 198/214 there, 14 of the misses
    -- author surnames. 0.55 to 1.0 all score 214/214; 0.60 is one step
    -- inside that, and an obscure book searched by its exact title stays
    -- first (147 of 150 multi-word titles at 1.0, 150 at 0.60).
    + LEAST(ln(1 + w.log_count) / 10.0, 1.0) * 0.60 DESC,
    w.log_count DESC,
    w.title
  LIMIT $5
`;

/**
 * One ISBN can sit on editions of two works until dedupe merges them. Search
 * and the scan endpoint must pick the same one, and the same one every time:
 * for a viewer who may not see explicit works, a non-explicit one first (so
 * a shared ISBN opens the allowed work when one carries it), then the
 * more-logged work, the newest edition, and the id as a tiebreak.
 */
const isbnOrder = (allowExplicit: boolean) =>
  sql`(w.maturity = 'explicit' AND NOT ${allowExplicit}::boolean), w.log_count DESC, e.publish_year DESC NULLS LAST, e.id`;

export type SearchRow = {
  id: string;
  title: string;
  author_name: string | null;
  first_publish_year: number | null;
  cover_id: number | null;
  log_count: number;
};

/**
 * Below this many local hits, a search is treated as a catalog gap and Open
 * Library is asked (FN-32). Not zero: three near-misses and the right book
 * absent is still a gap, and that is the case the user actually complains
 * about.
 */
const GAP_FILL_THRESHOLD = 5;

export class CatalogService {
  constructor(
    private db: Db,
    private cache: Cache,
    private gapFill?: GapFillService,
  ) {}

  /**
   * Looks up the work corresponding to an exact ISBN match (FN-42, PRD §14.2).
   * An explicit work the viewer may not see is no match: search then runs as
   * text, filtered like any other query (audit 02b, decision 4).
   */
  async #findWorkByIsbn(isbn: DetectedIsbn, allowExplicit: boolean): Promise<SearchRow | null> {
    const candidates = [isbn.isbn13, isbn.isbn10].filter((v): v is string => Boolean(v));
    if (candidates.length === 0) return null;

    const [row] = await this.db.execute<{
      id: string;
      title: string;
      first_publish_year: number | null;
      log_count: number;
      author_name: string | null;
      cover_id: number | null;
      explicit: boolean;
    }>(sql`
      SELECT
        w.id, w.title, w.first_publish_year, w.log_count,
        (SELECT a.name
           FROM work_authors wa JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = w.id
          ORDER BY wa.position, a.name
          LIMIT 1) AS author_name,
        COALESCE(e.ol_cover_id, w.ol_cover_id) AS cover_id,
        w.maturity = 'explicit' AS explicit
      FROM editions e
      JOIN works w ON w.id = e.work_id
      WHERE (e.isbn_13 IN ${candidates} OR e.isbn_10 IN ${candidates})
        AND w.merged_into_id IS NULL
        AND w.is_provisional = false
      ORDER BY ${isbnOrder(allowExplicit)}
      LIMIT 1
    `);

    if (!row || (row.explicit && !allowExplicit)) return null;

    return {
      id: row.id,
      title: row.title,
      first_publish_year: row.first_publish_year,
      log_count: Number(row.log_count),
      author_name: row.author_name,
      cover_id: row.cover_id,
    };
  }

  /**
   * PRD §7.8 [LOCKED]: explicit works reach search only for an 18+ account
   * that turned the setting on. A guest never qualifies (§4.2). The age is
   * checked here as well as when the setting is changed, so a stale or
   * hand-edited flag cannot expose them to a minor. A date of birth the user
   * never entered (dob_confirmed false, D-07-3) counts as a minor's.
   */
  async #allowsExplicit(viewer: string | null): Promise<boolean> {
    if (!viewer) return false;
    const [row] = await this.db.execute<{ ok: boolean }>(sql`
      SELECT p.show_explicit AND u.dob_confirmed AND u.date_of_birth <= (current_date - interval '18 years')::date AS ok
      FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ${viewer} AND u.deleted_at IS NULL`);
    return row?.ok === true;
  }

  /** See SEARCH_SQL above for how matching and ranking work. */
  async search(viewer: string | null, q: string, limit = 20): Promise<Work[]> {
    const query = cleanQuery(q);
    if (Array.from(query).length < 2) return [];

    const isbn = detectIsbn(query);
    // An exact ISBN typed into search follows the same maturity filter as
    // text (audit 02b; the scan endpoint does not, see getEditionByIsbn), so
    // the lookup waits for it. Guests cost no query here.
    const allowExplicit = await this.#allowsExplicit(viewer);
    let isbnMatch: SearchRow | null = isbn ? await this.#findWorkByIsbn(isbn, allowExplicit) : null;
    const localSearch = (n: number) => this.#localSearch(query, n, allowExplicit);

    let rows: SearchRow[] = [];
    if (isbnMatch) {
      // PRD §1013: ISBN pasted -> exact edition match first.
      const otherRows = await localSearch(limit - 1);
      rows = [isbnMatch, ...otherRows.filter((r) => r.id !== isbnMatch!.id)];
    } else {
      rows = await localSearch(limit);

      // Layer 2 of the catalog accelerator. Bounded by the outbound client's
      // 2.5s timeout and skipped entirely when the circuit is open or the
      // shared rate limiter has no token, so a slow or unwell Open Library
      // costs a few milliseconds rather than the request.
      if (rows.length < GAP_FILL_THRESHOLD && this.gapFill && query.length >= 3) {
        const stored = await this.gapFill.fill(query);
        if (stored > 0) {
          if (isbn) {
            isbnMatch = await this.#findWorkByIsbn(isbn, allowExplicit);
            if (isbnMatch) {
              const otherRows = await localSearch(limit - 1);
              rows = [isbnMatch, ...otherRows.filter((r) => r.id !== isbnMatch!.id)];
            } else {
              rows = await localSearch(limit);
            }
          } else {
            rows = await localSearch(limit);
          }
        }
      }
    }

    const yours = await this.#yourReads(viewer, rows.map((r) => r.id));
    return rows.map((r) => {
      const work: Work = {
        id: r.id,
        title: r.title,
        author_name: r.author_name ?? 'Unknown',
        first_publish_year: r.first_publish_year,
        cover_id: r.cover_id,
        log_count: Number(r.log_count),
      };
      const mine = yours.get(r.id);
      return mine ? { ...work, your_read: mine } : work;
    });
  }

  /**
   * AC-7 "my status if any": the viewer's latest attempt at each result, the
   * same shape getWork returns. ONE query for the whole page, never per row.
   */
  async #yourReads(viewer: string | null, workIds: string[]): Promise<Map<string, YourRead>> {
    if (!viewer || workIds.length === 0) return new Map();
    const rows = await this.db.execute<{
      work_id: string; id: string; status: string; rating: string | null; hearted: boolean;
      page: number | null; percent: string | null;
    }>(sql`
      SELECT DISTINCT ON (r.work_id)
        r.work_id, r.id, r.status, r.rating, r.hearted, p.page, p.percent
      FROM reads r
      LEFT JOIN LATERAL (
        SELECT pe.page, pe.percent FROM progress_events pe
        WHERE pe.read_id = r.id ORDER BY pe.at DESC LIMIT 1
      ) p ON true
      WHERE r.user_id = ${viewer} AND r.work_id IN ${workIds}
      ORDER BY r.work_id, r.attempt_no DESC`);
    return new Map(rows.map((r) => [r.work_id, {
      id: r.id,
      status: r.status,
      rating: r.rating === null ? null : Number(r.rating),
      hearted: r.hearted,
      page: r.page ?? null,
      percent: r.percent == null ? null : Number(r.percent),
    }]));
  }

  // $client.unsafe, not sql`...`, so SEARCH_SQL stays one shared string that
  // the test executes verbatim. Parameters are still bound by the driver --
  // "unsafe" refers to the query text, not to the values.
  //
  // It also means postgres.js sends an UNNAMED statement (unsafe() defaults
  // to prepare: false), so Postgres plans each search with its actual
  // parameters. Keep it that way. As a named prepared statement, Postgres
  // may switch to a generic plan after five executions, and SEARCH_SQL's
  // generic plan walks works_popularity_idx in every arm, filtering row by row:
  // the 3.2M-row scan this query was rebuilt to avoid (audit 02, A-02-004).
  async #localSearch(query: string, limit: number, allowExplicit: boolean): Promise<SearchRow[]> {
    return (await this.db.$client.unsafe(
      SEARCH_SQL,
      searchArgs(query, limit, allowExplicit) as (string | number | boolean | null)[],
    )) as unknown as SearchRow[];
  }

  /**
   * Takes a viewer because every user-scoped read does, from day one.
   * `null` is a guest and simply gets no `your_read`.
   */
  async getWork(viewer: string | null, id: string): Promise<Work | null> {
    // The non-viewer part of a book page is identical for everyone, so it is
    // cacheable. In-process for a single instance — no network hop, and
    // strictly faster than Redis would be here. Keyed by the REQUESTED id, so
    // a merged id caches the survivor's body with its merged_into (D3).
    const cacheKey = `work:${id}`;
    let base = await this.cache.get<Work>(cacheKey);

    if (!base) {
      // D3: a merged id answers with the survivor, never 404 (PRD §40.3).
      const workId = await resolveWorkId(this.db, id);
      if (!workId) return null;
      // author_name and cover_id are DERIVED now: authorship moved to
      // work_authors and covers live on editions (architecture.md §3.1). The
      // RESPONSE shape is unchanged on purpose — the storage change must not
      // reach the client, which is already shipped on a phone.
      const [w] = await this.db.execute<{
        id: string; title: string; subtitle: string | null;
        first_publish_year: number | null; log_count: number;
        ol_cover_id: number | null; author_name: string | null; maturity: Maturity;
      }>(sql`
        SELECT
          w.id, w.title, w.subtitle, w.first_publish_year, w.log_count, w.ol_cover_id, w.maturity,
          (SELECT a.name
             FROM work_authors wa JOIN authors a ON a.id = wa.author_id
            WHERE wa.work_id = w.id
            ORDER BY wa.position, a.name
            LIMIT 1) AS author_name
        FROM works w
        WHERE w.id = ${workId} AND w.merged_into_id IS NULL
        LIMIT 1
      `);
      if (!w) return null;

      // The book page's real content (audit 08: the screen showed one fixed
      // description, series and rating histogram for every book). Cached
      // with the rest of the base for 60 s. The histogram reads the work's
      // ratings through reads_work_idx, so it costs what the work has. It
      // counts the readers rating_count counts: latest_ratings (0029).
      const [extra] = await this.db.execute<{
        description: string | null;
        authors: { id: string; name: string }[] | null;
        series: { id: string; name: string; position: string | number | null }[] | null;
        buckets: Record<string, number> | null;
      }>(sql`
        SELECT
          (SELECT description FROM works WHERE id = ${workId}) AS description,
          (SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY wa.position, a.name)
             FROM work_authors wa JOIN authors a ON a.id = wa.author_id
            WHERE wa.work_id = ${workId}) AS authors,
          (SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'position', se.position) ORDER BY s.name)
             FROM series_entries se JOIN series s ON s.id = se.series_id
            WHERE se.work_id = ${workId}) AS series,
          (SELECT json_object_agg(b, n) FROM (
             SELECT rating::text AS b, count(*)::int AS n
             FROM latest_ratings WHERE work_id = ${workId} GROUP BY 1) d) AS buckets
      `);

      const eds = await this.db
        .select({
          id: editions.id,
          isbn13: editions.isbn13,
          pageCount: editions.pageCount,
          format: editions.format,
          olCoverId: editions.olCoverId,
          publisher: editions.publisher,
          publishYear: editions.publishYear,
        })
        .from(editions)
        .where(eq(editions.workId, workId))
        .orderBy(asc(editions.pageCount));

      const [stats] = await this.db.execute<{
        avg_rating: string | null;
        weighted_rating: string | null;
        rating_count: string | null;
        heart_count: string | null;
      }>(sql`
        SELECT avg_rating, weighted_rating, rating_count, heart_count
        FROM work_stats
        WHERE work_id = ${workId}
        LIMIT 1
      `);

      base = {
        id: w.id,
        title: w.title,
        author_name: w.author_name ?? 'Unknown',
        first_publish_year: w.first_publish_year,
        cover_id: w.ol_cover_id ?? eds.find((e) => e.olCoverId !== null)?.olCoverId ?? null,
        log_count: Number(w.log_count),
        avg_rating: stats?.avg_rating ? Number(stats.avg_rating) : null,
        weighted_rating: stats?.weighted_rating ? Number(stats.weighted_rating) : null,
        rating_count: stats?.rating_count ? Number(stats.rating_count) : 0,
        heart_count: stats?.heart_count ? Number(stats.heart_count) : 0,
        editions: eds.map((e) => ({
          id: e.id,
          isbn13: e.isbn13,
          page_count: e.pageCount,
          format: e.format,
          cover_id: e.olCoverId,
          publisher: e.publisher,
          publish_year: e.publishYear,
        })),
        maturity: w.maturity,
        description: extra?.description ?? null,
        authors: extra?.authors ?? [],
        series: (extra?.series ?? []).map((x) => ({ ...x, position: x.position === null ? null : Number(x.position) })),
        rating_distribution: Object.fromEntries(
          RATING_BUCKETS.map((b) => [b, Number(extra?.buckets?.[b] ?? 0)]),
        ) as Record<RatingBucket, number>,
        ...(workId !== id ? { merged_into: workId } : {}),
      };
      await this.cache.set(cacheKey, base, 60);
    }

    // PRD §7.8: a direct link always resolves; the interstitial is the
    // client's, on the same rule as a scan. Asked only for explicit works.
    if (base.maturity === 'explicit') {
      base = { ...base, content_warning: !(await this.#allowsExplicit(viewer)) };
    } else {
      base = { ...base, content_warning: false };
    }

    if (!viewer) return base;

    const [r] = await this.db
      .select({
        id: reads.id,
        status: reads.status,
        rating: reads.rating,
        hearted: reads.hearted,
        // Qualified by hand: inside a select list drizzle renders ${reads.id} as a bare "id", which is rv.id here.
        reviewId: sql<string | null>`(SELECT rv.id FROM reviews rv WHERE rv.read_id = "reads"."id" AND rv.deleted_at IS NULL)`,
      })
      .from(reads)
      .where(sql`${reads.userId} = ${viewer} AND ${reads.workId} = ${base.id}`)
      .orderBy(desc(reads.attemptNo))
      .limit(1);

    if (!r) return base;

    const [p] = await this.db
      .select({ page: progressEvents.page, percent: progressEvents.percent })
      .from(progressEvents)
      .where(eq(progressEvents.readId, r.id))
      .orderBy(desc(progressEvents.at))
      .limit(1);

    return {
      ...base,
      your_read: {
        id: r.id,
        status: r.status,
        rating: r.rating === null ? null : Number(r.rating),
        hearted: r.hearted,
        page: p?.page ?? null,
        percent: p?.percent == null ? null : Number(p.percent),
        review_id: r.reviewId ?? null,
      },
    };
  }

  /**
   * An author's page (SL-43, audit 08). Before this the app searched for the
   * author's NAME as a title and filled the gaps with invented books and a
   * made-up bio. Works come from work_authors, most logged first, merged and
   * provisional works excluded; explicit works follow search's rule
   * (PRD §7.8: a discovery surface). null for an id that names no author.
   */
  async getAuthor(viewer: string | null, id: string, limit = 50, offset = 0): Promise<AuthorDetail | null> {
    const [a] = await this.db.execute<{ id: string; name: string; alternate_names: string[]; bio: string | null }>(sql`
      SELECT id, name, alternate_names, bio FROM authors WHERE id = ${id}`);
    if (!a) return null;
    const allowExplicit = await this.#allowsExplicit(viewer);
    const live = sql`w.merged_into_id IS NULL AND NOT w.is_provisional AND (w.maturity <> 'explicit' OR ${allowExplicit})`;

    const [counts, rows] = await Promise.all([
      this.db.execute<{ works_count: number; read_count: number }>(sql`
        SELECT count(*)::int AS works_count,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM reads r WHERE r.user_id = ${viewer}::uuid AND r.work_id = w.id AND r.status = 'finished'))::int AS read_count
        FROM work_authors wa JOIN works w ON w.id = wa.work_id
        WHERE wa.author_id = ${id} AND ${live}`),
      this.db.execute<{ id: string; title: string; first_publish_year: number | null; log_count: number; cover_id: number | null }>(sql`
        SELECT w.id, w.title, w.first_publish_year, w.log_count,
               COALESCE(w.ol_cover_id, (SELECT e.ol_cover_id FROM editions e
                  WHERE e.work_id = w.id AND e.ol_cover_id IS NOT NULL
                  ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)) AS cover_id
        FROM work_authors wa JOIN works w ON w.id = wa.work_id
        WHERE wa.author_id = ${id} AND ${live}
        -- + 0, as in SEARCH_SQL's typo arms: ORDER BY log_count lets the
        -- planner walk the popularity index over the whole catalog probing
        -- work_authors per work (165k probes, 543k buffers, 2.3 s for a
        -- 789-work author on flyleaf_dev). The author's works via
        -- work_authors_author_idx, then a sort, cost what the author has.
        ORDER BY w.log_count + 0 DESC, w.id
        LIMIT ${limit} OFFSET ${offset}`),
    ]);
    const yours = await this.#yourReads(viewer, rows.map((r) => r.id));
    return {
      id: a.id,
      name: a.name,
      alternate_names: a.alternate_names ?? [],
      bio: a.bio,
      works_count: Number(counts[0]?.works_count ?? 0),
      read_count: Number(counts[0]?.read_count ?? 0),
      works: rows.map((r) => {
        const yourRead = yours.get(r.id);
        return {
          id: r.id,
          title: r.title,
          author_name: a.name,
          first_publish_year: r.first_publish_year,
          cover_id: r.cover_id,
          log_count: Number(r.log_count),
          ...(yourRead ? { your_read: yourRead } : {}),
        };
      }),
    };
  }

  /**
   * A series page with the viewer's progress through it (SL-43, audit 08).
   * Entries in position order; explicit works follow search's rule.
   */
  async getSeries(viewer: string | null, id: string): Promise<SeriesDetail | null> {
    const [s] = await this.db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM series WHERE id = ${id}`);
    if (!s) return null;
    const allowExplicit = await this.#allowsExplicit(viewer);
    const rows = await this.db.execute<{
      work_id: string; position: string | null; title: string; author_name: string | null; cover_id: number | null;
    }>(sql`
      SELECT w.id AS work_id, se.position, w.title,
             (SELECT a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id
               WHERE wa.work_id = w.id ORDER BY wa.position, a.name LIMIT 1) AS author_name,
             w.ol_cover_id AS cover_id
      FROM series_entries se JOIN works w ON w.id = se.work_id
      WHERE se.series_id = ${id}
        AND w.merged_into_id IS NULL AND NOT w.is_provisional
        AND (w.maturity <> 'explicit' OR ${allowExplicit})
      ORDER BY se.position NULLS LAST, w.title`);
    const yours = await this.#yourReads(viewer, rows.map((r) => r.work_id));
    const entries = rows.map((r) => ({
      work_id: r.work_id,
      position: r.position === null ? null : Number(r.position),
      title: r.title,
      author_name: r.author_name ?? 'Unknown',
      cover_id: r.cover_id,
      your_status: yours.get(r.work_id)?.status ?? null,
    }));
    return { id: s.id, name: s.name, entries, read_books: entries.filter((e) => e.your_status === 'finished').length };
  }

  /**
   * Resolves an edition and its parent work by ISBN-10 or ISBN-13 (FN-42, PRD §14.2, §3374).
   * Used for barcode scanning and exact ISBN resolution.
   *
   * PRD §7.8 [LOCKED]: a scan always resolves, whatever the maturity, because
   * "a user is never blocked from recording a book they actually read"
   * (audit 02c reverted decision 4's 403). `content_warning` tells the client
   * to show the interstitial: the work is explicit and the viewer is one
   * search would hide it from. The viewer still orders a shared ISBN, so the
   * scan and search pick the same work (A-02-011).
   */
  async getEditionByIsbn(viewer: string | null, rawIsbn: string): Promise<EditionLookupResult | null> {
    const detected = detectIsbn(rawIsbn);
    if (!detected) {
      throw ApiError.unprocessable('invalid_field', 'Invalid ISBN format or checksum.', 'isbn');
    }

    const candidates = [detected.isbn13, detected.isbn10].filter((v): v is string => Boolean(v));
    const allowExplicit = await this.#allowsExplicit(viewer);

    const [e] = await this.db.execute<{
      id: string;
      work_id: string;
      isbn_13: string | null;
      isbn_10: string | null;
      title: string | null;
      publisher: string | null;
      publish_year: number | null;
      page_count: number | null;
      format: string;
      ol_cover_id: number | null;
      maturity: Maturity;
    }>(sql`
      SELECT
        e.id, e.work_id, e.isbn_13, e.isbn_10, e.title,
        e.publisher, e.publish_year, e.page_count, e.format, e.ol_cover_id,
        w.maturity
      FROM editions e
      JOIN works w ON w.id = e.work_id
      WHERE (e.isbn_13 IN ${candidates} OR e.isbn_10 IN ${candidates})
        AND w.merged_into_id IS NULL
        AND w.is_provisional = false
      ORDER BY ${isbnOrder(allowExplicit)}
      LIMIT 1
    `);

    if (!e) return null;

    const work = await this.getWork(viewer, e.work_id);
    if (!work) return null;

    return {
      work,
      edition: {
        id: e.id,
        work_id: e.work_id,
        isbn13: e.isbn_13,
        isbn10: e.isbn_10,
        title: e.title,
        publisher: e.publisher,
        publish_year: e.publish_year,
        page_count: e.page_count,
        format: e.format,
        cover_id: e.ol_cover_id,
      },
      maturity: e.maturity,
      content_warning: e.maturity === 'explicit' && !allowExplicit,
    };
  }
}

import {
  searchQuerySchema,
  searchResponseSchema,
  idParamSchema,
  workSchema,
  editionLookupResponseSchema,
  isbnParamSchema,
  authorQuerySchema,
  authorDetailSchema,
  seriesDetailSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

// limit is range-checked and coerced by searchQuerySchema before this runs.
const searchQuery = z.object({ q: z.string().optional(), limit: z.number().int().optional() });

export function catalogRoutes(service: CatalogService) {
  return async (app: FastifyInstance) => {
    // Both routes are readable by guests (PRD §4.2).
    app.get(
      '/search',
      {
        schema: {
          tags: ['Catalog'],
          summary: 'Search catalog',
          description: 'Searches works by title, subtitle, author, or alternate titles. Guest readable. Explicit works are excluded unless the viewer is 18+ and has opted in (PRD §7.8), an exact ISBN included (the scan endpoint always resolves).',
          querystring: searchQuerySchema,
          response: {
            200: searchResponseSchema,
          },
        },
      },
      async (req) => {
        const { q, limit } = searchQuery.parse(req.query);
        return { data: await service.search(req.viewer, q ?? '', limit) };
      },
    );

    app.get<{ Params: { id: string } }>(
      '/works/:id',
      {
        schema: {
          tags: ['Catalog'],
          summary: 'Get book by ID',
          description: 'Returns work metadata, editions, and viewer read state if signed in. Guest readable.',
          params: idParamSchema,
          response: {
            200: workSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const work = await service.getWork(req.viewer, req.params.id);
        if (!work) throw ApiError.notFound('No such book.');
        return work;
      },
    );

    app.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>(
      '/authors/:id',
      {
        schema: {
          tags: ['Catalog'],
          summary: 'Get author by ID',
          description: 'An author and their works, most logged first, through work_authors (SL-43). Guest readable. Explicit works are excluded unless the viewer is 18+ and has opted in (PRD §7.8).',
          params: idParamSchema,
          querystring: authorQuerySchema,
          response: {
            200: authorDetailSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const author = await service.getAuthor(req.viewer, req.params.id, req.query.limit ?? 50, req.query.offset ?? 0);
        if (!author) throw ApiError.notFound('No such author.');
        return author;
      },
    );

    app.get<{ Params: { id: string } }>(
      '/series/:id',
      {
        schema: {
          tags: ['Catalog'],
          summary: 'Get series by ID',
          description: 'A series in reading order with the viewer’s status on each entry (SL-43). Guest readable. Explicit works follow the search rule (PRD §7.8).',
          params: idParamSchema,
          response: {
            200: seriesDetailSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const series = await service.getSeries(req.viewer, req.params.id);
        if (!series) throw ApiError.notFound('No such series.');
        return series;
      },
    );

    app.get<{ Params: { isbn: string } }>(
      '/editions/isbn/:isbn',
      {
        schema: {
          tags: ['Catalog'],
          summary: 'Get edition by ISBN',
          description: 'Resolves an edition and its parent work by ISBN-10 or ISBN-13 barcode (PRD §14.2, §3374). Always resolves, whatever the maturity of the work (PRD §7.8: a user is never blocked from recording a book they read). `content_warning` is true when the work is explicit and search would hide it from this viewer (a guest, a minor or an adult who has not opted in); the client shows its interstitial then.',
          params: isbnParamSchema,
          response: {
            200: editionLookupResponseSchema,
            404: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const result = await service.getEditionByIsbn(req.viewer, req.params.isbn);
        if (!result) throw ApiError.notFound('No edition found for this ISBN.');
        return result;
      },
    );
  };
}
