// Layer 1, automated (SO-41; PRD §27.2). Runs on every text a person
// publishes, inside the write's own transaction:
//
//   Slur and hate-term list   → blocked at submission, 422 `content_rejected`
//                               naming the field ("Block at submission with a
//                               clear reason").
//   Link rules                → no links from accounts under 7 days old (any
//                               surface), at most 2 links in a review: 422.
//   Duplicate content         → the same review text on 3+ works → an
//                               automated report (queued, never blocked).
//                               Across accounts (review rings, owner decision
//                               on SO-4x): the same text of 100+ characters
//                               from another account → queued, never blocked.
//   Spoiler flag (§27.3)      → an account on the third spoiler strike has its
//                               new and edited reviews queued for 30 days.
//   Rate limits               → PRD §24.4 / §10.6 / §11.7, in the shared layer
//                               (platform/rate-limits.ts); nothing here.
//   New-account restrictions  → no reviews, comments or follows before email
//                               verification: requireVerified (D-04-1).
//
// AI triage (P1) is not built. Nothing here ever deletes: suspect content
// queues for a person (§27.2 "never auto-deletes").

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { ApiError } from '../http.js';
import { BLOCKED_TERM_HASHES } from './terms.data.js';

/** PRD §27.2 Link rules: "No links for accounts under 7 days old". */
export const NEW_ACCOUNT_LINK_DAYS = 7;
/** PRD §27.2 Link rules: "max 2 links per review". */
export const MAX_REVIEW_LINKS = 2;
/** PRD §27.2 Duplicate content: "Same text posted on 3+ works → queue". */
export const DUPLICATE_WORKS = 3;
/**
 * Owner decision on SO-4x (13 Oct 2026): the same review text from different
 * accounts is queued (never blocked) when it is at least this long, counted in
 * characters after case and whitespace normalisation. Shorter texts ("Loved
 * it.", "A masterpiece") are common to many honest readers.
 */
export const CROSS_ACCOUNT_DUPLICATE_MIN_CHARS = 100;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Accents off, lower case, look-alikes mapped, runs of 3+ of a letter cut to 2. */
export function normaliseToken(t: string): string {
  return t
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET[c]!)
    .replace(/(\p{L})\1{2,}/gu, '$1$1');
}

export function hashTerm(term: string): string {
  return createHash('sha256').update('flyleaf-term:' + normaliseToken(term)).digest('hex').slice(0, 32);
}

/** The live list. Exported so a test can add a harmless stand-in term. */
export const blockedTerms: Set<string> = new Set(BLOCKED_TERM_HASHES);

/**
 * Whole-token match against the list. Tokens are letter runs after
 * normalisation; single letters spaced or dotted out ("x.y.z") are joined
 * back into one candidate; a trailing plural "s"/"es" is tried off too.
 */
export function containsBlockedTerm(text: string): boolean {
  if (!text || blockedTerms.size === 0) return false;
  // Twice: with look-alikes mapped ("gr1m") and without, so punctuation that
  // happens to be a look-alike ("word!", "$5") cannot hide a word either.
  const plain = text.replace(/[013457@$!]/g, ' ');
  return [text, plain].some((t) => matchTokens(normaliseToken(t).split(/[^\p{L}]+/u).filter(Boolean)));
}

function matchTokens(tokens: string[]): boolean {
  const candidates: string[] = [];
  let run = '';
  for (const t of tokens) {
    candidates.push(t);
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) candidates.push(run);
      run = '';
    }
  }
  if (run.length > 1) candidates.push(run);
  for (const c of candidates) {
    const forms = [c];
    if (c.length > 3 && c.endsWith('es')) forms.push(c.slice(0, -2));
    if (c.length > 2 && c.endsWith('s')) forms.push(c.slice(0, -1));
    for (const f of forms) if (blockedTerms.has(hashTerm(f))) return true;
  }
  return false;
}

/** A URL with a scheme, a www. host, or a bare host on a common TLD. */
const LINK_RE =
  /\b(?:https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|ly|me|xyz|top|ru|cn|app|link|site|online|shop|store)(?:\/[^\s<>()]*)?)(?=$|[\s<>().,!?;:'"])/gi;

export function countLinks(text: string): number {
  return (text.match(LINK_RE) ?? []).length;
}

export type Surface = 'review' | 'comment' | 'profile' | 'shelf';

export interface ScreenedField {
  field: string;
  text: string | null | undefined;
}

/**
 * Block-at-submission checks for one write. Throws the first refusal; the
 * write has not happened (call it before writing, inside the transaction).
 */
export async function screenText(db: Db, userId: string, surface: Surface, fields: ScreenedField[]): Promise<void> {
  const present = fields.filter((f): f is { field: string; text: string } => typeof f.text === 'string' && f.text.trim() !== '');
  if (present.length === 0) return;

  for (const f of present) {
    if (containsBlockedTerm(f.text)) {
      throw ApiError.unprocessable(
        'content_rejected',
        'This contains language that is not allowed on Flyleaf (hate speech or a slur). Edit it and try again.',
        f.field,
      );
    }
  }

  const links = present.map((f) => ({ field: f.field, n: countLinks(f.text) }));
  const withLinks = links.find((l) => l.n > 0);
  if (!withLinks) return;
  const [u] = await db.execute<{ young: boolean }>(sql`
    SELECT created_at > now() - make_interval(days => ${NEW_ACCOUNT_LINK_DAYS}) AS young FROM users WHERE id = ${userId}::uuid`);
  if (u?.young) {
    throw ApiError.unprocessable(
      'links_not_allowed_yet',
      `New accounts can post links after their first ${NEW_ACCOUNT_LINK_DAYS} days.`,
      withLinks.field,
    );
  }
  if (surface === 'review') {
    const over = links.find((l) => l.n > MAX_REVIEW_LINKS);
    if (over) {
      throw ApiError.unprocessable('too_many_links', `A review can contain at most ${MAX_REVIEW_LINKS} links.`, over.field);
    }
  }
}

export type AutoRule = 'duplicate_content' | 'duplicate_across_accounts' | 'flagged_account';

/** Queues an automated report (one open per rule per subject). Returns whether a new one was written. */
export async function queueAutomated(
  db: Db,
  r: {
    subjectType: 'review' | 'comment' | 'user' | 'shelf';
    subjectId: string;
    ownerId: string;
    autoRule: AutoRule;
    reason: 'spam' | 'spoilers' | 'fake_review';
    detail: string;
    snapshot: Record<string, unknown>;
  },
): Promise<boolean> {
  const rows = await db.execute(sql`
    INSERT INTO reports (source, auto_rule, subject_type, subject_id, subject_owner_id, reason, detail, snapshot)
    VALUES ('automated', ${r.autoRule}, ${r.subjectType}, ${r.subjectId}::uuid, ${r.ownerId}::uuid, ${r.reason},
      ${r.detail}, ${JSON.stringify(r.snapshot)}::jsonb)
    ON CONFLICT (subject_type, subject_id, auto_rule) WHERE state = 'open' AND source = 'automated' DO NOTHING
    RETURNING id`);
  return rows.length > 0;
}

/**
 * After a review is written (same transaction): the suspect checks that
 * queue rather than block. Duplicate content compares whitespace- and
 * case-normalised text across the author's own live reviews (PRD §27.2;
 * the index on reviews (user_id, published_at) bounds it to one author).
 */
export async function screenReviewWritten(
  db: Db,
  r: { reviewId: string; userId: string; workId: string; body: string },
): Promise<void> {
  const snapshot = { body: r.body, work_id: r.workId };
  const [dup] = await db.execute<{ works: number }>(sql`
    SELECT count(DISTINCT work_id)::int AS works FROM reviews
    WHERE user_id = ${r.userId}::uuid AND deleted_at IS NULL
      AND lower(regexp_replace(btrim(body), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(${r.body}::text), '\\s+', ' ', 'g'))`);
  if (Number(dup?.works ?? 0) >= DUPLICATE_WORKS) {
    await queueAutomated(db, {
      subjectType: 'review', subjectId: r.reviewId, ownerId: r.userId, autoRule: 'duplicate_content', reason: 'spam',
      detail: `The same text is on ${dup!.works} works by this reader.`, snapshot,
    });
  }
  // Review rings: the same text from other accounts. The expression matches
  // reviews_body_norm_idx (0045) exactly, so this is an index probe.
  const normalised = r.body.trim().replace(/\s+/g, ' ').toLowerCase();
  if ([...normalised].length >= CROSS_ACCOUNT_DUPLICATE_MIN_CHARS) {
    const others = await db.execute<{ id: string; user_id: string }>(sql`
      SELECT id, user_id FROM reviews
      WHERE md5(lower(regexp_replace(btrim(body), '\\s+', ' ', 'g')))
          = md5(lower(regexp_replace(btrim(${r.body}::text), '\\s+', ' ', 'g')))
        AND deleted_at IS NULL AND user_id <> ${r.userId}::uuid
      ORDER BY published_at, id LIMIT 50`);
    if (others.length > 0) {
      const accounts = new Set(others.map((o) => o.user_id)).size;
      await queueAutomated(db, {
        subjectType: 'review', subjectId: r.reviewId, ownerId: r.userId, autoRule: 'duplicate_across_accounts', reason: 'fake_review',
        detail: `The same text is in ${others.length}${others.length === 50 ? '+' : ''} review${others.length === 1 ? '' : 's'} by ${accounts} other account${accounts === 1 ? '' : 's'}.`,
        snapshot: { ...snapshot, same_text_review_ids: others.slice(0, 10).map((o) => o.id) },
      });
    }
  }
  const [flag] = await db.execute<{ flagged: boolean }>(sql`
    SELECT review_flag_until IS NOT NULL AND review_flag_until > now() AS flagged FROM users WHERE id = ${r.userId}::uuid`);
  if (flag?.flagged) {
    await queueAutomated(db, {
      subjectType: 'review', subjectId: r.reviewId, ownerId: r.userId, autoRule: 'flagged_account', reason: 'spoilers',
      detail: 'Repeat unmarked spoilers: this reader\'s reviews are queued for 30 days (PRD §27.3).', snapshot,
    });
  }
}
