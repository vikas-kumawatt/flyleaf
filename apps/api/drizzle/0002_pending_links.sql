--- HAND-EDITED, for the SECOND time. See 0001 for the first.
---
--- `drizzle-kit generate` again emitted:
---
---     ALTER TABLE "works" drop column "search_vector";
---     ALTER TABLE "works" ADD COLUMN "search_vector" ... GENERATED ALWAYS AS (...)
---
--- even though the expression is byte-identical to the one 0001 installed.
--- It appears unable to match a generated-column expression against its own
--- snapshot, so it proposes a rewrite every time.
---
--- Both statements are removed here, because on a catalog of millions of rows
--- that pair would:
---   1. rewrite the entire table for no change at all, and
---   2. drop `works_search_idx` with the column and never recreate it,
---      leaving search working but sequential-scanning the whole catalog.
---
--- Check every future migration for this. There is a test asserting that no
--- migration after 0001 drops `search_vector`.

CREATE TABLE "pending_work_authors" (
	"work_key" text NOT NULL,
	"author_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_work_authors_work_key_author_key_pk" PRIMARY KEY("work_key","author_key")
);
--> statement-breakpoint
CREATE INDEX "pending_work_authors_author_idx" ON "pending_work_authors" USING btree ("author_key");
