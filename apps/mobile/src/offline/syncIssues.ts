// Copy for the sync-issues screen: what a dead-lettered write was, and why the
// server refused it (PRD §35.2 "surfaced to the user with a retry action").

import type { MutationAction, QueuedMutation } from './schema';

const ACTION_LABEL: Record<MutationAction, string> = {
  add_progress: 'Progress update',
  upsert_read: 'Reading status',
  finish_read: 'Finished book',
  dnf_read: 'Stopped reading',
  save_review: 'Review',
  set_like: 'Like',
  set_follow: 'Follow',
};

/** An unlike or unfollow is labelled as what it was. */
function label(m: Pick<QueuedMutation, 'action' | 'payload'>): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(m.payload);
  } catch {
    // A row we cannot read is still listed, under its action.
  }
  if (m.action === 'set_like' && payload.liked === false) return 'Unlike';
  if (m.action === 'set_follow' && payload.following === false) return 'Unfollow';
  return ACTION_LABEL[m.action] ?? 'Update';
}

/** Codes that mean a different thing for each kind of write. */
const REASON_FOR: Partial<Record<MutationAction, Record<string, string>>> = {
  set_like: { not_found: 'This read is no longer available.' },
  set_follow: {
    not_found: 'This account is no longer available.',
    email_unverified: 'Verify your email address to follow people. Then retry.',
  },
};

const REASON: Record<string, string> = {
  email_unverified: 'Verify your email address to post reviews. Then retry.',
  not_found: 'This book or read no longer exists in your library.',
  client_event_conflict: 'This update clashed with one already saved. Discard it and log it again.',
  owner_unknown: 'Saved by an earlier version of the app for an account we cannot identify.',
  unauthorized: 'Sign in again, then retry.',
  not_likeable: 'Only finished or stopped reads can be liked.',
};

export interface SyncIssue {
  id: string;
  label: string;
  reason: string;
  /** Retrying cannot help a row we cannot attribute to this account. */
  canRetry: boolean;
}

export function describeSyncIssue(
  m: Pick<QueuedMutation, 'id' | 'action' | 'payload' | 'error_code' | 'last_error' | 'user_id'>,
): SyncIssue {
  const specific = m.error_code ? REASON_FOR[m.action]?.[m.error_code] : undefined;
  const reason = specific || (m.error_code && REASON[m.error_code]) || m.last_error || 'The server did not accept this update.';
  return {
    id: m.id,
    label: label(m),
    reason,
    canRetry: m.user_id !== null && m.error_code !== 'owner_unknown',
  };
}
