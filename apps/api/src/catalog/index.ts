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

export type Edition = {
  id: string;
  isbn13: string | null;
  page_count: number | null;
  format: string;
  cover_id: number | null;
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

export type EditionLookupResult = {
  work: Work;
  edition: EditionDetail;
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
  avg_rating?: number | null;
  weighted_rating?: number | null;
  rating_count?: number;
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
  return [p.raw, p.tsquery, p.like, p.prefix, limit, allowExplicit];
}

/**
 * Search. Exported as a string so `search.test.ts` runs THIS query rather
 * than a copy of it.
 *
 *   $1 raw text   $2 tsquery (or NULL)   $3 '%like%'   $4 'prefix%'   $5 limit
 *   $6 allow explicit works (PRD §7.8) -- build these with searchArgs()
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
  title_fuzzy AS (
    SELECT id FROM works
    WHERE title % $1::text
      -- Under 4 characters every title sharing a word-initial pair is a
      -- candidate: on the full catalog "th" pulled 1.1M of 3.2M titles
      -- through the index and rechecked 2.8M rows to keep 11. Typo tolerance
      -- means nothing that short; the prefix arm covers it.
      AND char_length($1::text) >= 4
      AND merged_into_id IS NULL AND NOT is_provisional
      AND (maturity <> 'explicit' OR $6::boolean)
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
    --
    -- Always a SUBSTRING ('%' || 'q%' = '%q%'), even for two characters
    -- where title_like anchors. Anchored, 'th%' made the planner walk 61k
    -- works by popularity (vs 3.6k for '%th%'); unanchored, a 2-character
    -- CJK name seq-scans authors. Which to give up is DECISION NEEDED in
    -- docs/audit/findings/02-search.md (A-02-012); this is the pre-audit
    -- behaviour, kept until it is decided.
    WHERE flyleaf_author_names(a.name, a.alternate_names) ILIKE ('%' || $4::text)
      AND w.merged_into_id IS NULL AND NOT w.is_provisional
      AND (w.maturity <> 'explicit' OR $6::boolean)
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
          AND flyleaf_author_names(a.name, a.alternate_names) ILIKE ('%' || $4::text)
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

/**
 * One ISBN can sit on editions of two works until dedupe merges them. Search
 * and the scan endpoint must pick the same one, and the same one every time:
 * the more-logged work, then the newest edition, then the id as a tiebreak.
 */
const ISBN_ORDER = sql.raw('w.log_count DESC, e.publish_year DESC NULLS LAST, e.id');

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
   */
  async #findWorkByIsbn(isbn: DetectedIsbn): Promise<SearchRow | null> {
    const candidates = [isbn.isbn13, isbn.isbn10].filter((v): v is string => Boolean(v));
    if (candidates.length === 0) return null;

    const [row] = await this.db.execute<{
      id: string;
      title: string;
      first_publish_year: number | null;
      log_count: number;
      author_name: string | null;
      cover_id: number | null;
    }>(sql`
      SELECT
        w.id, w.title, w.first_publish_year, w.log_count,
        (SELECT a.name
           FROM work_authors wa JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = w.id
          ORDER BY wa.position, a.name
          LIMIT 1) AS author_name,
        COALESCE(e.ol_cover_id, w.ol_cover_id) AS cover_id
      FROM editions e
      JOIN works w ON w.id = e.work_id
      WHERE (e.isbn_13 IN ${candidates} OR e.isbn_10 IN ${candidates})
        AND w.merged_into_id IS NULL
        AND w.is_provisional = false
      ORDER BY ${ISBN_ORDER}
      LIMIT 1
    `);

    if (!row) return null;

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
   * hand-edited flag cannot expose them to a minor.
   */
  async #allowsExplicit(viewer: string | null): Promise<boolean> {
    if (!viewer) return false;
    const [row] = await this.db.execute<{ ok: boolean }>(sql`
      SELECT p.show_explicit AND u.date_of_birth <= (current_date - interval '18 years')::date AS ok
      FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ${viewer} AND u.deleted_at IS NULL`);
    return row?.ok === true;
  }

  /** See SEARCH_SQL above for how matching and ranking work. */
  async search(viewer: string | null, q: string, limit = 20): Promise<Work[]> {
    const query = cleanQuery(q);
    if (Array.from(query).length < 2) return [];

    const isbn = detectIsbn(query);
    // An exact ISBN is a lookup, not discovery: like a scan (§7.8), it
    // resolves whatever the work's maturity.
    const [allowExplicit, found] = await Promise.all([
      this.#allowsExplicit(viewer),
      isbn ? this.#findWorkByIsbn(isbn) : null,
    ]);
    let isbnMatch: SearchRow | null = found;
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
            isbnMatch = await this.#findWorkByIsbn(isbn);
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
  //
  // It also means postgres.js sends an UNNAMED statement (unsafe() defaults
  // to prepare: false), so Postgres plans each search with its actual
  // parameters. Keep it that way. As a named prepared statement, Postgres
  // may switch to a generic plan after five executions, and SEARCH_SQL's
  // generic plan walks works_log_count_idx in every arm, filtering row by row:
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

      const [stats] = await this.db.execute<{
        avg_rating: string | null;
        weighted_rating: string | null;
        rating_count: string | null;
      }>(sql`
        SELECT avg_rating, weighted_rating, rating_count
        FROM work_stats
        WHERE work_id = ${id}
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

  /**
   * Resolves an edition and its parent work by ISBN-10 or ISBN-13 (FN-42, PRD §14.2, §3374).
   * Used for barcode scanning and exact ISBN resolution.
   */
  async getEditionByIsbn(viewer: string | null, rawIsbn: string): Promise<EditionLookupResult | null> {
    const detected = detectIsbn(rawIsbn);
    if (!detected) {
      throw ApiError.unprocessable('invalid_field', 'Invalid ISBN format or checksum.', 'isbn');
    }

    const candidates = [detected.isbn13, detected.isbn10].filter((v): v is string => Boolean(v));

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
    }>(sql`
      SELECT
        e.id, e.work_id, e.isbn_13, e.isbn_10, e.title,
        e.publisher, e.publish_year, e.page_count, e.format, e.ol_cover_id
      FROM editions e
      JOIN works w ON w.id = e.work_id
      WHERE (e.isbn_13 IN ${candidates} OR e.isbn_10 IN ${candidates})
        AND w.merged_into_id IS NULL
        AND w.is_provisional = false
      ORDER BY ${ISBN_ORDER}
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
          description: 'Searches works by title, subtitle, author, or alternate titles. Guest readable. Explicit works are excluded unless the viewer is 18+ and has opted in (PRD §7.8); an exact ISBN still resolves.',
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

    app.get<{ Params: { isbn: string } }>(
      '/editions/isbn/:isbn',
      {
        schema: {
          tags: ['Catalog'],
          summary: 'Get edition by ISBN',
          description: 'Resolves an edition and its parent work by ISBN-10 or ISBN-13 barcode (PRD §14.2, §3374).',
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
