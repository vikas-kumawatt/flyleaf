// The schema. THIS FILE IS THE SOURCE OF TRUTH (FN-02).
//
// Nothing hand-writes SQL against the database any more. `drizzle-kit
// generate` diffs this file and emits a migration; `npm run migrate` applies
// it. The Phase -1 arrangement -- a .sql file mounted into the Postgres
// container's init directory -- is gone, because it only ever ran on an EMPTY
// volume, which meant every schema change was a `docker compose down -v` and
// the loss of all local data.
//
// Two things cannot live here and are applied by `migrate.ts` before the
// journal runs: CREATE EXTENSION, and the immutable unaccent wrapper that the
// generated search column depends on. See the comment there.

import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, check, customType, date, index, integer, jsonb, numeric,
  pgTable, primaryKey, real, smallint, text, timestamp, unique, uniqueIndex, uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Drizzle has no tsvector type. The column is GENERATED, so nothing in the
// application ever writes it; it exists here only so migrations know about it.
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

// ---------------------------------------------------------------------------
// 1. Catalog (architecture.md §3.1)
//
// Ingested from Open Library. Read-only to users; written by ingest,
// corrections and admin.
// ---------------------------------------------------------------------------

export const works = pgTable('works', {
  id: uuid('id').primaryKey().defaultRandom(),
  olWorkKey: text('ol_work_key').unique(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  description: text('description'),

  // Alternate and translated titles, straight from the OL record.
  //
  // This is the fix for the "1984 finds nothing" gap: the work is titled
  // Nineteen Eighty-Four, and no amount of fuzzy matching gets you from one
  // to the other. It is a DATA problem, so it needs a data column. Also
  // where an admin correction puts "LOTR" or "Hitchhiker's".
  alternateTitles: text('alternate_titles').array().notNull().default(sql`'{}'::text[]`),

  firstPublishYear: integer('first_publish_year'),
  originalLanguage: text('original_language'),
  defaultEditionId: uuid('default_edition_id'),

  // Representative cover, denormalised onto the work.
  //
  // Covers belong to editions (§3.1) and that stays true. But OL's WORK
  // records carry a cover list of their own, so a works-only ingest would
  // otherwise produce a catalog with no cover art at all -- and covers are
  // most of what this product looks like. It also removes a correlated
  // subquery from every search row.
  //
  // Precedence: the work's own OL cover, else the newest edition's.
  olCoverId: integer('ol_cover_id'),

  // Classified AT INGEST, never bolted on later (FN-24). App Store §1.2 risk:
  // an unclassified catalog is an unshippable one.
  maturity: text('maturity').notNull().default('unclassified'),

  // A work created by a user because search missed. Never enters the ranked
  // surfaces until an admin promotes it.
  isProvisional: boolean('is_provisional').notNull().default(false),
  createdByUserId: uuid('created_by_user_id'),
  mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => works.id),

  // Denormalised, drives search ranking. Trigger + nightly reconciliation.
  logCount: integer('log_count').notNull().default(0),

  // GENERATED. `simple`, not `english`: stemming damages proper nouns, and
  // book search is overwhelmingly proper nouns (§14.2).
  searchVector: tsvector('search_vector').generatedAlwaysAs(
    sql`setweight(to_tsvector('simple', flyleaf_unaccent(coalesce(title,''))),    'A') ||
        setweight(to_tsvector('simple', flyleaf_unaccent(coalesce(subtitle,''))), 'B') ||
        setweight(to_tsvector('simple', flyleaf_unaccent_array(alternate_titles)), 'C')`,
  ),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('works_maturity_ck', sql`${t.maturity} IN ('general','mature','explicit','unclassified')`),
  index('works_search_idx').using('gin', t.searchVector),
  index('works_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  index('works_log_count_idx').on(t.logCount),
]);

export const editions = pgTable('editions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
  olEditionKey: text('ol_edition_key').unique(),
  isbn13: text('isbn_13'),
  isbn10: text('isbn_10'),
  title: text('title'),
  publisher: text('publisher'),
  publishDateRaw: text('publish_date_raw'),   // OL dates are frequently partial
  publishYear: integer('publish_year'),
  pageCount: integer('page_count'),
  format: text('format').notNull().default('unknown'),
  language: text('language').notNull().default('en'),
  audioSeconds: integer('audio_seconds'),
  olCoverId: integer('ol_cover_id'),          // INTEGER, never a URL (§40.3)
  isBoxSet: boolean('is_box_set').notNull().default(false),
}, (t) => [
  check('editions_format_ck',
    sql`${t.format} IN ('hardcover','paperback','ebook','audiobook','unknown')`),
  index('editions_work_idx').on(t.workId),
  index('editions_isbn13_idx').on(t.isbn13),
  index('editions_isbn10_idx').on(t.isbn10),
]);

export const authors = pgTable('authors', {
  id: uuid('id').primaryKey().defaultRandom(),
  olAuthorKey: text('ol_author_key').unique(),
  name: text('name').notNull(),

  /**
   * Every other name this author is known by, from Open Library.
   *
   * Not decoration. Open Library files Haruki Murakami's novels under an
   * author record literally named 村上春樹, so `name ILIKE '%murakami%'` is
   * false and *Norwegian Wood* — 1,351 logs — was unreachable by searching
   * its author. `sort_name` is empty on that record. The aliases are the only
   * bridge, and OL populates them well: Tolkien has ten, Roald Dahl includes
   * ロアルド・ダール.
   *
   * Matched through `flyleaf_author_names(name, alternate_names)`, which has
   * its own trigram index. The query must call that exact function or the
   * index will not be used.
   */
  alternateNames: text('alternate_names').array().notNull().default(sql`'{}'::text[]`),

  sortName: text('sort_name'),
  bio: text('bio'),
  olPhotoId: integer('ol_photo_id'),
  birthYear: integer('birth_year'),
  deathYear: integer('death_year'),
  disambiguation: text('disambiguation'),
}, (t) => [
  // Author names are searched by joining through this index rather than being
  // denormalised into works.search_vector, so renaming an author does not
  // require reindexing every one of their works (§3.8).
  index('authors_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
]);

export const workAuthors = pgTable('work_authors', {
  workId: uuid('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => authors.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('author'),
  position: integer('position').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.workId, t.authorId, t.role] }),
  check('work_authors_role_ck',
    sql`${t.role} IN ('author','co_author','translator','illustrator','narrator','editor')`),
  index('work_authors_author_idx').on(t.authorId),
]);

/**
 * Authorship links whose author has not been ingested yet.
 *
 * This exists to remove an ordering constraint that was a genuine footgun:
 * `work_authors` joins works to authors by OL key, so a work ingested before
 * its author silently lost its authorship, and the only defence was "run the
 * authors dump first" written in a comment. That means waiting out ~17
 * million author records before you can load a single book.
 *
 * Now the unresolved pairs are parked here instead, and `--finalise`
 * resolves whatever has since become resolvable. Order stops mattering, and
 * a link can never be lost in silence -- it is either in `work_authors` or
 * visibly still sitting in this table.
 */
export const pendingWorkAuthors = pgTable('pending_work_authors', {
  workKey: text('work_key').notNull(),
  authorKey: text('author_key').notNull(),
  position: integer('position').notNull().default(0),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.workKey, t.authorKey] }),
  index('pending_work_authors_author_idx').on(t.authorKey),
]);

export const series = pgTable('series', {
  id: uuid('id').primaryKey().defaultRandom(),
  olKey: text('ol_key').unique(),
  name: text('name').notNull(),
});

export const seriesEntries = pgTable('series_entries', {
  seriesId: uuid('series_id').notNull().references(() => series.id, { onDelete: 'cascade' }),
  workId: uuid('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
  // numeric, not int, so a 2.5 novella sorts where it belongs.
  position: numeric('position', { precision: 5, scale: 2 }),
}, (t) => [
  primaryKey({ columns: [t.seriesId, t.workId] }),
]);

export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
}, (t) => [
  // 'noise' is a real classification, not a placeholder: Open Library
  // subjects include a great deal of shelving cruft that must be kept and
  // ignored rather than dropped, or every re-ingest rediscovers it.
  check('subjects_kind_ck',
    sql`${t.kind} IN ('genre','theme','place','time_period','character','noise')`),
]);

export const workSubjects = pgTable('work_subjects', {
  workId: uuid('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  weight: real('weight').notNull().default(1.0),
}, (t) => [
  primaryKey({ columns: [t.workId, t.subjectId] }),
]);

export const workStats = pgTable('work_stats', {
  workId: uuid('work_id').primaryKey().references(() => works.id, { onDelete: 'cascade' }),
  ratingSum: numeric('rating_sum', { precision: 12, scale: 1 }).notNull().default('0'),
  ratingCount: bigint('rating_count', { mode: 'number' }).notNull().default(0),
  avgRating: numeric('avg_rating', { precision: 3, scale: 2 }),        // raw mean, for display
  weightedRating: numeric('weighted_rating', { precision: 3, scale: 2 }), // Bayesian, for ranking (§9.5)
  heartCount: bigint('heart_count', { mode: 'number' }).notNull().default(0),
  readCount: bigint('read_count', { mode: 'number' }).notNull().default(0),
  dnfCount: bigint('dnf_count', { mode: 'number' }).notNull().default(0),
  polarisation: real('polarisation'),   // stddev of ratings (§9.6)
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 2. Provenance and raw payloads (architecture.md §3.2, PRD §7.9 / §41)
// ---------------------------------------------------------------------------

export const externalIds = pgTable('external_ids', {
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.provider, t.externalId, t.entityType] }),
  check('external_ids_entity_type_ck',
    sql`${t.entityType} IN ('work','edition','author','series')`),
  // google_books IS allowed here: recording that an ID was SEEN is not
  // caching their data. What may not be stored is the data itself.
  check('external_ids_provider_ck',
    sql`${t.provider} IN ('open_library','google_books','isbndb','user')`),
  index('external_ids_entity_idx').on(t.entityType, t.entityId),
]);

/**
 * Which provider each individual field came from.
 *
 * The `provider` CHECK below deliberately OMITS 'google_books'. That single
 * constraint is what makes the §41 licensing rule structural rather than a
 * promise in a document: Google Books results may be shown live but never
 * persisted, and there is consequently no legal way for a stored field to
 * claim them as its source. A future migration that "tidies up" the two
 * provider lists into one shared enum would silently delete that guarantee.
 *
 * DO NOT ADD google_books. There is a test that fails if you do.
 */
export const fieldProvenance = pgTable('field_provenance', {
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  fieldName: text('field_name').notNull(),
  provider: text('provider').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  confidence: smallint('confidence').notNull().default(50),
  isLocked: boolean('is_locked').notNull().default(false),   // true for user corrections
}, (t) => [
  primaryKey({ columns: [t.entityType, t.entityId, t.fieldName] }),
  check('field_provenance_provider_ck',
    sql`${t.provider} IN ('open_library','isbndb','user')`),
  check('field_provenance_confidence_ck', sql`${t.confidence} BETWEEN 0 AND 100`),
]);

/**
 * The untouched provider response, kept so that normalisation and maturity
 * classification stay RE-RUNNABLE. Without it, improving the classifier means
 * re-downloading 40 GB of dumps.
 *
 * Open Library only, and the CHECK says so as an equality rather than a list:
 * OL is CC0, so retention is unambiguous. Nothing else may be retained.
 */
export const rawPayloads = pgTable('raw_payloads', {
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  entityType: text('entity_type').notNull(),
  payload: jsonb('payload').notNull(),
  payloadHash: text('payload_hash').notNull(),   // skip the write when unchanged (FN-25)
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.provider, t.externalId, t.entityType] }),
  check('raw_payloads_provider_ck', sql`${t.provider} = 'open_library'`),
]);

// ---------------------------------------------------------------------------
// 3. Identity (architecture.md §3.3, FN-60)
//
// Users, profiles, and rotating refresh tokens with family reuse detection.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  passwordHash: text('password_hash').notNull(),
  dateOfBirth: date('date_of_birth').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  check('users_role_ck', sql`${t.role} IN ('user','moderator','admin')`),
]);

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  bio: text('bio'),
  avatarKey: text('avatar_key'),
  isPrivate: boolean('is_private').notNull().default(false),
  favouriteWorkIds: uuid('favourite_work_ids').array().notNull().default(sql`'{}'::uuid[]`),
  librarySystems: jsonb('library_systems').notNull().default(sql`'[]'::jsonb`),
  showExplicit: boolean('show_explicit').notNull().default(false),
  followerCount: integer('follower_count').notNull().default(0),
  followingCount: integer('following_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('profiles_bio_length_ck', sql`char_length(${t.bio}) <= 160`),
  check('profiles_favs_length_ck', sql`array_length(${t.favouriteWorkIds}, 1) IS NULL OR array_length(${t.favouriteWorkIds}, 1) <= 4`),
]);

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  familyId: uuid('family_id').notNull(),
  device: text('device'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('refresh_tokens_hash_idx').on(t.tokenHash),
  index('refresh_tokens_family_idx').on(t.familyId),
]);

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('email_verification_tokens_hash_idx').on(t.tokenHash),
  index('email_verification_tokens_user_idx').on(t.userId),
]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('password_reset_tokens_hash_idx').on(t.tokenHash),
  index('password_reset_tokens_user_idx').on(t.userId),
]);

// ---------------------------------------------------------------------------
// 4. Reading
//
// Verified on a physical device in Phase -1 and unchanged by this migration.
// ---------------------------------------------------------------------------

/** One row per reading ATTEMPT. A re-read is a new row, never an overwrite. */
export const reads = pgTable('reads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workId: uuid('work_id').notNull().references(() => works.id),
  editionId: uuid('edition_id').references(() => editions.id),
  status: text('status').notNull(),
  attemptNo: integer('attempt_no').notNull().default(1),
  startedAt: date('started_at'),
  finishedAt: date('finished_at'),
  rating: numeric('rating', { precision: 2, scale: 1 }),   // NULLABLE by design
  hearted: boolean('hearted').notNull().default(false),
  visibility: text('visibility').notNull().default('public'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('reads_user_work_attempt').on(t.userId, t.workId, t.attemptNo),
  check('reads_status_ck', sql`${t.status} IN ('want','reading','paused','finished','dnf')`),
  check('reads_visibility_ck', sql`${t.visibility} IN ('public','followers','private')`),
  // Half stars, and only half stars. Enforced in the database because the API
  // is not the only thing that will ever write here (imports, admin, backfill).
  check('reads_rating_ck',
    sql`${t.rating} IS NULL OR (${t.rating} BETWEEN 0.5 AND 5.0 AND (${t.rating} * 2) = floor(${t.rating} * 2))`),
  check('reads_dates_ck',
    sql`${t.finishedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.finishedAt} >= ${t.startedAt}`),
  index('reads_user_status_idx').on(t.userId, t.status, t.updatedAt),
  index('reads_user_visibility_idx').on(t.userId, t.visibility, t.status, t.updatedAt),
]);

/** APPEND-ONLY. Current position is always the latest row (PRD §8.3). */
export const progressEvents = pgTable('progress_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  readId: uuid('read_id').notNull().references(() => reads.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  page: integer('page'),
  percent: numeric('percent', { precision: 5, scale: 2 }),
  minutes: integer('minutes'),
  // The entire offline story in one column. Replay is safe.
  clientEventId: uuid('client_event_id').notNull().unique(),
}, (t) => [
  index('progress_events_read_idx').on(t.readId, t.at),
]);

// ---------------------------------------------------------------------------
// 5. Platform
// ---------------------------------------------------------------------------

/**
 * Rate-limit counters, in Postgres rather than process memory.
 *
 * In-process counters are per-instance, so the moment a second API process
 * exists behind the proxy, "10 login attempts a minute" silently becomes
 * twenty. On auth endpoints that is a security weakening, not a tuning miss.
 */
export const rateLimits = pgTable('rate_limits', {
  bucket: text('bucket').primaryKey(),
  count: integer('count').notNull().default(0),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ingest checkpoints (FN-20).
 *
 * A 45 GB stream WILL be interrupted -- a laptop sleeps, the wifi drops, you
 * hit Ctrl+C to go to lunch. Without a checkpoint the only option is to start
 * again, and after the second time that happens the ingest never finishes.
 *
 * The checkpoint is a LINE COUNT rather than a byte offset, because you
 * cannot seek into the middle of a gzip member. Resuming re-decompresses from
 * the start and skips lines without parsing them, which is cheap: gunzip runs
 * far faster than JSON.parse plus a database write.
 */
export const ingestRuns = pgTable('ingest_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  dumpType: text('dump_type').notNull(),        // authors | works | editions
  sourceFile: text('source_file').notNull(),
  fileSize: bigint('file_size', { mode: 'number' }),
  linesRead: bigint('lines_read', { mode: 'number' }).notNull().default(0),
  rowsWritten: bigint('rows_written', { mode: 'number' }).notNull().default(0),
  rowsSkipped: bigint('rows_skipped', { mode: 'number' }).notNull().default(0),
  status: text('status').notNull().default('running'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  check('ingest_runs_type_ck', sql`${t.dumpType} IN ('authors','works','editions')`),
  check('ingest_runs_status_ck',
    sql`${t.status} IN ('running','done','failed','interrupted')`),
  index('ingest_runs_resume_idx').on(t.dumpType, t.sourceFile, t.startedAt),
]);

/**
 * What a merge moved, so it can be undone (FN-50/51, PRD §40.3).
 *
 * PRD: "Merges are reversible for 30 days. A wrong merge destroys two books'
 * worth of ratings at once, so the operation records exactly what it moved."
 *
 * THIS TABLE IS WRITTEN BY THE MERGE ITSELF, not by the undo feature. Once a
 * merge has repointed rows and forgotten which ones it touched, the undo is
 * not deferred work -- it is impossible. `reads` is the reason: repointing a
 * read has to renumber `attempt_no` to satisfy `reads_user_work_attempt`, and
 * nothing in the resulting row remembers what the number used to be.
 *
 * `moved` holds the per-table counts and the read renumbering, as jsonb:
 *   { "reads": [{ "id": "...", "attempt_no": 1 }], "editions": 4, ... }
 * Counts for the tables whose repointing is reversible from the loser id
 * alone; explicit rows only where it is not.
 */
export const workMerges = pgTable('work_merges', {
  id: uuid('id').primaryKey().defaultRandom(),
  survivorId: uuid('survivor_id').notNull().references(() => works.id),
  loserId: uuid('loser_id').notNull().references(() => works.id),
  /** Which rule fired: 1 exact ISBN, 2 title+author, 3 fuzzy, 4 reported. */
  stage: smallint('stage').notNull(),
  reason: text('reason').notNull(),
  moved: jsonb('moved').notNull().default(sql`'{}'::jsonb`),
  mergedAt: timestamp('merged_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when reversed. Kept, never deleted — the audit trail is the point. */
  undoneAt: timestamp('undone_at', { withTimezone: true }),
}, (t) => [
  check('work_merges_stage_ck', sql`${t.stage} BETWEEN 1 AND 4`),
  // A work is merged away once. Merging it again would mean it had come back.
  uniqueIndex('work_merges_loser_live_idx').on(t.loserId).where(sql`${t.undoneAt} IS NULL`),
  index('work_merges_survivor_idx').on(t.survivorId),
  index('work_merges_at_idx').on(t.mergedAt),
]);

/**
 * Dedupe review queue (FN-51, PRD §40.3).
 *
 * Stores Stage 3 (probable fuzzy duplicates) and Stage 4 (user-reported
 * duplicates) awaiting review by an admin. Merging or dismissing records
 * review state and audit info.
 */
export const dedupeQueue = pgTable('dedupe_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  survivorId: uuid('survivor_id').notNull().references(() => works.id),
  loserId: uuid('loser_id').notNull().references(() => works.id),
  stage: smallint('stage').notNull(),
  status: text('status').notNull().default('pending'),
  confidence: real('confidence'),
  reason: text('reason').notNull(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  dismissReason: text('dismiss_reason'),
}, (t) => [
  check('dedupe_queue_stage_ck', sql`${t.stage} IN (3, 4)`),
  check('dedupe_queue_status_ck', sql`${t.status} IN ('pending', 'merged', 'dismissed')`),
  uniqueIndex('dedupe_queue_pending_pair_idx').on(t.survivorId, t.loserId).where(sql`${t.status} = 'pending'`),
  index('dedupe_queue_status_stage_idx').on(t.status, t.stage),
  index('dedupe_queue_created_at_idx').on(t.createdAt),
]);

// ---------------------------------------------------------------------------
// 7. Admin & Audit (FN-90, FN-93, PRD §27.5, Architecture §3.7)
// ---------------------------------------------------------------------------

/**
 * Admin credentials & 2FA state (FN-90, PRD §27.5).
 *
 * Dedicated admin credentials separate from standard mobile app sessions.
 * Holds the TOTP secret, verification flag, and one-time recovery backup codes.
 */
export const adminCredentials = pgTable('admin_credentials', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  totpSecret: text('totp_secret').notNull(),
  totpVerified: boolean('totp_verified').notNull().default(false),
  backupCodes: text('backup_codes').array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Admin audit log (FN-93, Architecture §3.7, PRD §27.5).
 *
 * Non-negotiable audit trail of every moderation, catalog edit, merge, undo,
 * or administrative action. Records actor, action, target entity, reason, and payload.
 */
export const adminAuditLog = pgTable('admin_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  subjectType: text('subject_type'),
  subjectId: uuid('subject_id'),
  reason: text('reason'),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('admin_audit_log_actor_idx').on(t.actorId, t.createdAt),
  index('admin_audit_log_action_idx').on(t.action, t.createdAt),
  index('admin_audit_log_subject_idx').on(t.subjectType, t.subjectId),
]);

