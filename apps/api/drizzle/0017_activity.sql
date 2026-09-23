CREATE TABLE IF NOT EXISTS "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"verb" text NOT NULL,
	"work_id" uuid,
	"object_type" text,
	"object_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "activity_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "activity_verb_ck" CHECK ("verb" IN ('started','finished','rated','reviewed','dnf','shelved','followed','goal_reached','quoted')),
	CONSTRAINT "activity_visibility_ck" CHECK ("visibility" IN ('public','followers','private'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_actor_idx" ON "activity" ("actor_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_visibility_idx" ON "activity" ("visibility", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_work_idx" ON "activity" ("work_id", "created_at" DESC);
