CREATE TABLE "work_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survivor_id" uuid NOT NULL,
	"loser_id" uuid NOT NULL,
	"stage" smallint NOT NULL,
	"reason" text NOT NULL,
	"moved" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "work_merges_stage_ck" CHECK ("work_merges"."stage" BETWEEN 1 AND 4)
);
--> statement-breakpoint
ALTER TABLE "work_merges" ADD CONSTRAINT "work_merges_survivor_id_works_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_merges" ADD CONSTRAINT "work_merges_loser_id_works_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_merges_loser_live_idx" ON "work_merges" USING btree ("loser_id") WHERE "work_merges"."undone_at" IS NULL;--> statement-breakpoint
CREATE INDEX "work_merges_survivor_idx" ON "work_merges" USING btree ("survivor_id");--> statement-breakpoint
CREATE INDEX "work_merges_at_idx" ON "work_merges" USING btree ("merged_at");