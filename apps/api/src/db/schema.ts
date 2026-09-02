// Drizzle schema. Mirrors db/skeleton/001_skeleton.sql exactly.
//
// Phase -1 applies the SQL file via the Postgres container's init directory.
// This file is the typed view of it, and becomes the source of truth in FN-01
// when drizzle-kit takes over migrations.

import {
  pgTable, uuid, text, integer, boolean, timestamp, date, numeric, index, unique,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  username: text('username').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Opaque bearer tokens. Phase -1 only — real auth is a short JWT plus a
// rotating refresh token with family reuse detection (FN-63/64).
export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// The work/edition split is here from day one on purpose: it is the hardest
// thing in the schema to retrofit (PRD §7.2).
export const works = pgTable('works', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  authorName: text('author_name').notNull(),
  firstPublishYear: integer('first_publish_year'),
  olCoverId: integer('ol_cover_id'),          // an integer, never a URL
  logCount: integer('log_count').notNull().default(0),
}, (t) => [
  index('works_title_trgm_idx').on(t.title),
]);

export const editions = pgTable('editions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
  isbn13: text('isbn_13'),
  pageCount: integer('page_count'),
  format: text('format').notNull().default('paperback'),
  olCoverId: integer('ol_cover_id'),
}, (t) => [
  index('editions_work_idx').on(t.workId),
]);

// One row per reading ATTEMPT. A re-read is a new row, never an overwrite.
export const reads = pgTable('reads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workId: uuid('work_id').notNull().references(() => works.id),
  editionId: uuid('edition_id').references(() => editions.id),
  status: text('status').notNull(),           // want | reading | paused | finished | dnf
  attemptNo: integer('attempt_no').notNull().default(1),
  startedAt: date('started_at'),
  finishedAt: date('finished_at'),
  rating: numeric('rating', { precision: 2, scale: 1 }),   // NULLABLE by design
  hearted: boolean('hearted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('reads_user_work_attempt').on(t.userId, t.workId, t.attemptNo),
  index('reads_user_status_idx').on(t.userId, t.status, t.updatedAt),
]);

// APPEND-ONLY. No update, no delete except by cascade. Current position is
// always the latest row (PRD §8.3). client_event_id makes replay safe.
export const progressEvents = pgTable('progress_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  readId: uuid('read_id').notNull().references(() => reads.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  page: integer('page'),
  percent: numeric('percent', { precision: 5, scale: 2 }),
  minutes: integer('minutes'),
  clientEventId: uuid('client_event_id').notNull().unique(),
}, (t) => [
  index('progress_events_read_idx').on(t.readId, t.at),
]);

// Rate-limit counters live in Postgres, not in process memory.
//
// In-process counters are per-instance, so the moment a second API process
// exists behind the proxy your "10 login attempts a minute" silently becomes
// twenty. On auth endpoints that is a security weakening, not a tuning miss.
export const rateLimits = pgTable('rate_limits', {
  bucket: text('bucket').primaryKey(),        // e.g. "login:user@example.com"
  count: integer('count').notNull().default(0),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
});
