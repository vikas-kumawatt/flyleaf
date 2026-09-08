--- Author aliases.
---
--- Open Library files Haruki Murakami's novels under an author record named
--- 村上春樹. `name ILIKE '%murakami%'` is false against that, and sort_name
--- is empty, so *Norwegian Wood* -- 1,351 logs -- was unreachable by
--- searching for its author. No query change can fix that; it needs the data.
---
--- HAND-EDITED: drizzle generated only the ADD COLUMN. The index below is an
--- expression index over a custom function, which drizzle cannot express.
---
--- SLOW ON AN EXISTING CATALOG. Building a GIN trigram index over 15.4M
--- author rows takes tens of minutes -- for comparison, the equivalent over
--- 3.2M works took 847 seconds. It is a one-off, it is instant on an empty
--- database, and search would sequential-scan 15.4M rows without it.

ALTER TABLE "authors" ADD COLUMN "alternate_names" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authors_search_trgm_idx"
  ON "authors" USING gin (flyleaf_author_names(name, alternate_names) gin_trgm_ops);
