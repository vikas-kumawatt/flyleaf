// Admin catalog and ingestion routes (FN-92, PRD §7.8, §7.9, §27.5).
//
// Provides:
// 1. REST API endpoints for catalog works search, detail, maturity override, and ingestion status.
// 2. Server-rendered HTML web views for maturity review and ingestion status dashboard.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
import { requireAdmin, requireModerator } from '../http.js';
import { auditContext } from './auth.js';
import { adminPage, escapeHtml, sendAdminHtml } from './html.js';
import {
  listCatalogWorks,
  getCatalogWorkDetail,
  overrideWorkMaturity,
  getIngestDashboardStatus,
  VALID_MATURITIES,
  type MaturityRating,
} from './catalog.js';
import {
  adminCatalogWorksQuerySchema,
  adminCatalogWorksListResponseSchema,
  adminCatalogWorkResponseSchema,
  adminMaturityOverrideBodySchema,
  adminMaturityOverrideResponseSchema,
  adminIngestStatusResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

const worksQuery = z.object({
  maturity: z.enum(['general', 'mature', 'explicit', 'unclassified']).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

const maturityOverrideBody = z.object({
  maturity: z.enum(['general', 'mature', 'explicit', 'unclassified']),
  reason: z.string().min(3),
});

function checkAdminSessionCookie(req: any, reply: FastifyReply): { id: string; email: string; role: string } | null {
  if (!req.admin) {
    reply.redirect('/admin/login', 302);
    return null;
  }
  return req.admin;
}

export function adminCatalogRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    // -----------------------------------------------------------------------
    // REST API Endpoints
    // -----------------------------------------------------------------------

    app.get(
      '/v1/admin/catalog/works',
      {
        schema: {
          tags: ['Admin Catalog'],
          summary: 'List catalog works for maturity review',
          description: 'Lists or searches catalog works filtered by maturity rating and text query.',
          querystring: adminCatalogWorksQuerySchema,
          response: {
            200: adminCatalogWorksListResponseSchema,
            401: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        const query = worksQuery.parse(req.query);
        return listCatalogWorks(db, query);
      },
    );

    app.get(
      '/v1/admin/catalog/works/:id',
      {
        schema: {
          tags: ['Admin Catalog'],
          summary: 'Get work detail for maturity review',
          description: 'Returns full work metadata, subjects, editions count, provenance lock, and audit history.',
          params: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' } },
            required: ['id'],
          },
          response: {
            200: adminCatalogWorkResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        const { id } = req.params as { id: string };
        const work = await getCatalogWorkDetail(db, id);
        return { work };
      },
    );

    app.post(
      '/v1/admin/catalog/works/:id/maturity',
      {
        schema: {
          tags: ['Admin Catalog'],
          summary: 'Override work maturity classification',
          description: 'Overrides work maturity, locks field provenance, and records non-negotiable audit log. Requires admin role.',
          params: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' } },
            required: ['id'],
          },
          body: adminMaturityOverrideBodySchema,
          response: {
            200: adminMaturityOverrideResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const admin = requireAdmin(req);
        const { id } = req.params as { id: string };
        const body = maturityOverrideBody.parse(req.body);

        return overrideWorkMaturity(db, {
          workId: id,
          maturity: body.maturity as MaturityRating,
          reason: body.reason,
          actor: admin,
          context: auditContext(req),
        });
      },
    );

    app.get(
      '/v1/admin/ingest/status',
      {
        schema: {
          tags: ['Admin Ingest'],
          summary: 'Get ingestion status and system telemetry',
          description: 'Returns dump runs history, catalog totals, maturity breakdown, and circuit breaker status.',
          response: {
            200: adminIngestStatusResponseSchema,
            401: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        return getIngestDashboardStatus(db);
      },
    );

    // -----------------------------------------------------------------------
    // Server-Rendered HTML Console Views
    // -----------------------------------------------------------------------

    app.get('/admin/catalog/maturity', { schema: { hide: true } }, async (req, reply) => {
      const admin = checkAdminSessionCookie(req, reply);
      if (!admin) return;

      // A hand-edited query string shows the unfiltered list, never a 500.
      const parsed = worksQuery.safeParse(req.query);
      const query = parsed.success ? parsed.data : {};
      const activeMaturity = query.maturity ?? '';
      const searchQuery = query.q ?? '';

      const { works, total } = await listCatalogWorks(db, {
        maturity: activeMaturity || undefined,
        q: searchQuery || undefined,
        limit: 30,
      });

      const canOverride = admin.role === 'admin';

      const maturityBadge = (m: string) => {
        if (m === 'general') return '<span class="status positive">General</span>';
        if (m === 'mature') return '<span class="status warning">Mature</span>';
        if (m === 'explicit') return '<span class="status critical">Explicit</span>';
        return '<span class="status">Unclassified</span>';
      };

      const chip = (value: string, label: string) =>
        `<a href="/admin/catalog/maturity${value ? `?maturity=${value}` : ''}" class="chip ${activeMaturity === value ? 'active' : ''}">${label}</a>`;

      return sendAdminHtml(reply, (nonce) =>
        adminPage({
          title: 'Maturity review',
          path: '/admin/catalog/maturity',
          admin,
          body: `
    <div class="page-head">
      <div>
        <h1>Maturity review</h1>
        <p class="sub">Check and override how each work is classified. An override is locked against re-ingestion</p>
      </div>
      ${!canOverride ? '<span class="status warning">Read only for moderators</span>' : ''}
    </div>

    <div class="between">
      <div class="chips">
        ${chip('', 'All works')}
        ${chip('unclassified', 'Unclassified')}
        ${chip('explicit', 'Explicit')}
        ${chip('mature', 'Mature')}
        ${chip('general', 'General')}
      </div>
      <form method="GET" action="/admin/catalog/maturity" class="row">
        ${activeMaturity ? `<input type="hidden" name="maturity" value="${escapeHtml(activeMaturity)}">` : ''}
        <input type="text" name="q" placeholder="Title or author" aria-label="Search title or author" value="${escapeHtml(searchQuery)}" style="width: 240px;">
        <button type="submit">Search</button>
      </form>
    </div>

    <div class="card flush">
      <div class="card-head">
        <span class="meta">${escapeHtml(works.length)} of ${escapeHtml(total)} works</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Work</th>
              <th>Author</th>
              <th class="num">Year</th>
              <th class="num">Logs</th>
              <th>Rating</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              works.length === 0
                ? `<tr><td colspan="7" class="empty">No works match these filters</td></tr>`
                : works
                    .map(
                      (w) => `
              <tr>
                <td>
                  <div>${escapeHtml(w.title)}</div>
                  ${w.subtitle ? `<div class="meta">${escapeHtml(w.subtitle)}</div>` : ''}
                </td>
                <td style="color: var(--ink2);">${escapeHtml(w.author_name)}</td>
                <td class="num meta">${escapeHtml(w.first_publish_year ?? '—')}</td>
                <td class="num meta">${escapeHtml(w.log_count)}</td>
                <td>${maturityBadge(w.maturity)}</td>
                <td>${w.is_locked ? '<span class="status accent">Overridden</span>' : '<span class="meta">Ingest default</span>'}</td>
                <td class="num">
                  <button class="sm" ${!canOverride ? 'disabled' : ''} data-override="${escapeHtml(w.id)}" data-title="${escapeHtml(w.title)}" data-maturity="${escapeHtml(w.maturity)}">Override</button>
                </td>
              </tr>
            `,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>

  <div id="overrideModal" class="modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="overrideTitle">
    <div class="modal-panel">
      <div>
        <h2 id="overrideTitle">Override maturity</h2>
        <p id="modalWorkTitle" class="meta"></p>
      </div>
      <form id="overrideForm" class="stack">
        <input type="hidden" id="modalWorkId" name="work_id">
        <label>New rating
          <select id="modalRating">
            <option value="general">General · ordinary literature</option>
            <option value="mature">Mature · adult themes handled seriously</option>
            <option value="explicit">Explicit · primary purpose is sexual content</option>
            <option value="unclassified">Unclassified · borderline, needs review</option>
          </select>
        </label>
        <label>Reason, kept in the audit trail
          <textarea id="modalReason" rows="3" required minlength="3" placeholder="Why this rating"></textarea>
        </label>
        <div class="row" style="justify-content: flex-end;">
          <button type="button" id="modalCancelBtn" class="ghost">Cancel</button>
          <button type="submit" id="modalSubmitBtn" class="primary">Save and lock</button>
        </div>
      </form>
    </div>
  </div>

  <script nonce="${nonce}">
    function openOverrideModal(id, title, currentMaturity) {
      document.getElementById('modalWorkId').value = id;
      document.getElementById('modalWorkTitle').textContent = title;
      document.getElementById('modalRating').value = currentMaturity;
      document.getElementById('modalReason').value = '';
      document.getElementById('overrideModal').style.display = 'flex';
    }

    function closeOverrideModal() {
      document.getElementById('overrideModal').style.display = 'none';
    }

    async function submitOverride(e) {
      e.preventDefault();
      const id = document.getElementById('modalWorkId').value;
      const maturity = document.getElementById('modalRating').value;
      const reason = document.getElementById('modalReason').value.trim();
      const btn = document.getElementById('modalSubmitBtn');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        const res = await fetch('/v1/admin/catalog/works/' + id + '/maturity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maturity, reason })
        });
        if (!res.ok) {
          const err = await res.json();
          alert('Could not save the override: ' + (err.error?.message || res.statusText));
          btn.disabled = false;
          btn.textContent = 'Save and lock';
          return;
        }
        window.location.reload();
      } catch (err) {
        alert('Could not reach the server: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Save and lock';
      }
    }

    // No inline handlers: the CSP allows only this nonced block (Audit 06).
    // The title travels in a data attribute and lands via textContent.
    document.addEventListener('click', (e) => {
      const open = e.target.closest('[data-override]');
      if (open && !open.disabled) openOverrideModal(open.dataset.override, open.dataset.title, open.dataset.maturity);
    });
    document.getElementById('modalCancelBtn').addEventListener('click', closeOverrideModal);
    document.getElementById('overrideForm').addEventListener('submit', submitOverride);
  </script>`,
        }),
      );
    });

    app.get('/admin/ingest', { schema: { hide: true } }, async (req, reply) => {
      const admin = checkAdminSessionCookie(req, reply);
      if (!admin) return;

      const status = await getIngestDashboardStatus(db);

      const breakerBadge = (s: string) => {
        if (s === 'closed') return '<span class="status positive">Closed · healthy</span>';
        if (s === 'half-open') return '<span class="status warning">Half-open · probing</span>';
        return '<span class="status critical">Open · failing fast</span>';
      };

      const runStatusBadge = (s: string) => {
        if (s === 'done') return '<span class="status positive">Done</span>';
        if (s === 'running') return '<span class="status accent">Running</span>';
        if (s === 'interrupted') return '<span class="status warning">Interrupted</span>';
        return '<span class="status critical">Failed</span>';
      };

      // Planner estimates on a large catalog (A-06-013): say so on the page.
      const approx = status.counts_are_estimates ? '≈ ' : '';
      const formatNum = (n: number) => escapeHtml(Number(n).toLocaleString());

      const mb = status.maturity_breakdown;
      const cb = status.telemetry.circuit_breaker;
      const lim = status.telemetry.outbound_limiter;

      return sendAdminHtml(reply, () =>
        adminPage({
          title: 'Ingestion',
          path: '/admin/ingest',
          admin,
          css: `
    .split { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; }
    .bars { display: flex; flex-direction: column; gap: 12px; }
    .bar-row { display: grid; grid-template-columns: 120px 1fr 96px; align-items: center; gap: 12px; font-size: 13px; }
    .bar { height: 6px; border-radius: 3px; background: var(--raised); overflow: hidden; }
    .bar > span { display: block; height: 100%; background: var(--ink2); }
    .bar-row.lead .bar > span { background: var(--accent); }
    @media (max-width: 1000px) { .split { grid-template-columns: 1fr; } }`,
          body: `
    <div class="page-head">
      <div>
        <h1>Ingestion</h1>
        <p class="sub">Dump runs, catalog totals, maturity mix and the outbound circuit breaker</p>
      </div>
    </div>

    <div class="kpis">
      <div class="card kpi">
        <div class="label">Circuit breaker</div>
        <div style="margin-top: 12px;">${breakerBadge(cb.state)}</div>
        <div class="note">${escapeHtml(cb.threshold)} failures to open · ${escapeHtml(cb.cooldown_seconds)}s cooldown</div>
      </div>
      <div class="card kpi">
        <div class="label">Works</div>
        <div class="value">${approx}${formatNum(status.catalog.works_count)}</div>
        <div class="note">${formatNum(status.catalog.works_with_cover_count)} with covers · ${formatNum(status.catalog.editions_count)} editions</div>
      </div>
      <div class="card kpi">
        <div class="label">Authors</div>
        <div class="value">${approx}${formatNum(status.catalog.authors_count)}</div>
        <div class="note">${formatNum(status.catalog.authorship_links_count)} links · ${formatNum(status.telemetry.pending_work_authors_count)} waiting to resolve</div>
      </div>
      <div class="card kpi">
        <div class="label">Raw payloads</div>
        <div class="value">${approx}${formatNum(status.catalog.raw_payloads_count)}</div>
        <div class="note">${formatNum(status.telemetry.dedupe_queue_pending_count)} duplicate pairs waiting for review</div>
      </div>
    </div>

    <div class="split">
      <div class="card">
        <h2>Maturity mix</h2>
        <div class="bars">
          ${(() => {
            const rows: [string, number][] = [
              ['General', mb.general],
              ['Mature', mb.mature],
              ['Explicit', mb.explicit],
              ['Unclassified', mb.unclassified],
            ];
            const max = Math.max(1, ...rows.map(([, n]) => Number(n)));
            return rows
              .map(
                ([label, n]) => `
          <div class="bar-row${label === 'Unclassified' ? ' lead' : ''}">
            <span style="color: var(--ink2);">${label}</span>
            <span class="bar"><span style="width: ${((Number(n) / max) * 100).toFixed(1)}%;"></span></span>
            <span class="num" style="text-align: right; font-variant-numeric: tabular-nums;">${approx}${formatNum(n)}</span>
          </div>`,
              )
              .join('');
          })()}
        </div>
        <p class="meta" style="margin-top: 16px;">${formatNum(mb.overridden_locked)} works carry a locked override in <code>field_provenance</code></p>
      </div>

      <div class="card stack">
        <h2>Outbound headroom</h2>
        <div>
          <div class="meta">Sustained rate</div>
          <div style="font-size: 20px; font-weight: 500; font-variant-numeric: tabular-nums;">${escapeHtml(lim.rate_per_second)} req/s</div>
        </div>
        <div>
          <div class="meta">Burst</div>
          <div style="font-size: 20px; font-weight: 500; font-variant-numeric: tabular-nums;">${escapeHtml(lim.burst)} tokens</div>
        </div>
        <p class="meta">Shared by gap-fill and admin enrichment</p>
      </div>
    </div>

    <div class="card flush">
      <div class="card-head">
        <h2>Recent dump runs</h2>
        <span class="meta">${escapeHtml(status.runs_summary.total_runs)} runs · ${escapeHtml(status.runs_summary.completed)} done · ${escapeHtml(status.runs_summary.failed)} failed</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Dump</th>
              <th class="num">Lines read</th>
              <th class="num">Rows written</th>
              <th class="num">Rows skipped</th>
              <th class="num">Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            ${
              status.recent_runs.length === 0
                ? `<tr><td colspan="7" class="empty">No dump runs yet</td></tr>`
                : status.recent_runs
                    .map(
                      (r) => `
              <tr>
                <td>${runStatusBadge(r.status)}</td>
                <td>${escapeHtml(r.dump_type)}</td>
                <td class="num">${formatNum(r.lines_read)}</td>
                <td class="num">${formatNum(r.rows_written)}</td>
                <td class="num meta">${formatNum(r.rows_skipped)}</td>
                <td class="num">${r.duration_seconds !== null ? `${escapeHtml(r.duration_seconds)}s` : '—'}</td>
                <td class="nowrap mono meta">${escapeHtml(new Date(r.started_at).toLocaleString())}</td>
              </tr>
            `,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>`,
        }),
      );
    });
  };
}
