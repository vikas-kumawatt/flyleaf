--- HAND-EDITED. Two corrections to what `drizzle-kit generate` produced.
---
--- 1. ORDER. drizzle emitted `drop column search_vector` and re-added it
---    BEFORE adding `alternate_titles`, which the new generated expression
---    references. As generated, this migration fails on its second statement.
---
--- 2. LOST INDEX. Dropping a column drops every index on it, so
---    `works_search_idx` (GIN over search_vector) disappeared -- and drizzle
---    does not recreate it, because from its snapshot's point of view the
---    index never changed. Search would still work and would silently
---    sequential-scan the whole catalog. It is recreated at the bottom.
---
--- 3. IMMUTABILITY, again. The generated expression first used
---    `array_to_string(alternate_titles, ' ')`, which is STABLE for the same
---    reason bare `unaccent()` is -- so Postgres rejected it with
---    "generation expression is not immutable". It now calls
---    `flyleaf_unaccent_array(text[])`, created in migrate.ts alongside
---    flyleaf_unaccent.
---
--- Regenerating this file will reintroduce all three problems. There are
--- tests asserting the index exists and that the column populates.

CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dump_type" text NOT NULL,
	"source_file" text NOT NULL,
	"file_size" bigint,
	"lines_read" bigint DEFAULT 0 NOT NULL,
	"rows_written" bigint DEFAULT 0 NOT NULL,
	"rows_skipped" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ingest_runs_type_ck" CHECK ("ingest_runs"."dump_type" IN ('authors','works','editions')),
	CONSTRAINT "ingest_runs_status_ck" CHECK ("ingest_runs"."status" IN ('running','done','failed','interrupted'))
);
--> statement-breakpoint
CREATE INDEX "ingest_runs_resume_idx" ON "ingest_runs" USING btree ("dump_type","source_file","started_at");
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "alternate_titles" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "ol_cover_id" integer;
--> statement-breakpoint
ALTER TABLE "works" drop column "search_vector";
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', flyleaf_unaccent(coalesce(title,''))),    'A') ||
        setweight(to_tsvector('simple', flyleaf_unaccent(coalesce(subtitle,''))), 'B') ||
        setweight(to_tsvector('simple', flyleaf_unaccent_array(alternate_titles)), 'C')) STORED;
--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING gin ("search_vector");
