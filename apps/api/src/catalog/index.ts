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

export type Edition = {
  id: string;
  isbn13: string | null;
  page_count: number | null;
  format: string;
  cover_id: number | null;
};

export type YourRead = {
  id: string;
  status: string;
  rating: number | null;
  hearted: boolean;
  page: number | null;
  percent: number | null;
};

export type Work = {
  id: string;
  title: string;
  author_name: string;
  first_publish_year: number | null;
  cover_id: number | null;
  log_count: number;
  editions?: Edition[];
  your_read?: YourRead;
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
  const raw = q.trim();

  // Fold accents the same way `flyleaf_unaccent` did when the vector was
  // built, or "Miserables" will not match the stored 'miserables'.
  const tokens = raw
    .split(/\s+/)
    .map((t) =>
      t.toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        // to_tsquery is a PARSER: an apostrophe or a colon in raw input is a
        // syntax error, not a character to match on.
        .replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);

  // LIKE metacharacters. Without escaping, a query of "%" matches everything.
  const esc = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  return {
    raw,
    tsquery: tokens.length ? tokens.map((t) => `${t}:*`).join(' & ') : null,
    like: `%${esc}%`,
    prefix: `${esc}%`,
  };
}

/**
 * Search. Exported as a string so `search.test.ts` runs THIS query rather
 * than a copy of it.
 *
 *   $1 raw text   $2 tsquery (or NULL)   $3 '%like%'   $4 'prefix%'   $5 limit
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
 *   - Trigram similarity — absorbs typos ("piranese", "the hobit").
 *   - Author name — a separate arm because authorship is a join table.
 *
 * The per-arm LIMITs are what keep this bounded: a common word can match
 * hundreds of thousands of rows, and ranking those would be the seq scan
 * again by another name. Each arm takes its most-logged rows and stops.
 */
export const SEARCH_SQL = `
  WITH fts AS (
    SELECT id FROM works
    WHERE $2::text IS NOT NULL
      AND search_vector @@ to_tsquery('simple', $2::text)
    ORDER BY log_count DESC
    LIMIT 300
  ),
  title_like AS (
    SELECT id FROM works
    WHERE title ILIKE $3::text
    ORDER BY log_count DESC
    LIMIT 300
  ),
  title_fuzzy AS (
    SELECT id FROM works
    WHERE title % $1::text
    ORDER BY log_count DESC
    LIMIT 150
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
    -- authors_search_trgm_idx, or Postgres will not use it.
    WHERE flyleaf_author_names(a.name, a.alternate_names) ILIKE $3::text
    ORDER BY w.log_count DESC
    LIMIT 300
  ),
  candidate AS (
    SELECT id FROM fts
    UNION SELECT id FROM title_like
    UNION SELECT id FROM title_fuzzy
    UNION SELECT id FROM by_author
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
          AND flyleaf_author_names(a.name, a.alternate_names) ILIKE $3::text
      ) THEN 0.20 ELSE 0 END)
    + similarity(w.title, $1::text) * 0.10
    -- Popularity, from the reading-log and ratings dumps (--popularity).
    -- ln() so 10,000 logs beats 100 without burying everything else; the cap
    -- stops one runaway title dominating every query it happens to match.
    -- This is the term that puts Susanna Clarke's Piranesi above a 1910
    -- monograph on the architect.
    + LEAST(ln(1 + w.log_count) / 10.0, 1.0) * 0.35 DESC,
    w.log_count DESC,
    w.title
  LIMIT $5
`;

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

  /** See SEARCH_SQL above for how matching and ranking work. */
  async search(q: string, limit = 20): Promise<Work[]> {
    const query = q.trim();
    if (query.length < 2) return [];

    let rows = await this.#localSearch(query, limit);

    // Layer 2 of the catalog accelerator. Bounded by the outbound client's
    // 2.5s timeout and skipped entirely when the circuit is open or the
    // shared rate limiter has no token, so a slow or unwell Open Library
    // costs a few milliseconds rather than the request.
    if (rows.length < GAP_FILL_THRESHOLD && this.gapFill && query.length >= 3) {
      const stored = await this.gapFill.fill(query);
      if (stored > 0) rows = await this.#localSearch(query, limit);
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      author_name: r.author_name ?? 'Unknown',
      first_publish_year: r.first_publish_year,
      cover_id: r.cover_id,
      log_count: Number(r.log_count),
    }));
  }

  // $client.unsafe, not sql`...`, so SEARCH_SQL stays one shared string that
  // the test executes verbatim. Parameters are still bound by the driver --
  // "unsafe" refers to the query text, not to the values.
  async #localSearch(query: string, limit: number): Promise<SearchRow[]> {
    const p = buildSearchParams(query);
    return (await this.db.$client.unsafe(
      SEARCH_SQL,
      [p.raw, p.tsquery, p.like, p.prefix, limit],
    )) as unknown as SearchRow[];
  }

  /**
   * Takes a viewer because every user-scoped read does, from day one.
   * `null` is a guest and simply gets no `your_read`.
   */
  async getWork(viewer: string | null, id: string): Promise<Work | null> {
    // The non-viewer part of a book page is identical for everyone, so it is
    // cacheable. In-process for a single instance — no network hop, and
    // strictly faster than Redis would be here.
    const cacheKey = `work:${id}`;
    let base = await this.cache.get<Work>(cacheKey);

    if (!base) {
      // author_name and cover_id are DERIVED now: authorship moved to
      // work_authors and covers live on editions (architecture.md §3.1). The
      // RESPONSE shape is unchanged on purpose — the storage change must not
      // reach the client, which is already shipped on a phone.
      const [w] = await this.db.execute<{
        id: string; title: string; subtitle: string | null;
        first_publish_year: number | null; log_count: number;
        ol_cover_id: number | null; author_name: string | null;
      }>(sql`
        SELECT
          w.id, w.title, w.subtitle, w.first_publish_year, w.log_count, w.ol_cover_id,
          (SELECT a.name
             FROM work_authors wa JOIN authors a ON a.id = wa.author_id
            WHERE wa.work_id = w.id
            ORDER BY wa.position, a.name
            LIMIT 1) AS author_name
        FROM works w
        WHERE w.id = ${id} AND w.merged_into_id IS NULL
        LIMIT 1
      `);
      if (!w) return null;

      const eds = await this.db
        .select({
          id: editions.id,
          isbn13: editions.isbn13,
          pageCount: editions.pageCount,
          format: editions.format,
          olCoverId: editions.olCoverId,
        })
        .from(editions)
        .where(eq(editions.workId, id))
        .orderBy(asc(editions.pageCount));

      base = {
        id: w.id,
        title: w.title,
        author_name: w.author_name ?? 'Unknown',
        first_publish_year: w.first_publish_year,
        cover_id: w.ol_cover_id ?? eds.find((e) => e.olCoverId !== null)?.olCoverId ?? null,
        log_count: Number(w.log_count),
        editions: eds.map((e) => ({
          id: e.id,
          isbn13: e.isbn13,
          page_count: e.pageCount,
          format: e.format,
          cover_id: e.olCoverId,
        })),
      };
      await this.cache.set(cacheKey, base, 60);
    }

    if (!viewer) return base;

    const [r] = await this.db
      .select({
        id: reads.id,
        status: reads.status,
        rating: reads.rating,
        hearted: reads.hearted,
      })
      .from(reads)
      .where(sql`${reads.userId} = ${viewer} AND ${reads.workId} = ${id}`)
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
      },
    };
  }
}

const searchQuery = z.object({ q: z.string().optional() });

export function catalogRoutes(service: CatalogService) {
  return async (app: FastifyInstance) => {
    // Both routes are readable by guests (PRD §4.2).
    app.get('/search', async (req) => {
      const { q } = searchQuery.parse(req.query);
      return { data: await service.search(q ?? '') };
    });

    app.get<{ Params: { id: string } }>('/works/:id', async (req) => {
      const work = await service.getWork(req.viewer, req.params.id);
      if (!work) throw ApiError.notFound('No such book.');
      return work;
    });
  };
}
