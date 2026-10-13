// The enforcement ladder (SO-42; PRD §27.3), as data.
//
// A moderator records the RULE a subject broke (PRD §27.5 "record the rule
// applied"); the ladder decides what that does, from how many standing
// strikes the owner already has under that rule. A strike stands until an
// appeal overturns it. Past the last step, the last step repeats.

export const RULES = ['spoilers', 'spam', 'harassment', 'hate_speech', 'fake_review', 'impersonation', 'vote_manipulation'] as const;
export type Rule = (typeof RULES)[number];

export const RULE_LABELS: Record<Rule, string> = {
  spoilers: 'Unmarked spoilers',
  spam: 'Spam',
  harassment: 'Harassment',
  hate_speech: 'Hate speech',
  fake_review: 'Fake or paid reviews',
  impersonation: 'Impersonation',
  vote_manipulation: 'Vote manipulation',
};

/** PRD §6.44: what a reporter picks. Not the same list as RULES: a moderator decides the rule. */
export const REPORT_REASONS = ['spam', 'harassment', 'hate_speech', 'spoilers', 'nsfw', 'copyright', 'fake_review', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const SUBJECT_TYPES = ['review', 'comment', 'user', 'shelf', 'work'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export interface Step {
  /** What happens to the reported thing. */
  content?: 'remove' | 'flag_spoilers';
  /** The notice says this is a warning. */
  warn?: true;
  suspendDays?: number;
  ban?: true;
  /** §27.3 spoilers, 3rd: the owner's reviews queue for this many days. */
  flagReviewsDays?: number;
  /** 'read': the reported review's rating; 'account': every rating of the owner. */
  excludeRatings?: 'read' | 'account';
}

/**
 * PRD §27.3, row by row. "Content flagged" for spoilers is the review marked
 * as containing spoilers (blurred), not removed.
 *
 * | Violation          | 1st                               | 2nd                    | 3rd                              |
 * | Unmarked spoilers  | Content flagged, user notified    | Warning                | Reviews auto-flagged for 30 days |
 * | Spam               | Content removed                   | 7-day posting susp.    | Ban                              |
 * | Harassment         | Content removed + warning         | 30-day suspension      | Ban                              |
 * | Hate speech        | Immediate removal + ban           | —                      | —                                |
 * | Fake/paid reviews  | Removed, ratings excluded         | Ban                    | —                                |
 * | Impersonation      | Profile reset + warning           | Ban                    | —                                |
 * | Vote manipulation  | Ratings excluded from aggregates  | Ban                    | —                                |
 *
 * The 2nd and 3rd spoiler steps flag the content too: a review with unmarked
 * spoilers is blurred whatever the count. Spam and harassment remove the
 * content at every step.
 */
export const LADDER: Record<Rule, readonly Step[]> = {
  spoilers: [
    { content: 'flag_spoilers' },
    { content: 'flag_spoilers', warn: true },
    { content: 'flag_spoilers', flagReviewsDays: 30 },
  ],
  spam: [{ content: 'remove' }, { content: 'remove', suspendDays: 7 }, { content: 'remove', ban: true }],
  harassment: [{ content: 'remove', warn: true }, { content: 'remove', suspendDays: 30 }, { content: 'remove', ban: true }],
  hate_speech: [{ content: 'remove', ban: true }],
  fake_review: [{ content: 'remove', excludeRatings: 'read' }, { content: 'remove', ban: true }],
  impersonation: [{ content: 'remove', warn: true }, { ban: true }],
  vote_manipulation: [{ excludeRatings: 'account' }, { ban: true }],
};

/** The step for an owner with `strikes` standing strikes under `rule` (0-based). */
export function stepFor(rule: Rule, strikes: number): { index: number; step: Step } {
  const steps = LADDER[rule];
  const index = Math.min(Math.max(0, strikes), steps.length - 1);
  return { index, step: steps[index]! };
}

/**
 * PRD §27.5 [LOCKED] "Read-only by default: the moderator role sees everything
 * and can act on content; only admin touches the catalog or user accounts."
 * So a step that suspends, bans, resets a profile or excludes an account's
 * ratings needs an admin. (§25.3 lists "suspend accounts" under moderator;
 * the locked section wins — DECISION in tasks.md.)
 */
export function needsAdmin(subject: SubjectType, step: Step): boolean {
  if (step.suspendDays || step.ban || step.excludeRatings === 'account') return true;
  return subject === 'user' && step.content !== undefined;
}

/** What the content effect means on this subject. */
export function contentEffect(subject: SubjectType, step: Step): 'hide' | 'flag_spoilers' | 'reset_profile' | null {
  if (!step.content) return null;
  if (subject === 'user') return 'reset_profile';
  if (subject === 'work') return null;
  if (step.content === 'flag_spoilers') return subject === 'review' ? 'flag_spoilers' : 'hide';
  return 'hide';
}

/** Can this rule be enforced on this subject at all? */
export function enforceable(subject: SubjectType, rule: Rule): boolean {
  if (subject === 'work') return false; // catalog reports: the catalog tools act, the report is resolved
  if (rule === 'fake_review') return subject === 'review';
  return true;
}

const SUBJECT_LABEL: Record<SubjectType, string> = {
  review: 'review',
  comment: 'comment',
  user: 'profile',
  shelf: 'shelf',
  work: 'book',
};

/** The words the owner reads in their notification and on the notice screen (PRD §27.6). */
export function describeStep(subject: SubjectType, rule: Rule, step: Step): { summary: string; consequences: string[] } {
  const what = SUBJECT_LABEL[subject];
  const out: string[] = [];
  const effect = contentEffect(subject, step);
  if (effect === 'hide') out.push(`Your ${what} was removed.`);
  if (effect === 'flag_spoilers') out.push(`Your ${what} is now marked as containing spoilers.`);
  if (effect === 'reset_profile') out.push('Your profile name, bio and photo were reset.');
  if (step.warn) out.push('This is a warning.');
  if (step.excludeRatings === 'read') out.push('Its rating no longer counts towards the book\'s average.');
  if (step.excludeRatings === 'account') out.push('Your ratings no longer count towards book averages.');
  if (step.flagReviewsDays) out.push(`Your new reviews will be checked by a moderator for ${step.flagReviewsDays} days.`);
  if (step.suspendDays) out.push(`You cannot post, comment or follow for ${step.suspendDays} days.`);
  if (step.ban) out.push('Your account is closed.');
  const label = RULE_LABELS[rule];
  return {
    summary: `A moderator applied our ${label} rule to your ${what}. ${out[0] ?? ''}`.trim(),
    consequences: out,
  };
}
