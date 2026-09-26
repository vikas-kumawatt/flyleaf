// Gap-fill (FN-32) — layer 2 of the catalog accelerator.
//
// A search that finds little locally falls through to Open Library's live
// API. The results are returned to the caller immediately AND written to our
// catalog, so the same gap is fetched exactly once and every later search for
// it is a local index lookup.
//
// phases.md argues for building this BEFORE the full dump ingest, and the
// argument holds up: it has to exist regardless -- no ingest is ever complete
// -- so building it first means it is exercised by real use from day one,
// and its miss log tells you what the ingest filter is getting wrong instead
// of you guessing.
//
// LICENSING. Everything persisted here is Open Library, which is CC0.
// Google Books may be shown live but never stored, and the CHECK constraint
// on `field_provenance` is what makes that structural rather than a promise
// (see db/schema.ts). No code in this file writes anything from any other
// provider, and there is a test that fails if that changes.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import type { CatalogSource, SearchWork } from '../providers/catalog/index.js';

export class GapFillService {
  /** `source` is Open Library (PV-07): the only source we may persist. */
  constructor(private db: Db, private source: CatalogSource) {}

  /**
   * Ask Open Library. Returns [] on any failure -- a rate limit, an open
   * circuit, a timeout. The caller is always mid-request for a real person,
   * and the right answer to "the internet is slow" is the local results.
   */
  async search(q: string, limit = 10): Promise<SearchWork[]> {
    return this.source.search(q, limit);
  }

  /**
   * Persist. CC0, so this is allowed and permanent.
   *
   * Runs INSIDE the search request: CatalogService.search awaits fill() and
   * then re-runs its local query, so the user waits for these writes (and
   * for the fetch, up to its 2.5 s timeout). A failure here costs us nothing
   * except that the next search for the same thing fetches it again, so it
   * must never propagate into the request.
   */
  async persist(works: SearchWork[]): Promise<number> {
    let stored = 0;

    for (const w of works) {
      try {
        await this.db.transaction(async (tx) => {
          const [work] = await tx.execute<{ id: string }>(sql`
            INSERT INTO works (ol_work_key, title, first_publish_year, ol_cover_id, maturity)
            VALUES (${w.olWorkKey}, ${w.title}, ${w.firstPublishYear}, ${w.coverId}, 'unclassified')
            ON CONFLICT (ol_work_key) DO UPDATE SET
              -- A locked field (PRD §7.9) keeps its value, as in MERGE_WORKS.
              (title, first_publish_year, ol_cover_id) = (
                SELECT
                  CASE WHEN 'title' = ANY(l.f) THEN works.title ELSE EXCLUDED.title END,
                  CASE WHEN 'first_publish_year' = ANY(l.f) THEN works.first_publish_year
                       ELSE COALESCE(EXCLUDED.first_publish_year, works.first_publish_year) END,
                  CASE WHEN 'ol_cover_id' = ANY(l.f) THEN works.ol_cover_id
                       ELSE COALESCE(EXCLUDED.ol_cover_id, works.ol_cover_id) END
                FROM (SELECT coalesce(array_agg(fp.field_name), '{}') AS f
                      FROM field_provenance fp
                      WHERE fp.entity_type = 'work' AND fp.entity_id = works.id AND fp.is_locked) l
              ),
              updated_at = now()
            RETURNING id`);
          if (!work) return;

          // search.json gives no subjects, so there is nothing to classify
          // on. It stays 'unclassified', which is honest: a later dump
          // ingest or a work-record fetch will classify it properly. Guessing
          // 'general' here to make the catalog look tidier would be exactly
          // the App Store §1.2 mistake.

          for (const [i, authorKey] of w.authorKeys.entries()) {
            const name = w.authorNames[i] ?? w.authorNames[0];
            if (!name) continue;

            const [author] = await tx.execute<{ id: string }>(sql`
              INSERT INTO authors (ol_author_key, name)
              VALUES (${authorKey}, ${name})
              ON CONFLICT (ol_author_key) DO UPDATE SET name = EXCLUDED.name
              RETURNING id`);
            if (!author) continue;

            await tx.execute(sql`
              INSERT INTO work_authors (work_id, author_id, role, position)
              VALUES (${work.id}, ${author.id}, 'author', ${i})
              ON CONFLICT (work_id, author_id, role) DO NOTHING`);
          }

          await tx.execute(sql`
            INSERT INTO external_ids (entity_type, entity_id, provider, external_id)
            VALUES ('work', ${work.id}, 'open_library', ${w.olWorkKey})
            ON CONFLICT (provider, external_id, entity_type) DO UPDATE SET last_seen_at = now()`);

          // Per-field provenance. 'open_library' is one of the three values
          // the CHECK permits; 'google_books' is not, by design.
          for (const field of ['title', 'first_publish_year', 'ol_cover_id']) {
            await tx.execute(sql`
              INSERT INTO field_provenance (entity_type, entity_id, field_name, provider, confidence)
              VALUES ('work', ${work.id}, ${field}, 'open_library', 60)
              ON CONFLICT (entity_type, entity_id, field_name) DO UPDATE SET
                fetched_at = now()
              -- A user correction outranks an automated fetch, always.
              WHERE field_provenance.is_locked = false`);
          }

          stored++;
        });
      } catch {
        // One bad record must not lose the rest of the batch.
      }
    }

    return stored;
  }

  /**
   * Fetch and store, returning how many landed.
   *
   * The caller then re-runs its LOCAL query rather than merging these rows in
   * by hand. That costs one extra round trip against a table we just wrote,
   * and buys two things worth more than the microseconds: every result has a
   * real `works.id` the client can navigate to, and there is exactly one
   * ranking implementation instead of a second one for gap-filled rows.
   */
  async fill(q: string, limit = 10): Promise<number> {
    const works = await this.search(q, limit);
    if (works.length === 0) return 0;
    return this.persist(works);
  }
}
