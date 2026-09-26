// Copy for the sync-issues screen: what a dead-lettered write was, and why the
// server refused it (PRD §35.2 "surfaced to the user with a retry action").

import type { MutationAction, QueuedMutation } from './schema';

const ACTION_LABEL: Record<MutationAction, string> = {
  add_progress: 'Progress update',
  upsert_read: 'Reading status',
  finish_read: 'Finished book',
  dnf_read: 'Stopped reading',
  save_review: 'Review',
};

const REASON: Record<string, string> = {
  email_unverified: 'Verify your email address to post reviews. Then retry.',
  not_found: 'This book or read no longer exists in your library.',
  client_event_conflict: 'This update clashed with one already saved. Discard it and log it again.',
  owner_unknown: 'Saved by an earlier version of the app for an account we cannot identify.',
  unauthorized: 'Sign in again, then retry.',
};

export interface SyncIssue {
  id: string;
  label: string;
  reason: string;
  /** Retrying cannot help a row we cannot attribute to this account. */
  canRetry: boolean;
}

export function describeSyncIssue(m: Pick<QueuedMutation, 'id' | 'action' | 'error_code' | 'last_error' | 'user_id'>): SyncIssue {
  const reason = (m.error_code && REASON[m.error_code]) || m.last_error || 'The server did not accept this update.';
  return {
    id: m.id,
    label: ACTION_LABEL[m.action] ?? 'Update',
    reason,
    canRetry: m.user_id !== null && m.error_code !== 'owner_unknown',
  };
}
