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
      const [row] = await db.execute<{ id: string }>(sql`
        INSERT INTO works (title, author_name, first_publish_year, ol_cover_id)
        VALUES (${title.trim()}, ${author.trim()}, ${num(year)}, ${num(coverId)})
        RETURNING id
      `);
      if (!row) throw new Error('no id returned');
      await db.execute(sql`
        INSERT INTO editions (work_id, isbn_13, page_count, format, ol_cover_id)
        VALUES (${row.id}, ${isbn13?.trim() || null}, ${num(pages)},
                ${format?.trim() || 'paperback'}, ${num(coverId)})
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
