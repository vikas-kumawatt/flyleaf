// Moderation (SO-40 to SO-42; PRD §27, §6.44, §26.3; architecture §3.6).
//
//   Layer 2, community: POST /v1/reports from every surface the PRD lists
//   (review §6.26, comment §6.28, profile §6.37, shelf §27.1, book §27.1).
//   Reporting needs the same view the reporter already has: anything they may
//   not see (a block either way, a private account, a private item, a deleted
//   one) is the same 404 as a random id (PRD §11.4, §25.3). One open report
//   per person per subject, so a double tap or an offline replay is one report.
//   Reports are writes, in the shared limiter's `writes` group (PRD §24.4),
//   and a NEW report also counts against reports:hour (5) and reports:day (20)
//   per account (owner decision on SO-4x); a repeat of an open one costs nothing.
//
//   Layer 3, human: the admin queue groups open reports by subject, heaviest
//   first by reporter reputation (§27.2 Layer 2: upheld reports carry more
//   weight). A moderator dismisses, resolves (catalog) or enforces a RULE; the
//   enforcement ladder (ladder.ts, §27.3) decides what that does. Every action
//   and its audit row commit in one transaction (A-15-020's rule), and every
//   enforcement tells the owner which rule applied and that they may appeal
//   once (§27.6). An overturned appeal undoes exactly what the action did.
//   A banned account cannot sign in, so its appeal comes through an emailed
//   one-time link (owner decision on SO-4x): single use, 30 days, no sign-in
//   (moderation/appeal-pages.ts).

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { config, type Db } from '../platform/index.js';
import { RateLimits } from '../platform/rate-limits.js';
import type { EmailSender } from '../providers/email/index.js';
import { ApiError } from '../http.js';
import { canViewWith, loadRelationship, mostRestrictive } from '../authorization/index.js';
import { resolveWorkId } from '../catalog/resolve.js';
import { syncReviewActivity } from '../reviews/index.js';
import { Notifier } from '../notify/index.js';
import { logAdminAction, type AuditContext } from '../admin/auth.js';
import type { AdminViewer } from '../http.js';
import {
  RULES,
  RULE_LABELS,
  contentEffect,
  describeStep,
  enforceable,
  needsAdmin,
  stepFor,
  type ReportReason,
  type Rule,
  type Step,
  type SubjectType,
} from './ladder.js';

export * from './ladder.js';

/** Same rule as the merge console (D-06-1): a typed reason of at least 10 characters. */
export const MIN_ACTION_REASON = 10;
export const APPEAL_MAX_LENGTH = 2000;
/**
 * How long a banned account's emailed appeal link works. The owner decided on
 * a single-use, expiring link; 30 days matches the app's other grace periods
 * (account deletion, shelf restore). Recorded as reversible in tasks.md.
 */
export const APPEAL_LINK_DAYS = 30;

export const hashAppealToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

const SUBJECT_WORD: Record<SubjectType, string> = { review: 'review', comment: 'comment', user: 'profile', shelf: 'shelf', work: 'book' };

/** The one 404 every refusal shares, whatever the subject (PRD §25.3: never confirm). */
const notFound = () => ApiError.notFound('Not found.');

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

export interface ReportInput {
  subject_type: SubjectType;
  subject_id: string;
  reason: ReportReason;
  detail?: string | null;
}

export interface Effects {
  content?: 'hide' | 'flag_spoilers' | 'reset_profile';
  /** hide: deleted_at before the action (the owner may have deleted it already). */
  prevDeletedAt?: string | null;
  prevSpoilers?: { has_spoilers: boolean; spoiler_after_page: number | null };
  prevProfile?: { display_name: string | null; bio: string | null; avatar_key: string | null };
  suspendedUntil?: string;
  prevSuspendedUntil?: string | null;
  banned?: { prevDeletedAt: string | null };
  ratings?: { scope: 'read'; readId: string } | { scope: 'account' };
  reviewFlagUntil?: string;
  prevReviewFlagUntil?: string | null;
  summary: string;
  consequences: string[];
}

export interface ModerationDeps {
  /** reports:hour and reports:day. Default: off (a test app turns them on). */
  limits?: RateLimits;
  /** The banned account's appeal link and outcome. Default: none sent. */
  mailer?: EmailSender;
  /** Mail failures are reported, never returned (A-04-024's rule). */
  onMailError?: (err: Error) => void;
}

export class ModerationService {
  readonly #limits: RateLimits;
  readonly #mailer: EmailSender | undefined;
  readonly #onMailError: (err: Error) => void;

  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier = new Notifier(),
    deps: ModerationDeps = {},
  ) {
    this.#limits = deps.limits ?? RateLimits.off();
    this.#mailer = deps.mailer;
    this.#onMailError = deps.onMailError ?? ((err) => console.error('[moderation] mail failed:', err.message));
  }

  #mail(message: { to: string; subject: string; text: string }) {
    if (!this.#mailer) return;
    void this.#mailer.send(message).catch((err: unknown) => this.#onMailError(err instanceof Error ? err : new Error(String(err))));
  }

  // -------------------------------------------------------------------------
  // SO-40: reports
  // -------------------------------------------------------------------------

  /**
   * What the reporter may see of the subject, its owner, and a snapshot of
   * the reported text. Anything else is the shared 404.
   */
  async #reportable(viewer: string, type: SubjectType, id: string): Promise<{ ownerId: string | null; subjectId: string; snapshot: Row }> {
    switch (type) {
      case 'review': {
        const [r] = await this.db.execute<{
          user_id: string; body: string; has_spoilers: boolean; visibility: string; read_visibility: string;
          work_id: string; title: string; read_id: string;
        }>(sql`
          SELECT rv.user_id, rv.body, rv.has_spoilers, rv.visibility, r.visibility AS read_visibility,
            rv.work_id, w.title, rv.read_id
          FROM reviews rv JOIN reads r ON r.id = rv.read_id JOIN works w ON w.id = rv.work_id
          WHERE rv.id = ${id}::uuid AND rv.deleted_at IS NULL`);
        if (!r) throw notFound();
        const rel = await loadRelationship(this.db, viewer, r.user_id);
        if (!canViewWith(viewer, r.user_id, rel, mostRestrictive(r.visibility, r.read_visibility), { authored: true })) throw notFound();
        return {
          ownerId: r.user_id, subjectId: id,
          snapshot: { body: r.body, has_spoilers: r.has_spoilers, work_id: r.work_id, work_title: r.title, read_id: r.read_id },
        };
      }
      case 'comment': {
        const [c] = await this.db.execute<{ user_id: string; body: string; read_id: string; read_owner: string; visibility: string }>(sql`
          SELECT c.user_id, c.body, c.read_id, r.user_id AS read_owner, r.visibility
          FROM read_comments c JOIN reads r ON r.id = c.read_id
          WHERE c.id = ${id}::uuid AND c.deleted_at IS NULL`);
        if (!c) throw notFound();
        // The thread must be visible, and the comment too: a comment by
        // someone in a block with the viewer is hidden from them (§11.4).
        const toOwner = await loadRelationship(this.db, viewer, c.read_owner);
        if (!canViewWith(viewer, c.read_owner, toOwner, c.visibility)) throw notFound();
        const toAuthor = await loadRelationship(this.db, viewer, c.user_id);
        if (!toAuthor.ownerExists || toAuthor.isBlocked) throw notFound();
        return { ownerId: c.user_id, subjectId: id, snapshot: { body: c.body, read_id: c.read_id } };
      }
      case 'user': {
        const rel = await loadRelationship(this.db, viewer, id);
        if (!rel.ownerExists || rel.isBlocked) throw notFound();
        const [p] = await this.db.execute<{ username: string; display_name: string | null; bio: string | null; avatar_key: string | null }>(sql`
          SELECT username, display_name, bio, avatar_key FROM profiles WHERE user_id = ${id}::uuid`);
        return { ownerId: id, subjectId: id, snapshot: { ...p } };
      }
      case 'shelf': {
        const [s] = await this.db.execute<{ user_id: string; name: string; description: string | null; privacy: string }>(sql`
          SELECT user_id, name, description, privacy FROM shelves WHERE id = ${id}::uuid AND deleted_at IS NULL`);
        if (!s) throw notFound();
        const rel = await loadRelationship(this.db, viewer, s.user_id);
        if (!canViewWith(viewer, s.user_id, rel, s.privacy)) throw notFound();
        return { ownerId: s.user_id, subjectId: id, snapshot: { name: s.name, description: s.description } };
      }
      case 'work': {
        // A merged work is reported as its survivor (the one the reader sees).
        const workId = await resolveWorkId(this.db, id);
        if (!workId) throw notFound();
        const [w] = await this.db.execute<{ title: string; maturity: string }>(sql`SELECT title, maturity FROM works WHERE id = ${workId}::uuid`);
        return { ownerId: null, subjectId: workId, snapshot: { title: w!.title, maturity: w!.maturity } };
      }
    }
  }

  async report(viewer: string, input: ReportInput): Promise<{ report: ReportView; created: boolean }> {
    const target = await this.#reportable(viewer, input.subject_type, input.subject_id);
    if (target.ownerId === viewer) throw ApiError.badRequest('cannot_report_self', 'You cannot report your own content.', 'subject_id');
    const detail = input.detail?.trim() || null;
    const existingOpen = () => this.db.execute<Row>(sql`
      SELECT id, subject_type, subject_id, reason, state, created_at, resolved_at FROM reports
      WHERE reporter_id = ${viewer}::uuid AND subject_type = ${input.subject_type}
        AND subject_id = ${target.subjectId}::uuid AND state = 'open'`);
    // Already reported and still open: the same report, unchanged, and not
    // counted again (a double tap or an offline replay).
    const [already] = await existingOpen();
    if (already) return { report: reportView(already), created: false };
    // Owner decision on SO-4x: 5 new reports an hour, 20 a day, per account.
    await this.#limits.enforce('reports:hour', viewer);
    await this.#limits.enforce('reports:day', viewer);
    const [inserted] = await this.db.execute<Row>(sql`
      INSERT INTO reports (reporter_id, source, subject_type, subject_id, subject_owner_id, reason, detail, snapshot)
      VALUES (${viewer}::uuid, 'user', ${input.subject_type}, ${target.subjectId}::uuid, ${target.ownerId}::uuid,
        ${input.reason}, ${detail}, ${JSON.stringify(target.snapshot)}::jsonb)
      ON CONFLICT (reporter_id, subject_type, subject_id) WHERE state = 'open' AND reporter_id IS NOT NULL DO NOTHING
      RETURNING id, subject_type, subject_id, reason, state, created_at, resolved_at`);
    if (inserted) return { report: reportView(inserted), created: true };
    // Two at the same moment: the other one won.
    const [existing] = await existingOpen();
    return { report: reportView(existing!), created: false };
  }

  /** PRD §27.6: a reporter sees the status of their reports, never the outcome for someone else. */
  async myReports(viewer: string, opts: { limit?: number; offset?: number } = {}): Promise<{ reports: ReportView[] }> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await this.db.execute<Row>(sql`
      SELECT id, subject_type, subject_id, reason, state, created_at, resolved_at FROM reports
      WHERE reporter_id = ${viewer}::uuid
      ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${Math.max(0, opts.offset ?? 0)}`);
    return { reports: rows.map(reportView) };
  }

  // -------------------------------------------------------------------------
  // The owner's side (PRD §27.6): which rule, and one appeal.
  // -------------------------------------------------------------------------

  async myNotices(viewer: string): Promise<{ notices: NoticeView[] }> {
    const rows = await this.db.execute<Row>(sql`
      SELECT * FROM moderation_actions
      WHERE target_user_id = ${viewer}::uuid AND decision = 'enforce'
      ORDER BY created_at DESC, id DESC LIMIT 100`);
    return { notices: rows.map(noticeView) };
  }

  async myNotice(viewer: string, id: string): Promise<NoticeView> {
    const [row] = await this.db.execute<Row>(sql`
      SELECT * FROM moderation_actions
      WHERE id = ${id}::uuid AND target_user_id = ${viewer}::uuid AND decision = 'enforce'`);
    if (!row) throw notFound();
    return noticeView(row);
  }

  /** Once per action (PRD §27.6). A second appeal, or one on a reversed action, is a 409. */
  async appeal(viewer: string, id: string, body: string): Promise<NoticeView> {
    const text = body.trim();
    if (!text) throw ApiError.badRequest('empty_body', 'Tell us why the decision is wrong.', 'body');
    if (text.length > APPEAL_MAX_LENGTH) throw ApiError.badRequest('body_too_long', `An appeal is at most ${APPEAL_MAX_LENGTH} characters.`, 'body');
    const [row] = await this.db.execute<Row>(sql`
      UPDATE moderation_actions SET appeal_body = ${text}, appealed_at = now(), appeal_state = 'pending'
      WHERE id = ${id}::uuid AND target_user_id = ${viewer}::uuid AND decision = 'enforce'
        AND appeal_state IS NULL AND reversed_at IS NULL
      RETURNING *`);
    if (row) return noticeView(row);
    await this.myNotice(viewer, id); // 404 when it is not theirs
    throw ApiError.conflict('appeal_closed', 'This decision has already been appealed.');
  }

  // -------------------------------------------------------------------------
  // SO-42: the admin queue
  // -------------------------------------------------------------------------

  /**
   * Open reports grouped by subject. Weight: each user report counts its
   * reporter's reputation, (upheld + 1) / (resolved + 2) — 0.5 for a new
   * reporter, towards 1 for one whose reports are upheld, towards 0 for one
   * who mass-reports (§27.2). An automated report counts 1. Heaviest first,
   * then oldest.
   */
  async queue(opts: { subjectType?: SubjectType; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = await this.db.execute<Row>(sql`
      WITH open AS (
        SELECT r.*,
          CASE WHEN r.source = 'automated' OR r.reporter_id IS NULL THEN 1.0
            ELSE (COALESCE(rep.upheld, 0) + 1.0) / (COALESCE(rep.resolved, 0) + 2.0) END AS weight
        FROM reports r
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE x.state = 'actioned') AS upheld, count(*) AS resolved
          FROM reports x WHERE x.reporter_id = r.reporter_id AND x.state <> 'open'
        ) rep ON r.reporter_id IS NOT NULL
        WHERE r.state = 'open' ${opts.subjectType ? sql`AND r.subject_type = ${opts.subjectType}` : sql``}
      )
      SELECT o.subject_type, o.subject_id, o.subject_owner_id, p.username AS owner_username,
        count(*)::int AS report_count, round(sum(o.weight)::numeric, 3)::float8 AS weight,
        min(o.created_at) AS first_reported_at, max(o.created_at) AS last_reported_at,
        array_agg(DISTINCT o.reason) AS reasons,
        array_remove(array_agg(DISTINCT o.auto_rule), NULL) AS auto_rules,
        (array_agg(o.snapshot ORDER BY o.created_at DESC))[1] AS snapshot
      FROM open o LEFT JOIN profiles p ON p.user_id = o.subject_owner_id
      GROUP BY o.subject_type, o.subject_id, o.subject_owner_id, p.username
      ORDER BY sum(o.weight) DESC, min(o.created_at) ASC, o.subject_id
      LIMIT ${limit} OFFSET ${offset}`);
    const [count] = await this.db.execute<{ n: number; appeals: number }>(sql`
      SELECT (SELECT count(DISTINCT (subject_type, subject_id))::int FROM reports WHERE state = 'open') AS n,
        (SELECT count(*)::int FROM moderation_actions WHERE appeal_state = 'pending') AS appeals`);
    return {
      cases: rows.map((r) => ({
        subject_type: r.subject_type as SubjectType,
        subject_id: String(r.subject_id),
        owner: r.subject_owner_id ? { id: String(r.subject_owner_id), username: (r.owner_username as string | null) ?? null } : null,
        report_count: Number(r.report_count),
        weight: Number(r.weight),
        first_reported_at: iso(r.first_reported_at)!,
        last_reported_at: iso(r.last_reported_at)!,
        reasons: pgArray(r.reasons),
        auto_rules: pgArray(r.auto_rules),
        snapshot: json<Row>(r.snapshot) ?? {},
      })),
      open_cases: Number(count?.n ?? 0),
      pending_appeals: Number(count?.appeals ?? 0),
    };
  }

  /** The subject as it is now, admins see hidden and deleted content too. */
  async #currentSubject(type: SubjectType, id: string): Promise<{ ownerId: string | null; state: Row | null }> {
    const one = async (q: ReturnType<typeof sql>) => (await this.db.execute<Row>(q))[0] ?? null;
    switch (type) {
      case 'review': {
        const r = await one(sql`
          SELECT rv.user_id, rv.body, rv.has_spoilers, rv.spoiler_after_page, rv.visibility, rv.deleted_at, rv.hidden_at,
            rv.read_id, rv.work_id, w.title AS work_title, r.rating, r.rating_excluded
          FROM reviews rv JOIN reads r ON r.id = rv.read_id JOIN works w ON w.id = rv.work_id WHERE rv.id = ${id}::uuid`);
        return { ownerId: (r?.user_id as string) ?? null, state: r };
      }
      case 'comment': {
        const r = await one(sql`
          SELECT c.user_id, c.body, c.read_id, c.deleted_at, c.hidden_at, w.title AS work_title, rp.username AS read_owner_username
          FROM read_comments c JOIN reads r ON r.id = c.read_id JOIN works w ON w.id = r.work_id
          LEFT JOIN profiles rp ON rp.user_id = r.user_id WHERE c.id = ${id}::uuid`);
        return { ownerId: (r?.user_id as string) ?? null, state: r };
      }
      case 'user': {
        const r = await one(sql`
          SELECT p.user_id, p.username, p.display_name, p.bio, p.avatar_key FROM profiles p WHERE p.user_id = ${id}::uuid`);
        return { ownerId: r ? id : null, state: r };
      }
      case 'shelf': {
        const r = await one(sql`SELECT user_id, name, description, privacy, deleted_at, hidden_at FROM shelves WHERE id = ${id}::uuid`);
        return { ownerId: (r?.user_id as string) ?? null, state: r };
      }
      case 'work': {
        const r = await one(sql`SELECT title, maturity, merged_into_id FROM works WHERE id = ${id}::uuid`);
        return { ownerId: null, state: r };
      }
    }
  }

  async #strikes(db: Db, userId: string): Promise<Map<Rule, number>> {
    const rows = await db.execute<{ rule: Rule; n: number }>(sql`
      SELECT rule, count(*)::int AS n FROM moderation_actions
      WHERE target_user_id = ${userId}::uuid AND decision = 'enforce' AND reversed_at IS NULL
      GROUP BY rule`);
    return new Map(rows.map((r) => [r.rule, Number(r.n)]));
  }

  /** Everything a moderator needs to decide, in context (PRD §27.5). */
  async caseDetail(type: SubjectType, id: string) {
    const { ownerId, state } = await this.#currentSubject(type, id);
    const reports = await this.db.execute<Row>(sql`
      SELECT r.id, r.source, r.auto_rule, r.reason, r.detail, r.snapshot, r.state, r.created_at, r.resolved_at,
        r.reporter_id, p.username AS reporter_username,
        (SELECT (count(*) FILTER (WHERE x.state = 'actioned') + 1.0) / (count(*) + 2.0)
           FROM reports x WHERE x.reporter_id = r.reporter_id AND x.state <> 'open')::float8 AS reporter_reputation
      FROM reports r LEFT JOIN profiles p ON p.user_id = r.reporter_id
      WHERE r.subject_type = ${type} AND r.subject_id = ${id}::uuid
      ORDER BY r.state = 'open' DESC, r.created_at DESC LIMIT 200`);
    if (!state && reports.length === 0) throw notFound();

    let owner = null;
    let history: Row[] = [];
    let ladder: Array<{ rule: Rule; label: string; strikes: number; step: number; consequences: string[]; needs_admin: boolean }> = [];
    if (ownerId) {
      const [u] = await this.db.execute<Row>(sql`
        SELECT u.id, p.username, p.display_name, u.created_at, u.suspended_until, u.banned_at, u.deleted_at,
          u.ratings_excluded_at, u.review_flag_until
        FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ${ownerId}::uuid`);
      if (u) {
        owner = {
          id: String(u.id), username: (u.username as string | null) ?? null, display_name: (u.display_name as string | null) ?? null,
          created_at: iso(u.created_at)!, suspended_until: iso(u.suspended_until), banned_at: iso(u.banned_at),
          deleted_at: iso(u.deleted_at), ratings_excluded_at: iso(u.ratings_excluded_at), review_flag_until: iso(u.review_flag_until),
        };
      }
      history = await this.db.execute<Row>(sql`
        SELECT id, subject_type, subject_id, decision, rule, step, reason, created_at, reversed_at, appeal_state
        FROM moderation_actions WHERE target_user_id = ${ownerId}::uuid ORDER BY created_at DESC LIMIT 50`);
      const strikes = await this.#strikes(this.db, ownerId);
      ladder = RULES.filter((rule) => enforceable(type, rule)).map((rule) => {
        const { index, step } = stepFor(rule, strikes.get(rule) ?? 0);
        return {
          rule, label: RULE_LABELS[rule], strikes: strikes.get(rule) ?? 0, step: index + 1,
          consequences: describeStep(type, rule, step).consequences, needs_admin: needsAdmin(type, step),
        };
      });
    }
    return {
      subject_type: type,
      subject_id: id,
      subject: state ? plain(state) : null,
      owner,
      reports: reports.map((r) => ({
        id: String(r.id), source: r.source as string, auto_rule: (r.auto_rule as string | null) ?? null,
        reason: r.reason as string, detail: (r.detail as string | null) ?? null, snapshot: json<Row>(r.snapshot) ?? {},
        state: r.state as string, created_at: iso(r.created_at)!, resolved_at: iso(r.resolved_at),
        reporter: r.reporter_id ? { id: String(r.reporter_id), username: (r.reporter_username as string | null) ?? null } : null,
        reporter_reputation: r.reporter_id && r.reporter_reputation !== null ? Number(r.reporter_reputation) : null,
      })),
      open_reports: reports.filter((r) => r.state === 'open').length,
      history: history.map((h) => ({
        id: String(h.id), subject_type: h.subject_type as string, subject_id: String(h.subject_id), decision: h.decision as string,
        rule: (h.rule as string | null) ?? null, step: h.step === null ? null : Number(h.step), reason: h.reason as string,
        created_at: iso(h.created_at)!, reversed_at: iso(h.reversed_at), appeal_state: (h.appeal_state as string | null) ?? null,
      })),
      ladder,
    };
  }

  /**
   * One decision on a subject's open reports. Dismiss: no violation. Resolve:
   * a catalog report handled with the catalog tools. Enforce: the rule's next
   * ladder step for the owner. The action, the closed reports, the owner's
   * notice and the audit row commit together, or none of them do.
   */
  async act(
    admin: AdminViewer,
    type: SubjectType,
    id: string,
    input: { decision: 'dismiss' | 'enforce' | 'resolve'; rule?: Rule; reason: string },
    ctx: AuditContext,
  ) {
    const reason = typedReason(input.reason);
    if (input.decision === 'enforce') {
      if (!input.rule) throw ApiError.badRequest('rule_required', 'Choose the rule that was broken.', 'rule');
      if (!enforceable(type, input.rule)) {
        throw ApiError.unprocessable('rule_not_applicable', `${RULE_LABELS[input.rule]} cannot be applied to a ${SUBJECT_WORD[type]}.`, 'rule');
      }
    } else if (input.rule) {
      throw ApiError.badRequest('rule_not_expected', 'A rule is recorded only when enforcing.', 'rule');
    }
    if (input.decision === 'resolve' && type !== 'work') {
      throw ApiError.unprocessable('resolve_is_for_catalog', 'Only book reports are resolved; dismiss or enforce instead.', 'decision');
    }

    let banMail: { to: string; subject: string; text: string } | null = null;
    const result = await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      // Lock the open reports: a second moderator acting at the same moment
      // waits, then finds nothing open (409) instead of acting twice.
      const open = await tx.execute<{ id: string; subject_owner_id: string | null }>(sql`
        SELECT id, subject_owner_id FROM reports
        WHERE subject_type = ${type} AND subject_id = ${id}::uuid AND state = 'open'
        ORDER BY id FOR UPDATE`);
      if (open.length === 0) throw ApiError.conflict('nothing_open', 'There are no open reports on this. Someone may have acted on it already.');
      const ownerId = open.find((r) => r.subject_owner_id)?.subject_owner_id ?? null;

      let effects: Effects | null = null;
      let step: { index: number; step: Step } | null = null;
      if (input.decision === 'enforce') {
        if (!ownerId) throw ApiError.conflict('owner_gone', 'The account behind this no longer exists.');
        const strikes = await this.#strikes(tx, ownerId);
        step = stepFor(input.rule!, strikes.get(input.rule!) ?? 0);
        if (needsAdmin(type, step.step) && admin.role !== 'admin') {
          throw ApiError.forbidden('insufficient_role', 'This step suspends, bans or changes an account: an administrator must apply it (PRD §27.5).');
        }
        effects = await this.#apply(tx, type, id, ownerId, input.rule!, step.step);
      }

      const [action] = await tx.execute<Row>(sql`
        INSERT INTO moderation_actions (subject_type, subject_id, target_user_id, decision, rule, step, effects, reason, actor_id)
        VALUES (${type}, ${id}::uuid, ${ownerId}::uuid, ${input.decision}, ${input.rule ?? null}, ${step ? step.index + 1 : null},
          ${JSON.stringify(effects ?? {})}::jsonb, ${reason}, ${admin.id}::uuid)
        RETURNING *`);
      const actionId = String(action!.id);
      await tx.execute(sql`
        UPDATE reports SET state = ${input.decision === 'dismiss' ? 'dismissed' : 'actioned'}, resolved_at = now(),
          resolved_by = ${admin.id}::uuid, action_id = ${actionId}::uuid
        WHERE id IN (${sql.join(open.map((r) => sql`${r.id}::uuid`), sql`, `)})`);

      if (effects && ownerId) {
        await this.notifier.moderationNotice(tx, ownerId, actionId, {
          text: `${effects.summary} You can appeal once.`, rule: input.rule, subject_type: type, outcome: 'enforced',
        });
      }
      // A banned account cannot sign in to read that notice or appeal: it
      // gets a one-time link by email instead, sent once this commits.
      if (effects?.banned && ownerId) banMail = await this.#appealLink(tx, ownerId, actionId, input.rule!, effects);

      await logAdminAction(tx, {
        actorId: admin.id,
        action: `moderation.${input.decision}`,
        subjectType: type,
        subjectId: id,
        reason,
        payload: {
          actionId, rule: input.rule ?? null, step: step ? step.index + 1 : null, reports: open.map((r) => r.id),
          targetUserId: ownerId, effects,
        },
        ...ctx,
      });
      return actionView(action!);
    });
    if (banMail) this.#mail(banMail);
    return result;
  }

  /** Writes a banned account's one-time appeal link (hash only); returns the email to send. */
  async #appealLink(tx: Db, userId: string, actionId: string, rule: Rule, effects: Effects) {
    const raw = randomBytes(32).toString('base64url');
    const [u] = await tx.execute<{ email: string }>(sql`
      INSERT INTO moderation_appeal_links (token_hash, action_id, user_id, expires_at)
      VALUES (${hashAppealToken(raw)}, ${actionId}::uuid, ${userId}::uuid, now() + make_interval(days => ${APPEAL_LINK_DAYS}))
      RETURNING (SELECT email FROM users WHERE id = ${userId}::uuid) AS email`);
    return {
      to: u!.email,
      subject: 'Your Flyleaf account has been banned',
      text: `Your Flyleaf account has been banned under our rule on ${RULE_LABELS[rule].toLowerCase()}.\n\n` +
        `${effects.summary}\n\n` +
        `If you think this is wrong, you can appeal once, without signing in. A person will review it:\n` +
        `${config.appBaseUrl}/appeal?token=${raw}\n\n` +
        `The link works once and expires in ${APPEAL_LINK_DAYS} days.`,
    };
  }

  /** What the appeal page shows for a link: the decision, and whether the link can still be used. GET never spends it. */
  async appealLinkState(raw: string): Promise<{ state: 'open' | 'used' | 'expired' | 'closed'; notice: NoticeView | null }> {
    const [row] = await this.db.execute<Row>(sql`
      SELECT a.*, l.used_at AS link_used_at, l.expires_at <= now() AS link_expired
      FROM moderation_appeal_links l JOIN moderation_actions a ON a.id = l.action_id
      WHERE l.token_hash = ${hashAppealToken(raw)}`);
    if (!row) return { state: 'expired', notice: null };
    const notice = noticeView(row);
    if (row.link_used_at) return { state: 'used', notice };
    if (row.link_expired) return { state: 'expired', notice: null };
    if (!notice.can_appeal) return { state: 'closed', notice };
    return { state: 'open', notice };
  }

  /**
   * The appeal a banned account sends through its emailed link: the same one
   * appeal as POST /me/moderation/:id/appeal, with the link as the proof of
   * identity. The link is spent in the same transaction; a second use, an
   * expired or unknown link is `invalid_or_expired_token`, an action already
   * appealed or reversed is `appeal_closed`.
   */
  async appealByLink(raw: string, body: string): Promise<NoticeView> {
    const text = body.trim();
    if (!text) throw ApiError.badRequest('empty_body', 'Tell us why the decision is wrong.', 'body');
    if ([...text].length > APPEAL_MAX_LENGTH) throw ApiError.badRequest('body_too_long', `An appeal is at most ${APPEAL_MAX_LENGTH} characters.`, 'body');
    return this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [link] = await tx.execute<{ action_id: string; user_id: string }>(sql`
        UPDATE moderation_appeal_links SET used_at = now()
        WHERE token_hash = ${hashAppealToken(raw)} AND used_at IS NULL AND expires_at > now()
        RETURNING action_id, user_id`);
      if (!link) throw ApiError.badRequest('invalid_or_expired_token', 'This link has expired or was already used.');
      const [row] = await tx.execute<Row>(sql`
        UPDATE moderation_actions SET appeal_body = ${text}, appealed_at = now(), appeal_state = 'pending'
        WHERE id = ${link.action_id}::uuid AND target_user_id = ${link.user_id}::uuid AND decision = 'enforce'
          AND appeal_state IS NULL AND reversed_at IS NULL
        RETURNING *`);
      if (!row) throw ApiError.conflict('appeal_closed', 'This decision has already been appealed.');
      return noticeView(row);
    });
  }

  /** Applies one ladder step; returns what it did and what it replaced. */
  async #apply(tx: Db, type: SubjectType, id: string, ownerId: string, rule: Rule, step: Step): Promise<Effects> {
    const { summary, consequences } = describeStep(type, rule, step);
    const e: Effects = { summary, consequences };
    const effect = contentEffect(type, step);

    if (effect === 'hide') {
      const table = type === 'review' ? sql`reviews` : type === 'comment' ? sql`read_comments` : sql`shelves`;
      const [prev] = await tx.execute<{ deleted_at: string | null }>(sql`
        SELECT deleted_at::text AS deleted_at FROM ${table} WHERE id = ${id}::uuid FOR UPDATE`);
      if (prev) {
        await tx.execute(sql`UPDATE ${table} SET deleted_at = COALESCE(deleted_at, now()), hidden_at = now() WHERE id = ${id}::uuid`);
        e.content = 'hide';
        e.prevDeletedAt = prev.deleted_at;
        if (type === 'review') await syncReviewActivity(tx, id);
        if (type === 'comment') await this.notifier.commentDeleted(tx, id);
        if (type === 'shelf') await tx.execute(sql`DELETE FROM activity WHERE object_type = 'shelf_item' AND object_id = ${id}::uuid`);
      }
    } else if (effect === 'flag_spoilers') {
      const [prev] = await tx.execute<{ has_spoilers: boolean; spoiler_after_page: number | null }>(sql`
        SELECT has_spoilers, spoiler_after_page FROM reviews WHERE id = ${id}::uuid FOR UPDATE`);
      if (prev) {
        await tx.execute(sql`UPDATE reviews SET has_spoilers = true, spoiler_after_page = NULL WHERE id = ${id}::uuid`);
        e.content = 'flag_spoilers';
        e.prevSpoilers = { has_spoilers: prev.has_spoilers, spoiler_after_page: prev.spoiler_after_page };
        await syncReviewActivity(tx, id);
      }
    } else if (effect === 'reset_profile') {
      const [prev] = await tx.execute<{ display_name: string | null; bio: string | null; avatar_key: string | null }>(sql`
        SELECT display_name, bio, avatar_key FROM profiles WHERE user_id = ${ownerId}::uuid FOR UPDATE`);
      if (prev) {
        await tx.execute(sql`UPDATE profiles SET display_name = NULL, bio = NULL, avatar_key = NULL WHERE user_id = ${ownerId}::uuid`);
        e.content = 'reset_profile';
        e.prevProfile = prev;
      }
    }

    if (step.excludeRatings === 'read' && type === 'review') {
      const [r] = await tx.execute<{ read_id: string; work_id: string }>(sql`
        UPDATE reads SET rating_excluded = true WHERE id = (SELECT read_id FROM reviews WHERE id = ${id}::uuid)
        RETURNING id AS read_id, work_id`);
      if (r) {
        e.ratings = { scope: 'read', readId: r.read_id };
        await tx.execute(sql`SELECT recompute_work_stats_for_work(${r.work_id}::uuid)`);
      }
    }
    if (step.excludeRatings === 'account') {
      await tx.execute(sql`UPDATE users SET ratings_excluded_at = now() WHERE id = ${ownerId}::uuid AND ratings_excluded_at IS NULL`);
      e.ratings = { scope: 'account' };
      await recomputeRatedWorks(tx, ownerId);
    }
    if (step.flagReviewsDays) {
      const [u] = await tx.execute<{ prev: string | null; next: string }>(sql`
        UPDATE users u SET review_flag_until = GREATEST(COALESCE(o.review_flag_until, now()), now() + make_interval(days => ${step.flagReviewsDays}))
        FROM (SELECT review_flag_until FROM users WHERE id = ${ownerId}::uuid FOR UPDATE) o
        WHERE u.id = ${ownerId}::uuid
        RETURNING o.review_flag_until::text AS prev, u.review_flag_until::text AS next`);
      e.prevReviewFlagUntil = u?.prev ?? null;
      e.reviewFlagUntil = u?.next;
    }
    if (step.suspendDays) {
      const [u] = await tx.execute<{ prev: string | null; next: string }>(sql`
        UPDATE users u SET suspended_until = GREATEST(COALESCE(o.suspended_until, now()), now() + make_interval(days => ${step.suspendDays}))
        FROM (SELECT suspended_until FROM users WHERE id = ${ownerId}::uuid FOR UPDATE) o
        WHERE u.id = ${ownerId}::uuid
        RETURNING o.suspended_until::text AS prev, u.suspended_until::text AS next`);
      e.prevSuspendedUntil = u?.prev ?? null;
      e.suspendedUntil = u?.next;
    }
    if (step.ban) {
      // A ban is a soft delete the retention sweep never finishes: the account
      // disappears everywhere a deleted one does, and an appeal can bring it
      // back. Its sessions end now (refresh tokens; access tokens expire).
      const [u] = await tx.execute<{ prev: string | null }>(sql`
        UPDATE users u SET banned_at = now(), deleted_at = COALESCE(o.deleted_at, now())
        FROM (SELECT deleted_at FROM users WHERE id = ${ownerId}::uuid FOR UPDATE) o
        WHERE u.id = ${ownerId}::uuid
        RETURNING o.deleted_at::text AS prev`);
      await tx.execute(sql`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${ownerId}::uuid AND revoked_at IS NULL`);
      e.banned = { prevDeletedAt: u?.prev ?? null };
    }
    return e;
  }

  /** Undoes exactly what `#apply` did (an overturned appeal). */
  async #reverse(tx: Db, action: Row): Promise<void> {
    const type = action.subject_type as SubjectType;
    const id = String(action.subject_id);
    const ownerId = String(action.target_user_id);
    const e = json<Effects>(action.effects);

    if (e.content === 'hide') {
      const table = type === 'review' ? sql`reviews` : type === 'comment' ? sql`read_comments` : sql`shelves`;
      await tx.execute(sql`
        UPDATE ${table} SET hidden_at = NULL, deleted_at = ${e.prevDeletedAt ?? null}::timestamptz
        WHERE id = ${id}::uuid AND hidden_at IS NOT NULL`);
      if (type === 'review') await syncReviewActivity(tx, id);
    } else if (e.content === 'flag_spoilers' && e.prevSpoilers) {
      await tx.execute(sql`
        UPDATE reviews SET has_spoilers = ${e.prevSpoilers.has_spoilers}, spoiler_after_page = ${e.prevSpoilers.spoiler_after_page}
        WHERE id = ${id}::uuid`);
      await syncReviewActivity(tx, id);
    } else if (e.content === 'reset_profile' && e.prevProfile) {
      // Only what the owner has not changed since. The photo comes back while
      // its upload still exists (the avatar sweep deletes a replaced one after
      // a day, A-10-016).
      await tx.execute(sql`
        UPDATE profiles SET
          display_name = COALESCE(display_name, ${e.prevProfile.display_name}),
          bio = COALESCE(bio, ${e.prevProfile.bio}),
          avatar_key = COALESCE(avatar_key, (SELECT key FROM uploads
            WHERE key = ${e.prevProfile.avatar_key} AND user_id = ${ownerId}::uuid AND status = 'consumed'))
        WHERE user_id = ${ownerId}::uuid`);
    }
    if (e.ratings?.scope === 'read') {
      const [r] = await tx.execute<{ work_id: string }>(sql`
        UPDATE reads SET rating_excluded = false WHERE id = ${e.ratings.readId}::uuid RETURNING work_id`);
      if (r) await tx.execute(sql`SELECT recompute_work_stats_for_work(${r.work_id}::uuid)`);
    }
    if (e.ratings?.scope === 'account') {
      await tx.execute(sql`UPDATE users SET ratings_excluded_at = NULL WHERE id = ${ownerId}::uuid`);
      await recomputeRatedWorks(tx, ownerId);
    }
    if (e.reviewFlagUntil !== undefined) {
      await tx.execute(sql`
        UPDATE users SET review_flag_until = ${e.prevReviewFlagUntil ?? null}::timestamptz
        WHERE id = ${ownerId}::uuid AND review_flag_until = ${e.reviewFlagUntil}::timestamptz`);
    }
    if (e.suspendedUntil !== undefined) {
      await tx.execute(sql`
        UPDATE users SET suspended_until = ${e.prevSuspendedUntil ?? null}::timestamptz
        WHERE id = ${ownerId}::uuid AND suspended_until = ${e.suspendedUntil}::timestamptz`);
    }
    if (e.banned) {
      await tx.execute(sql`
        UPDATE users SET banned_at = NULL, deleted_at = ${e.banned.prevDeletedAt ?? null}::timestamptz
        WHERE id = ${ownerId}::uuid AND banned_at IS NOT NULL`);
    }
  }

  // -------------------------------------------------------------------------
  // SO-42: appeals (PRD §27.6: reviewed by a human)
  // -------------------------------------------------------------------------

  async appeals(opts: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const rows = await this.db.execute<Row>(sql`
      SELECT a.*, p.username AS owner_username, ap.username AS actor_username
      FROM moderation_actions a
      LEFT JOIN profiles p ON p.user_id = a.target_user_id
      LEFT JOIN users au ON au.id = a.actor_id
      LEFT JOIN profiles ap ON ap.user_id = a.actor_id
      WHERE a.appeal_state = 'pending'
      ORDER BY a.appealed_at ASC, a.id LIMIT ${limit} OFFSET ${Math.max(0, opts.offset ?? 0)}`);
    return {
      appeals: rows.map((r) => ({
        ...actionView(r),
        owner: r.target_user_id ? { id: String(r.target_user_id), username: (r.owner_username as string | null) ?? null } : null,
        needs_admin: needsAdminToReverse(r),
      })),
    };
  }

  /**
   * uphold: the decision stands. overturn: everything the action did is
   * undone, the strike no longer counts on the ladder, and the owner is told.
   */
  async resolveAppeal(admin: AdminViewer, actionId: string, input: { decision: 'uphold' | 'overturn'; reason: string }, ctx: AuditContext) {
    const reason = typedReason(input.reason);
    let outcomeMail: { to: string; subject: string; text: string } | null = null;
    const result = await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [action] = await tx.execute<Row>(sql`
        SELECT * FROM moderation_actions WHERE id = ${actionId}::uuid AND appeal_state = 'pending' FOR UPDATE`);
      if (!action) throw ApiError.notFound('No pending appeal.');
      if (input.decision === 'overturn' && needsAdminToReverse(action) && admin.role !== 'admin') {
        throw ApiError.forbidden('insufficient_role', 'Reversing this changes an account: an administrator must do it (PRD §27.5).');
      }
      if (input.decision === 'overturn') await this.#reverse(tx, action);
      const [updated] = await tx.execute<Row>(sql`
        UPDATE moderation_actions SET
          appeal_state = ${input.decision === 'overturn' ? 'overturned' : 'upheld'},
          appeal_resolved_at = now(), appeal_resolved_by = ${admin.id}::uuid, appeal_reason = ${reason},
          reversed_at = ${input.decision === 'overturn' ? sql`now()` : sql`reversed_at`}
        WHERE id = ${actionId}::uuid RETURNING *`);
      const what = SUBJECT_WORD[action.subject_type as SubjectType];
      await this.notifier.moderationNotice(tx, String(action.target_user_id), actionId, {
        text: input.decision === 'overturn'
          ? `We reviewed your appeal about your ${what} and reversed the decision.`
          : `We reviewed your appeal about your ${what}. The decision stands.`,
        outcome: input.decision === 'overturn' ? 'appeal_overturned' : 'appeal_upheld',
        subject_type: action.subject_type,
      });
      await logAdminAction(tx, {
        actorId: admin.id,
        action: input.decision === 'overturn' ? 'moderation.appeal_overturned' : 'moderation.appeal_upheld',
        subjectType: String(action.subject_type),
        subjectId: String(action.subject_id),
        reason,
        payload: { actionId, rule: action.rule, targetUserId: action.target_user_id },
        ...ctx,
      });
      // A ban's appeal came by email (the account cannot sign in): so does the answer.
      if (json<Effects>(action.effects)?.banned) {
        const [u] = await tx.execute<{ email: string }>(sql`SELECT email FROM users WHERE id = ${action.target_user_id}::uuid`);
        if (u) {
          outcomeMail = input.decision === 'overturn'
            ? { to: u.email, subject: 'Your Flyleaf appeal: the ban is lifted', text: 'We reviewed your appeal and reversed the decision. Your account is restored: you can sign in again.' }
            : { to: u.email, subject: 'Your Flyleaf appeal', text: 'We reviewed your appeal. The decision stands, and the account stays banned.' };
        }
      }
      return actionView(updated!);
    });
    if (outcomeMail) this.#mail(outcomeMail);
    return result;
  }
}

/** Steps that touched an account need an admin to undo too. */
function needsAdminToReverse(action: Row): boolean {
  const e = json<Effects>(action.effects) ?? ({} as Effects);
  return Boolean(e.suspendedUntil || e.banned || e.ratings?.scope === 'account' || e.content === 'reset_profile');
}

async function recomputeRatedWorks(tx: Db, userId: string): Promise<void> {
  await tx.execute(sql`
    SELECT recompute_work_stats_for_work(w.work_id)
    FROM (SELECT DISTINCT work_id FROM reads WHERE user_id = ${userId}::uuid AND rating IS NOT NULL) w`);
}

function typedReason(reason: string | undefined): string {
  const r = reason?.trim() ?? '';
  if (r.length < MIN_ACTION_REASON) {
    throw ApiError.unprocessable('reason_required', `Give a reason of at least ${MIN_ACTION_REASON} characters (kept in the audit log).`, 'reason');
  }
  return r;
}

function pgArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((s) => s.replace(/^"|"$/g, ''));
}

/** Dates as ISO strings, everything else as is (the case's subject, for the console). */
function plain(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
}

export interface ReportView {
  id: string;
  subject_type: SubjectType;
  subject_id: string;
  reason: ReportReason;
  /** PRD §27.6: open, or reviewed — never what was decided about someone else. */
  status: 'open' | 'reviewed';
  created_at: string;
  reviewed_at: string | null;
}

function reportView(r: Row): ReportView {
  return {
    id: String(r.id),
    subject_type: r.subject_type as SubjectType,
    subject_id: String(r.subject_id),
    reason: r.reason as ReportReason,
    status: r.state === 'open' ? 'open' : 'reviewed',
    created_at: iso(r.created_at)!,
    reviewed_at: r.state === 'open' ? null : iso(r.resolved_at),
  };
}

export interface NoticeView {
  id: string;
  subject_type: SubjectType;
  subject_id: string;
  rule: Rule;
  rule_label: string;
  summary: string;
  consequences: string[];
  created_at: string;
  reversed: boolean;
  can_appeal: boolean;
  appeal: { state: 'pending' | 'upheld' | 'overturned'; body: string; appealed_at: string; resolved_at: string | null } | null;
}

function noticeView(r: Row): NoticeView {
  const e = json<Effects>(r.effects) ?? ({} as Effects);
  const rule = r.rule as Rule;
  return {
    id: String(r.id),
    subject_type: r.subject_type as SubjectType,
    subject_id: String(r.subject_id),
    rule,
    rule_label: RULE_LABELS[rule],
    summary: e.summary ?? '',
    consequences: e.consequences ?? [],
    created_at: iso(r.created_at)!,
    reversed: r.reversed_at !== null && r.reversed_at !== undefined,
    can_appeal: (r.appeal_state === null || r.appeal_state === undefined) && !r.reversed_at,
    appeal: r.appeal_state
      ? {
          state: r.appeal_state as 'pending' | 'upheld' | 'overturned',
          body: String(r.appeal_body ?? ''),
          appealed_at: iso(r.appealed_at)!,
          resolved_at: iso(r.appeal_resolved_at),
        }
      : null,
  };
}

function actionView(r: Row) {
  return {
    id: String(r.id),
    subject_type: r.subject_type as SubjectType,
    subject_id: String(r.subject_id),
    target_user_id: r.target_user_id ? String(r.target_user_id) : null,
    decision: r.decision as 'dismiss' | 'enforce' | 'resolve',
    rule: (r.rule as Rule | null) ?? null,
    step: r.step === null || r.step === undefined ? null : Number(r.step),
    effects: json<Row>(r.effects) ?? {},
    reason: String(r.reason),
    created_at: iso(r.created_at)!,
    reversed_at: iso(r.reversed_at),
    appeal: r.appeal_state
      ? { state: String(r.appeal_state), body: String(r.appeal_body ?? ''), appealed_at: iso(r.appealed_at)!, resolved_at: iso(r.appeal_resolved_at) }
      : null,
  };
}

