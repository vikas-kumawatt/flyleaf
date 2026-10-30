// Admin merge review and dedupe routes (FN-51, PRD §40.3, §3715–§3721).
//
// Provides both typed REST API endpoints for queue management and 30-day undo,
// and a server-rendered web interface at /admin/merges.

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
import { ApiError, requireAdmin, requireModerator, requireViewer } from '../http.js';
import { auditContext, logAdminAction } from './auth.js';
import { adminPage, escapeHtml, sendAdminHtml } from './html.js';
import {
  getDedupeQueue,
  previewMerge,
  resolveQueueItem,
  queueReportedDuplicate,
  getRecentMerges,
  undoMerge,
} from '../catalog/dedupe.js';
import {
  dedupeQueueListResponseSchema,
  dedupeQueueQuerySchema,
  dedupePreviewResponseSchema,
  dedupeResolveBodySchema,
  dedupeResolveResponseSchema,
  dedupeReportBodySchema,
  dedupeReportResponseSchema,
  mergeListResponseSchema,
  undoMergeResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

const queueQuery = z.object({
  status: z.enum(['pending', 'merged', 'dismissed']).optional(),
  stage: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

const resolveBody = z.object({
  action: z.enum(['merge', 'dismiss']),
  reason: z.string().optional(),
});

const reportBody = z.object({
  survivor_id: z.string().uuid(),
  loser_id: z.string().uuid(),
  reason: z.string().min(3),
});

const STAGE_LABELS: Record<number, string> = {
  1: 'Shared ISBN, ambiguous',
  2: 'Title + author, ambiguous',
  3: 'Probable Fuzzy',
  4: 'User Reported',
};

const mergesQuery = z.object({
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

/**
 * Every merge, dismissal and undo carries a reason into the audit row (PRD
 * §27.5, D-06-1). A pair a rule queued (stages 1-3) defaults to that rule; a
 * user-reported pair (stage 4, a manual merge) and every undo need a typed
 * reason of at least MIN_TYPED_REASON characters.
 */
export const MIN_TYPED_REASON = 10;

const RULE_REASONS: Record<number, string> = {
  1: 'stage 1: shared ISBN',
  2: 'stage 2: title + author',
  3: 'stage 3: probable fuzzy match',
};

export function ruleReason(stage: number): string | undefined {
  return RULE_REASONS[stage];
}

function typedReason(reason: string | undefined, what: string): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < MIN_TYPED_REASON) {
    throw ApiError.unprocessable(
      'reason_required',
      `Give a reason of at least ${MIN_TYPED_REASON} characters for ${what}.`,
      'reason',
    );
  }
  return trimmed;
}

const undoBody = z.object({ reason: z.string().optional() }).optional();

export function adminDedupeRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    // -----------------------------------------------------------------------
    // REST Endpoints
    // -----------------------------------------------------------------------

    app.get(
      '/v1/admin/dedupe/queue',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'List dedupe review queue',
          description: 'Lists pending or resolved duplicate candidates, highest impact first: stage 1-2 pairs too ambiguous to auto-merge, and stages 3 and 4.',
          querystring: dedupeQueueQuerySchema,
          response: {
            200: dedupeQueueListResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        const query = queueQuery.parse(req.query);
        const data = await getDedupeQueue(db, query);
        return { data };
      },
    );

    app.get<{ Params: { survivorId: string; loserId: string } }>(
      '/v1/admin/dedupe/preview/:survivorId/:loserId',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'Preview merge impact',
          description: 'Forecasts read moves, collision handling, and metadata merging side by side.',
          params: {
            type: 'object',
            properties: {
              survivorId: { type: 'string', format: 'uuid' },
              loserId: { type: 'string', format: 'uuid' },
            },
            required: ['survivorId', 'loserId'],
          },
          response: {
            200: dedupePreviewResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        return previewMerge(db, req.params.survivorId, req.params.loserId);
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/admin/dedupe/queue/:id/resolve',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'Resolve dedupe candidate',
          description: 'Approves merge or dismisses duplicate candidate with reason. Requires administrator role. The reason is stored in the audit log: for a pair a rule queued (stages 1-3) it defaults to that rule; a user-reported pair (stage 4) needs a typed reason of at least 10 characters (422 reason_required).',
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
            required: ['id'],
          },
          body: dedupeResolveBodySchema,
          response: {
            200: dedupeResolveResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            422: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const admin = requireAdmin(req);
        const body = resolveBody.parse(req.body);
        const [item] = await db.execute<{ stage: number }>(sql`
          SELECT stage FROM dedupe_queue WHERE id = ${req.params.id}`);
        if (!item) throw ApiError.notFound('Queue item not found.');
        // D-06-1: a rule's pair defaults to the rule; anything else is typed.
        const typed = body.reason?.trim();
        const rule = ruleReason(item.stage);
        const reason = typed || !rule ? typedReason(typed, `a ${body.action === 'merge' ? 'manual merge' : 'dismissal'}`) : rule;
        // The action and its audit row commit together (A-06-026): the
        // service's own transaction becomes a savepoint inside this one.
        return db.transaction(async (tx) => {
          const result = await resolveQueueItem(tx as unknown as Db, req.params.id, body.action, {
            reviewerUserId: admin.id,
            reason,
          });

          // Audit log action (FN-93)
          await logAdminAction(tx, {
            actorId: admin.id,
            action: body.action === 'merge' ? 'catalog.merge' : 'catalog.dismiss_duplicate',
            subjectType: 'dedupe_queue',
            subjectId: req.params.id,
            reason,
            payload: {
              queueId: req.params.id,
              action: body.action,
              mergeId: result.merge_id ?? result.mergeId,
            },
            ...auditContext(req),
          });

          return result;
        });
      },
    );

    app.post(
      '/v1/admin/dedupe/report',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'Report duplicate work (Stage 4)',
          description: 'Queues a candidate duplicate pair reported by a user or moderator.',
          body: dedupeReportBodySchema,
          response: {
            200: dedupeReportResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        // Staff or a signed-in user (the §6.46 correction flow); never a guest.
        const reporterId = req.admin?.id ?? requireViewer(req);
        const body = reportBody.parse(req.body);
        const result = await queueReportedDuplicate(db, {
          survivorId: body.survivor_id,
          loserId: body.loser_id,
          reason: body.reason,
          reporterUserId: reporterId,
        });

        if (req.admin) {
          await logAdminAction(db, {
            actorId: req.admin.id,
            action: 'catalog.report_duplicate',
            subjectType: 'work',
            subjectId: body.survivor_id,
            reason: body.reason,
            payload: { loserId: body.loser_id, queueId: result.id },
            ...auditContext(req),
          });
        }

        return result;
      },
    );

    app.get(
      '/v1/admin/merges',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'List recent merges',
          description: 'Lists applied merges with 30-day undo eligibility.',
          querystring: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
          response: {
            200: mergeListResponseSchema,
            401: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        const query = mergesQuery.parse(req.query);
        const data = await getRecentMerges(db, query);
        return { data };
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/admin/merges/:id/undo',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'Undo work merge',
          description: 'Reverses a work merge within 30 days, restoring the loser and original reads. Requires administrator role and a typed reason of at least 10 characters, stored in the audit log.',
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
            required: ['id'],
          },
          body: {
            type: 'object',
            properties: {
              reason: { type: 'string', minLength: MIN_TYPED_REASON, maxLength: 1000, description: 'Why the merge is reversed' },
            },
            required: ['reason'],
          },
          response: {
            200: undoMergeResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
        // Role before body validation: a moderator gets 403, not a 422 about the reason.
        preValidation: async (req) => {
          requireAdmin(req);
        },
      },
      async (req) => {
        const admin = requireAdmin(req);
        const reason = typedReason(undoBody.parse(req.body)?.reason, 'an undo');
        // The undo and its audit row commit together (A-06-026).
        const result = await db.transaction(async (tx) => {
          const undone = await undoMerge(tx as unknown as Db, req.params.id);

          // Audit log action (FN-93)
          await logAdminAction(tx, {
            actorId: admin.id,
            action: 'catalog.undo_merge',
            subjectType: 'work',
            subjectId: undone.survivor_id,
            reason,
            payload: {
              mergeId: req.params.id,
              loserId: undone.loser_id,
              restored: undone.restored,
            },
            ...auditContext(req),
          });
          return undone;
        });

        return result;
      },
    );

    // -----------------------------------------------------------------------
    // Server-Rendered Admin Review UI (PRD §3715–§3721)
    // -----------------------------------------------------------------------

    app.get('/admin/merges', { schema: { hide: true } }, async (req, reply) => {
      if (!req.admin) {
        return reply.redirect('/admin/login');
      }

      const admin = req.admin;
      const isAdmin = admin.role === 'admin';
      const [queueItems, recentMerges] = await Promise.all([
        getDedupeQueue(db, { status: 'pending', limit: 20 }),
        getRecentMerges(db, { limit: 15 }),
      ]);

      return sendAdminHtml(reply, (nonce) =>
        adminPage({
          title: 'Merge review',
          path: '/admin/merges',
          admin,
          css: `
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .side { display: flex; flex-direction: column; gap: 4px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
    .side h3 { font-family: Newsreader, Georgia, serif; font-size: 17px; }
    @media (max-width: 900px) { .pair { grid-template-columns: 1fr; } }`,
          body: `
    <div class="page-head">
      <div>
        <h1>Merge review</h1>
        <p class="sub">Fuzzy duplicate candidates from stages 3 and 4, and merges you can still undo within 30 days</p>
      </div>
    </div>

    ${!isAdmin ? `<div class="notice">You can review candidates as a moderator. Approving, dismissing or undoing a merge needs an administrator</div>` : ''}

    <section class="stack">
      <h2>Review queue</h2>
    ${
      queueItems.length === 0
        ? '<div class="card"><p class="meta">The queue is empty. Every candidate has been resolved</p></div>'
        : queueItems
            .map(
              (item) => `
      <div class="card stack" id="item-${escapeHtml(item.id)}">
        <div class="between">
          <div class="row" style="gap: 16px;">
            <span class="status ${item.stage === 3 ? 'accent' : 'warning'}">Stage ${escapeHtml(item.stage)} · ${escapeHtml(STAGE_LABELS[item.stage] ?? 'Unknown')}</span>
            <span class="meta">Impact ${escapeHtml(item.impact)}</span>
            ${item.confidence != null ? `<span class="meta">Confidence ${(item.confidence * 100).toFixed(0)}%</span>` : ''}
          </div>
          <span class="mono meta">${escapeHtml(item.createdAt.slice(0, 10))}</span>
        </div>

        <div class="pair">
          <div class="side">
            <span class="status positive">Survivor, kept</span>
            <h3>${escapeHtml(item.survivor.title)}</h3>
            <p class="meta">${escapeHtml(item.survivor.authors.join(', ') || 'Unknown author')}</p>
            <p class="meta">Published ${escapeHtml(item.survivor.firstPublishYear ?? '—')} · ${escapeHtml(item.survivor.editionCount)} editions · ${escapeHtml(item.survivor.logCount)} logs</p>
          </div>
          <div class="side">
            <span class="status">Loser, tombstoned</span>
            <h3>${escapeHtml(item.loser.title)}</h3>
            <p class="meta">${escapeHtml(item.loser.authors.join(', ') || 'Unknown author')}</p>
            <p class="meta">Published ${escapeHtml(item.loser.firstPublishYear ?? '—')} · ${escapeHtml(item.loser.editionCount)} editions · ${escapeHtml(item.loser.logCount)} logs</p>
          </div>
        </div>

        <p class="meta">Rule match: <span style="color: var(--ink2);">${escapeHtml(item.reason)}</span></p>

        <div class="row">
          ${
            isAdmin
              ? `<button class="primary" data-resolve="${escapeHtml(item.id)}" data-action="merge" data-rule="${escapeHtml(ruleReason(item.stage) ?? '')}">Approve merge</button>
                 <button data-resolve="${escapeHtml(item.id)}" data-action="dismiss" data-rule="${escapeHtml(ruleReason(item.stage) ?? '')}">Dismiss</button>`
              : `<button disabled title="Needs an administrator">Approve merge</button>
                 <button disabled title="Needs an administrator">Dismiss</button>`
          }
        </div>
      </div>
    `,
            )
            .join('')
    }
    </section>

    <section class="stack">
      <h2>Recent merges</h2>
      <div class="card flush table-wrap">
        <table>
          <thead>
            <tr>
              <th>Merged</th>
              <th>Survivor</th>
              <th>Loser</th>
              <th>Rule</th>
              <th>Moved</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
          ${
            recentMerges.length === 0
              ? '<tr><td colspan="7" class="empty">No merges yet</td></tr>'
              : recentMerges
                  .map(
                    (m) => `
            <tr>
              <td class="nowrap mono meta">${escapeHtml(m.merged_at.slice(0, 16).replace('T', ' '))}</td>
              <td>${escapeHtml(m.survivor.title)}</td>
              <td class="meta">${escapeHtml(m.loser.title)}</td>
              <td class="nowrap">Stage ${escapeHtml(m.stage)}</td>
              <td class="meta">${escapeHtml(m.stats.reads_moved)} reads, ${escapeHtml(m.stats.editions_moved)} editions</td>
              <td>
                ${
                  m.undone_at
                    ? `<span class="status">Undone</span>`
                    : m.can_undo
                    ? `<span class="status positive">Reversible</span>`
                    : `<span class="status">Permanent</span>`
                }
              </td>
              <td class="num">
                ${
                  m.can_undo && isAdmin
                    ? `<button class="danger sm" data-undo="${escapeHtml(m.id)}">Undo merge</button>`
                    : m.can_undo
                    ? `<span class="meta">Needs an administrator</span>`
                    : `<span class="meta">—</span>`
                }
              </td>
            </tr>
          `,
                  )
                  .join('')
          }
          </tbody>
        </table>
      </div>
    </section>

  <script nonce="${nonce}">
    // Every action carries a reason into the audit log (D-06-1): a rule's
    // pair starts from the rule, a reported pair and an undo need ${MIN_TYPED_REASON}+ typed characters.
    function askReason(question, prefill) {
      const reason = prompt(question, prefill || '');
      if (reason === null) return null;
      if (reason.trim().length < ${MIN_TYPED_REASON}) {
        alert('Give a reason of at least ${MIN_TYPED_REASON} characters.');
        return null;
      }
      return reason.trim();
    }

    async function resolveCandidate(id, action, rule) {
      const reason = askReason('Reason to ' + action + ' this candidate (kept in the audit log):', rule);
      if (reason === null) return;
      try {
        const res = await fetch('/v1/admin/dedupe/queue/' + id + '/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, reason })
        });
        if (res.ok) {
          document.getElementById('item-' + id)?.remove();
          location.reload();
        } else {
          const err = await res.json();
          alert('Could not resolve the candidate: ' + (err.error?.message || res.statusText));
        }
      } catch (err) {
        alert('Could not reach the server: ' + err.message);
      }
    }

    async function undoMergeAction(id) {
      const reason = askReason('Undo this merge? The loser work and all reads will be restored. Reason (kept in the audit log):', '');
      if (reason === null) return;
      try {
        const res = await fetch('/v1/admin/merges/' + id + '/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        if (res.ok) {
          alert('Merge undone');
          location.reload();
        } else {
          const err = await res.json();
          alert('Could not undo the merge: ' + (err.error?.message || res.statusText));
        }
      } catch (err) {
        alert('Could not reach the server: ' + err.message);
      }
    }

    // No inline handlers: the CSP allows only this nonced block (Audit 06).
    document.addEventListener('click', (e) => {
      const resolve = e.target.closest('[data-resolve]');
      if (resolve) return resolveCandidate(resolve.dataset.resolve, resolve.dataset.action, resolve.dataset.rule);
      const undo = e.target.closest('[data-undo]');
      if (undo) return undoMergeAction(undo.dataset.undo);
    });
  </script>`,
        }),
      );
    });
  };
}

