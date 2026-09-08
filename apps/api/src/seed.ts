// Loads the hand-made CSV. The most disposable code in the repository —
// FN-2x replaces it with a streaming, resumable, COPY-based ingest of the
// real Open Library dumps.

import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { makeDb, waitForDb } from './platform/index.js';

function num(v: string | undefined): number | null {
  if (!v?.trim()) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

async function main() {
  const path = process.argv[2] ?? '../../db/skeleton/books.csv';
  const db = makeDb();
  await waitForDb(db);

  const text = await readFile(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('csv has no data rows');

  let inserted = 0;
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const [title, author, year, coverId, isbn13, pages, format] = cells;
    if (cells.length < 7 || !title?.trim() || !author?.trim()) {
      skipped++;
      continue;
    }
    try {
      // Authorship is a join table now, so a seed row becomes three inserts.
      // Authors are deduplicated by name, which is wrong in general (two real
      // people share a name) and fine for 102 hand-picked books. FN-21 does
      // this properly, keyed on ol_author_key.
      const authorName = author.trim();
      const [a] = await db.execute<{ id: string }>(sql`
        WITH existing AS (SELECT id FROM authors WHERE name = ${authorName} LIMIT 1),
             created  AS (
               INSERT INTO authors (name)
               SELECT ${authorName} WHERE NOT EXISTS (SELECT 1 FROM existing)
               RETURNING id
             )
        SELECT id FROM existing UNION ALL SELECT id FROM created
      `);
      if (!a) throw new Error('no author id');

      const [row] = await db.execute<{ id: string }>(sql`
        INSERT INTO works (title, first_publish_year, ol_cover_id)
        VALUES (${title.trim()}, ${num(year)}, ${num(coverId)})
        RETURNING id
      `);
      if (!row) throw new Error('no id returned');

      await db.execute(sql`
        INSERT INTO work_authors (work_id, author_id, role, position)
        VALUES (${row.id}, ${a.id}, 'author', 0)
      `);

      // The cover lives on the EDITION, never on the work (§3.1).
      await db.execute(sql`
        INSERT INTO editions (work_id, isbn_13, page_count, format, ol_cover_id, publish_year)
        VALUES (${row.id}, ${isbn13?.trim() || null}, ${num(pages)},
                ${format?.trim() || 'paperback'}, ${num(coverId)}, ${num(year)})
      `);
      inserted++;
    } catch (err) {
      console.warn(`skipped "${title.trim()}": ${String(err)}`);
      skipped++;
    }
  }

  console.log(`seed complete — inserted=${inserted} skipped=${skipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
