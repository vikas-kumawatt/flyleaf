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
import { works, editions, reads, progressEvents } from '../db/schema.js';
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

export class CatalogService {
  constructor(private db: Db, private cache: Cache) {}

  /**
   * Ranks by trigram similarity plus how many people have logged the work.
   *
   * That second term is what makes real books rise above near-duplicates, and
   * it improves on its own as the product grows — better than any dedupe pass
   * for the search-results problem specifically.
   */
  async search(q: string, limit = 20): Promise<Work[]> {
    const query = q.trim();
    if (query.length < 2) return [];

    const rows = await this.db.execute<{
      id: string; title: string; author_name: string;
      first_publish_year: number | null; ol_cover_id: number | null; log_count: number;
    }>(sql`
      SELECT id, title, author_name, first_publish_year, ol_cover_id, log_count
      FROM works
      WHERE title ILIKE '%' || ${query} || '%'
         OR author_name ILIKE '%' || ${query} || '%'
         OR similarity(title, ${query}) > 0.25
         OR similarity(author_name, ${query}) > 0.25
      ORDER BY
        GREATEST(similarity(title, ${query}), similarity(author_name, ${query})) * 0.45
        + ln(1 + log_count) * 0.25
        + (CASE WHEN ol_cover_id IS NOT NULL THEN 0.15 ELSE 0 END) DESC
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      author_name: r.author_name,
      first_publish_year: r.first_publish_year,
      cover_id: r.ol_cover_id,
      log_count: Number(r.log_count),
    }));
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
      const [w] = await this.db
        .select({
          id: works.id,
          title: works.title,
          authorName: works.authorName,
          firstPublishYear: works.firstPublishYear,
          olCoverId: works.olCoverId,
          logCount: works.logCount,
        })
        .from(works)
        .where(eq(works.id, id))
        .limit(1);
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
        author_name: w.authorName,
        first_publish_year: w.firstPublishYear,
        cover_id: w.olCoverId,
        log_count: w.logCount,
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
