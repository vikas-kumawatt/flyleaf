// Admin merge review and dedupe routes (FN-51, PRD §40.3, §3715–§3721).
//
// Provides both typed REST API endpoints for queue management and 30-day undo,
// and a server-rendered web interface at /admin/merges.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
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

const mergesQuery = z.object({
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

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
          description: 'Lists pending or resolved Stage 3 & 4 duplicate candidates.',
          querystring: dedupeQueueQuerySchema,
          response: {
            200: dedupeQueueListResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
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
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        return previewMerge(db, req.params.survivorId, req.params.loserId);
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/admin/dedupe/queue/:id/resolve',
      {
        schema: {
          tags: ['Admin Dedupe'],
          summary: 'Resolve dedupe candidate',
          description: 'Approves merge or dismisses duplicate candidate with reason.',
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
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const body = resolveBody.parse(req.body);
        return resolveQueueItem(db, req.params.id, body.action, {
          reviewerUserId: req.viewer ?? undefined,
          reason: body.reason,
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
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const body = reportBody.parse(req.body);
        return queueReportedDuplicate(db, {
          survivorId: body.survivor_id,
          loserId: body.loser_id,
          reason: body.reason,
          reporterUserId: req.viewer ?? undefined,
        });
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
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
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
          description: 'Reverses a work merge within 30 days, restoring the loser and original reads.',
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
            required: ['id'],
          },
          response: {
            200: undoMergeResponseSchema,
            400: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        return undoMerge(db, req.params.id);
      },
    );

    // -----------------------------------------------------------------------
    // Server-Rendered Admin Review UI (PRD §3715–§3721)
    // -----------------------------------------------------------------------

    app.get('/admin/merges', async (_req, reply) => {
      const [queueItems, recentMerges] = await Promise.all([
        getDedupeQueue(db, { status: 'pending', limit: 20 }),
        getRecentMerges(db, { limit: 15 }),
      ]);

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flyleaf Admin — Catalog Merges</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --success: #2ea043;
      --danger: #f85149;
      --warning: #d29922;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    header {
      margin-bottom: 28px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { font-size: 22px; color: var(--text-bright); font-weight: 600; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-stage3 { background: rgba(88, 166, 255, 0.2); color: var(--accent); }
    .badge-stage4 { background: rgba(210, 153, 34, 0.2); color: var(--warning); }
    .badge-success { background: rgba(46, 160, 67, 0.2); color: var(--success); }
    .badge-muted { background: rgba(139, 148, 158, 0.2); color: var(--text-muted); }
    
    section { margin-bottom: 40px; }
    h2 { font-size: 18px; color: var(--text-bright); margin-bottom: 16px; }
    
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin: 12px 0;
    }
    .col {
      background: rgba(255, 255, 255, 0.03);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .col h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 4px; }
    .meta { font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
    .reason-box {
      font-size: 13px;
      background: rgba(0, 0, 0, 0.2);
      padding: 8px 12px;
      border-radius: 4px;
      margin-top: 8px;
      color: var(--text);
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 14px;
    }
    button {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    .btn-merge { background: var(--success); color: white; }
    .btn-dismiss { background: transparent; border-color: var(--border); color: var(--text-muted); }
    .btn-undo { background: var(--danger); color: white; }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--text-muted); font-weight: 500; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Flyleaf Admin — Catalog Merges</h1>
      <p class="meta">Review fuzzy duplicate candidates (PRD §40.3 Stage 3/4) &amp; reverse merges within 30 days</p>
    </div>
    <div>
      <span class="badge badge-stage3">${queueItems.length} Queued</span>
    </div>
  </header>

  <section>
    <h2>Review Queue</h2>
    ${
      queueItems.length === 0
        ? '<div class="card"><p class="meta">Review queue is empty. All duplicate candidates resolved.</p></div>'
        : queueItems
            .map(
              (item) => `
      <div class="card" id="item-${item.id}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span class="badge ${item.stage === 3 ? 'badge-stage3' : 'badge-stage4'}">
              Stage ${item.stage} (${item.stage === 3 ? 'Probable Fuzzy' : 'User Reported'})
            </span>
            ${item.confidence != null ? `<span class="meta" style="margin-left: 8px;">Confidence: ${(item.confidence * 100).toFixed(0)}%</span>` : ''}
          </div>
          <span class="meta">${item.createdAt.slice(0, 10)}</span>
        </div>

        <div class="grid-2">
          <div class="col">
            <span class="badge badge-success" style="font-size: 10px; margin-bottom: 4px;">Survivor (Canonical)</span>
            <h3>${escapeHtml(item.survivor.title)}</h3>
            <p class="meta">By: ${escapeHtml(item.survivor.authors.join(', ') || 'Unknown')}</p>
            <p class="meta">Published: ${item.survivor.firstPublishYear ?? '—'} · Editions: ${item.survivor.editionCount} · Logs: ${item.survivor.logCount}</p>
          </div>
          <div class="col">
            <span class="badge badge-muted" style="font-size: 10px; margin-bottom: 4px;">Loser (Will be tombstoned)</span>
            <h3>${escapeHtml(item.loser.title)}</h3>
            <p class="meta">By: ${escapeHtml(item.loser.authors.join(', ') || 'Unknown')}</p>
            <p class="meta">Published: ${item.loser.firstPublishYear ?? '—'} · Editions: ${item.loser.editionCount} · Logs: ${item.loser.logCount}</p>
          </div>
        </div>

        <div class="reason-box">
          <strong>Rule match:</strong> ${escapeHtml(item.reason)}
        </div>

        <div class="actions">
          <button class="btn-merge" onclick="resolveCandidate('${item.id}', 'merge')">Approve Merge</button>
          <button class="btn-dismiss" onclick="resolveCandidate('${item.id}', 'dismiss')">Dismiss</button>
        </div>
      </div>
    `,
            )
            .join('')
    }
  </section>

  <section>
    <h2>Recent Merges (30-Day Undo Window)</h2>
    <div class="card" style="padding: 0; overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>Survivor</th>
            <th>Merged Work (Loser)</th>
            <th>Stage</th>
            <th>Merged Date</th>
            <th>Reads Moved</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${
            recentMerges.length === 0
              ? '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No recent merges.</td></tr>'
              : recentMerges
                  .map(
                    (m) => `
            <tr id="merge-${m.id}">
              <td><strong>${escapeHtml(m.survivor.title)}</strong></td>
              <td>${escapeHtml(m.loser.title)}</td>
              <td>Stage ${m.stage}</td>
              <td>${m.mergedAt.slice(0, 10)}</td>
              <td>${m.stats.readsMoved}</td>
              <td>
                ${
                  m.undoneAt
                    ? '<span class="badge badge-muted">Undone</span>'
                    : m.canUndo
                      ? `<button class="btn-undo" onclick="undoMergeAction('${m.id}')">Undo</button>`
                      : '<span class="badge badge-muted">&gt;30 Days</span>'
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

  <script>
    async function resolveCandidate(id, action) {
      if (!confirm('Are you sure you want to ' + action + ' this candidate?')) return;
      try {
        const res = await fetch('/v1/admin/dedupe/queue/' + id + '/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action })
        });
        if (res.ok) {
          document.getElementById('item-' + id)?.remove();
          location.reload();
        } else {
          const err = await res.json();
          alert('Error: ' + (err.error?.message || 'Failed to resolve candidate.'));
        }
      } catch (err) {
        alert('Network error: ' + err.message);
      }
    }

    async function undoMergeAction(id) {
      if (!confirm('Undo this merge? The loser work and all reads will be restored.')) return;
      try {
        const res = await fetch('/v1/admin/merges/' + id + '/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
          alert('Merge successfully undone.');
          location.reload();
        } else {
          const err = await res.json();
          alert('Error: ' + (err.error?.message || 'Failed to undo merge.'));
        }
      } catch (err) {
        alert('Network error: ' + err.message);
      }
    }
  </script>
</body>
</html>`;

      return reply.type('text/html').send(html);
    });
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
