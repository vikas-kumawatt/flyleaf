// SQLite Schema for Offline Mirroring (SL-10, architecture.md §10).
//
// Mirrors server PostgreSQL tables:
// 1. `reads`: current status, attempt_no, ratings, cached book metadata.
// 2. `progress_events`: append-only stream of page/percent updates with client_event_id.
// 3. `mutation_queue`: persistent FIFO queue for offline writes, backoff, and dead-letters.

export interface LocalRead {
  id: string;
  user_id: string;
  work_id: string;
  status: string;
  attempt_no: number;
  rating: number | null;
  hearted: number; // 0 or 1
  visibility: string;
  title: string | null;
  author_name: string | null;
  cover_id: number | null;
  page: number | null;
  percent: number | null;
  page_count: number | null;
  synced: number; // 1 = clean, 0 = local write pending
  created_at: string;
  updated_at: string;
}

export interface LocalProgressEvent {
  id: string;
  read_id: string;
  at: string;
  page: number | null;
  percent: number | null;
  minutes: number | null;
  client_event_id: string;
  synced: number; // 1 = clean, 0 = pending sync
}

export type MutationAction = 'add_progress' | 'upsert_read';
export type MutationStatus = 'pending' | 'processing' | 'dead_letter';

export interface QueuedMutation {
  id: string;
  entity_type: 'read' | 'progress_event';
  entity_id: string;
  action: MutationAction;
  payload: string; // JSON
  client_event_id: string;
  attempts: number;
  last_error: string | null;
  status: MutationStatus;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  rating REAL,
  hearted INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  title TEXT,
  author_name TEXT,
  cover_id INTEGER,
  page INTEGER,
  percent REAL,
  page_count INTEGER,
  synced INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reads_user_status ON reads(user_id, status);
CREATE INDEX IF NOT EXISTS idx_reads_work ON reads(work_id);

CREATE TABLE IF NOT EXISTS progress_events (
  id TEXT PRIMARY KEY,
  read_id TEXT NOT NULL,
  at TEXT NOT NULL,
  page INTEGER,
  percent REAL,
  minutes INTEGER,
  client_event_id TEXT NOT NULL UNIQUE,
  synced INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (read_id) REFERENCES reads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_events_read ON progress_events(read_id, at);
CREATE INDEX IF NOT EXISTS idx_progress_events_client_id ON progress_events(client_event_id);

CREATE TABLE IF NOT EXISTS mutation_queue (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  client_event_id TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_status_retry ON mutation_queue(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_queue_entity ON mutation_queue(entity_id, created_at);
`;
