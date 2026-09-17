CREATE TABLE "dedupe_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survivor_id" uuid NOT NULL,
	"loser_id" uuid NOT NULL,
	"stage" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confidence" real,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"dismiss_reason" text,
	CONSTRAINT "dedupe_queue_stage_ck" CHECK ("dedupe_queue"."stage" IN (3, 4)),
	CONSTRAINT "dedupe_queue_status_ck" CHECK ("dedupe_queue"."status" IN ('pending', 'merged', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "dedupe_queue" ADD CONSTRAINT "dedupe_queue_survivor_id_works_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dedupe_queue" ADD CONSTRAINT "dedupe_queue_loser_id_works_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dedupe_queue" ADD CONSTRAINT "dedupe_queue_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "dedupe_queue_pending_pair_idx" ON "dedupe_queue" USING btree ("survivor_id", "loser_id") WHERE "dedupe_queue"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "dedupe_queue_status_stage_idx" ON "dedupe_queue" USING btree ("status", "stage");
--> statement-breakpoint
CREATE INDEX "dedupe_queue_created_at_idx" ON "dedupe_queue" USING btree ("created_at");
