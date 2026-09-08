CREATE TABLE "authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ol_author_key" text,
	"name" text NOT NULL,
	"sort_name" text,
	"bio" text,
	"ol_photo_id" integer,
	"birth_year" integer,
	"death_year" integer,
	"disambiguation" text,
	CONSTRAINT "authors_ol_author_key_unique" UNIQUE("ol_author_key")
);
--> statement-breakpoint
CREATE TABLE "editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"ol_edition_key" text,
	"isbn_13" text,
	"isbn_10" text,
	"title" text,
	"publisher" text,
	"publish_date_raw" text,
	"publish_year" integer,
	"page_count" integer,
	"format" text DEFAULT 'unknown' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"audio_seconds" integer,
	"ol_cover_id" integer,
	"is_box_set" boolean DEFAULT false NOT NULL,
	CONSTRAINT "editions_ol_edition_key_unique" UNIQUE("ol_edition_key"),
	CONSTRAINT "editions_format_ck" CHECK ("editions"."format" IN ('hardcover','paperback','ebook','audiobook','unknown'))
);
--> statement-breakpoint
CREATE TABLE "external_ids" (
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ids_provider_external_id_entity_type_pk" PRIMARY KEY("provider","external_id","entity_type"),
	CONSTRAINT "external_ids_entity_type_ck" CHECK ("external_ids"."entity_type" IN ('work','edition','author','series')),
	CONSTRAINT "external_ids_provider_ck" CHECK ("external_ids"."provider" IN ('open_library','google_books','isbndb','user'))
);
--> statement-breakpoint
CREATE TABLE "field_provenance" (
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"provider" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" smallint DEFAULT 50 NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "field_provenance_entity_type_entity_id_field_name_pk" PRIMARY KEY("entity_type","entity_id","field_name"),
	CONSTRAINT "field_provenance_provider_ck" CHECK ("field_provenance"."provider" IN ('open_library','isbndb','user')),
	CONSTRAINT "field_provenance_confidence_ck" CHECK ("field_provenance"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "progress_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"read_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"page" integer,
	"percent" numeric(5, 2),
	"minutes" integer,
	"client_event_id" uuid NOT NULL,
	CONSTRAINT "progress_events_client_event_id_unique" UNIQUE("client_event_id")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "raw_payloads_provider_external_id_entity_type_pk" PRIMARY KEY("provider","external_id","entity_type"),
	CONSTRAINT "raw_payloads_provider_ck" CHECK ("raw_payloads"."provider" = 'open_library')
);
--> statement-breakpoint
CREATE TABLE "reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"edition_id" uuid,
	"status" text NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"started_at" date,
	"finished_at" date,
	"rating" numeric(2, 1),
	"hearted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reads_user_work_attempt" UNIQUE("user_id","work_id","attempt_no"),
	CONSTRAINT "reads_status_ck" CHECK ("reads"."status" IN ('want','reading','paused','finished','dnf')),
	CONSTRAINT "reads_rating_ck" CHECK ("reads"."rating" IS NULL OR ("reads"."rating" BETWEEN 0.5 AND 5.0 AND ("reads"."rating" * 2) = floor("reads"."rating" * 2))),
	CONSTRAINT "reads_dates_ck" CHECK ("reads"."finished_at" IS NULL OR "reads"."started_at" IS NULL OR "reads"."finished_at" >= "reads"."started_at")
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ol_key" text,
	"name" text NOT NULL,
	CONSTRAINT "series_ol_key_unique" UNIQUE("ol_key")
);
--> statement-breakpoint
CREATE TABLE "series_entries" (
	"series_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"position" numeric(5, 2),
	CONSTRAINT "series_entries_series_id_work_id_pk" PRIMARY KEY("series_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "subjects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "subjects_kind_ck" CHECK ("subjects"."kind" IN ('genre','theme','place','time_period','character','noise'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "work_authors" (
	"work_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"role" text DEFAULT 'author' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "work_authors_work_id_author_id_role_pk" PRIMARY KEY("work_id","author_id","role"),
	CONSTRAINT "work_authors_role_ck" CHECK ("work_authors"."role" IN ('author','co_author','translator','illustrator','narrator','editor'))
);
--> statement-breakpoint
CREATE TABLE "work_stats" (
	"work_id" uuid PRIMARY KEY NOT NULL,
	"rating_sum" numeric(12, 1) DEFAULT '0' NOT NULL,
	"rating_count" bigint DEFAULT 0 NOT NULL,
	"avg_rating" numeric(3, 2),
	"weighted_rating" numeric(3, 2),
	"heart_count" bigint DEFAULT 0 NOT NULL,
	"read_count" bigint DEFAULT 0 NOT NULL,
	"dnf_count" bigint DEFAULT 0 NOT NULL,
	"polarisation" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_subjects" (
	"work_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	CONSTRAINT "work_subjects_work_id_subject_id_pk" PRIMARY KEY("work_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ol_work_key" text,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"first_publish_year" integer,
	"original_language" text,
	"default_edition_id" uuid,
	"maturity" text DEFAULT 'unclassified' NOT NULL,
	"is_provisional" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"merged_into_id" uuid,
	"log_count" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', flyleaf_unaccent(coalesce(title,''))),    'A') ||
        setweight(to_tsvector('simple', flyleaf_unaccent(coalesce(subtitle,''))), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "works_ol_work_key_unique" UNIQUE("ol_work_key"),
	CONSTRAINT "works_maturity_ck" CHECK ("works"."maturity" IN ('general','mature','explicit','unclassified'))
);
--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_read_id_reads_id_fk" FOREIGN KEY ("read_id") REFERENCES "public"."reads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reads" ADD CONSTRAINT "reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reads" ADD CONSTRAINT "reads_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reads" ADD CONSTRAINT "reads_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_entries" ADD CONSTRAINT "series_entries_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_entries" ADD CONSTRAINT "series_entries_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_authors" ADD CONSTRAINT "work_authors_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_authors" ADD CONSTRAINT "work_authors_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stats" ADD CONSTRAINT "work_stats_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_subjects" ADD CONSTRAINT "work_subjects_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_subjects" ADD CONSTRAINT "work_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_merged_into_id_works_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authors_name_trgm_idx" ON "authors" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "editions_work_idx" ON "editions" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "editions_isbn13_idx" ON "editions" USING btree ("isbn_13");--> statement-breakpoint
CREATE INDEX "editions_isbn10_idx" ON "editions" USING btree ("isbn_10");--> statement-breakpoint
CREATE INDEX "external_ids_entity_idx" ON "external_ids" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "progress_events_read_idx" ON "progress_events" USING btree ("read_id","at");--> statement-breakpoint
CREATE INDEX "reads_user_status_idx" ON "reads" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "work_authors_author_idx" ON "work_authors" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "works_title_trgm_idx" ON "works" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "works_log_count_idx" ON "works" USING btree ("log_count");