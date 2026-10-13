// Reporting and moderation notices (SO-40, SO-42; PRD §6.44, §27.6).
//
// Pure: no React Native imports, so the node test runner covers it.

import type { ReportReason, ReportSubjectType } from '@flyleaf/api-client';

/** PRD §6.44's reason picker, in its order. */
export const REPORT_REASONS: { key: ReportReason; label: string }[] = [
  { key: 'spam', label: 'Spam' },
  { key: 'harassment', label: 'Harassment' },
  { key: 'hate_speech', label: 'Hate speech' },
  { key: 'spoilers', label: 'Spoilers unmarked' },
  { key: 'nsfw', label: 'NSFW' },
  { key: 'copyright', label: 'Copyright' },
  { key: 'fake_review', label: 'Fake review' },
  { key: 'other', label: 'Other' },
];

/** Reasons that make sense for each surface: "Fake review" only on a review, "Spoilers" not on a profile. */
export function reasonsFor(subject: ReportSubjectType): { key: ReportReason; label: string }[] {
  return REPORT_REASONS.filter((r) => {
    if (r.key === 'fake_review') return subject === 'review';
    if (r.key === 'spoilers') return subject === 'review' || subject === 'comment';
    return true;
  });
}

export const REPORT_DETAIL_MAX = 1000;

const NOUN: Record<ReportSubjectType, string> = {
  review: 'review',
  comment: 'comment',
  user: 'profile',
  shelf: 'shelf',
  work: 'book',
};

export function reportTitle(subject: ReportSubjectType): string {
  return `Report ${NOUN[subject]}`;
}

/**
 * PRD §6.44: confirm, give the expected response window, never promise an
 * outcome. The window is the owner's decision on SO-4x (13 Oct 2026):
 * "We usually review reports within 2 days."
 */
export const REPORT_RESPONSE_WINDOW = 'We usually review reports within 2 days.';

export function reportConfirmation(): string {
  return `Thanks. ${REPORT_RESPONSE_WINDOW} You can see its status in Settings → Your reports; we never share what happens to someone else's account.`;
}

/** Reader-facing copy for every refusal POST /reports can give. */
export function reportErrorMessage(code: string | undefined, serverMessage?: string): string {
  switch (code) {
    case 'not_found':
      return 'This is no longer available.';
    case 'cannot_report_self':
      return 'You cannot report your own content.';
    case 'rate_limited':
      // Writes (per minute) or the report limits (5 an hour, 20 a day): the server says which.
      return serverMessage || 'You are doing that too quickly. Try again later.';
    default:
      return 'Could not send the report. Try again.';
  }
}

export const APPEAL_MAX = 2000;

/** What the notice screen says about the appeal. */
export function appealStatus(notice: { can_appeal: boolean; reversed: boolean; appeal: { state: 'pending' | 'upheld' | 'overturned' } | null }): string {
  if (notice.appeal?.state === 'pending') return 'Your appeal is with a moderator.';
  if (notice.appeal?.state === 'upheld') return 'Your appeal was reviewed. The decision stands.';
  if (notice.appeal?.state === 'overturned' || notice.reversed) return 'This decision was reversed.';
  if (notice.can_appeal) return 'If you think this is wrong, you can appeal once. A person reviews every appeal.';
  return '';
}

/** Reader-facing copy for the moderation refusals any write can now give (layer 1, suspension). */
export function moderationRefusal(code: string | undefined, message?: string): string | null {
  switch (code) {
    case 'content_rejected':
    case 'links_not_allowed_yet':
    case 'too_many_links':
    case 'account_suspended':
      return message ?? 'This cannot be posted.';
    case 'review_removed':
      return 'A moderator removed this review. You can appeal from the notice in your notifications.';
    default:
      return null;
  }
}
