// Admin catalog and ingestion routes (FN-92, PRD §7.8, §7.9, §27.5).
//
// Provides:
// 1. REST API endpoints for catalog works search, detail, maturity override, and ingestion status.
// 2. Server-rendered HTML web views for maturity review and ingestion status dashboard.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
import { requireAdmin, requireModerator } from '../http.js';
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

export function adminNavbar(currentPath: string, admin: { email: string; role: string }): string {
  const links = [
    { path: '/admin/merges', label: 'Merge Review' },
    { path: '/admin/catalog/maturity', label: 'Maturity Review' },
    { path: '/admin/ingest', label: 'Ingestion Status' },
    { path: '/admin/audit-log', label: 'Audit Trail' },
  ];

  const roleColor = admin.role === 'admin' ? '#38bdf8' : '#fbbf24';

  return `
    <header style="display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 2rem; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 2rem;">
      <div style="display: flex; align-items: center; gap: 2rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <div style="width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #6366f1, #a855f7); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1rem; color: white;">F</div>
          <span style="font-weight: 700; font-size: 1.15rem; letter-spacing: -0.02em;">Flyleaf Console</span>
        </div>
        <nav style="display: flex; gap: 0.5rem;">
          ${links
            .map(
              (l) => `
            <a href="${l.path}" style="padding: 0.5rem 1rem; border-radius: 8px; text-decoration: none; font-size: 0.9rem; font-weight: 500; transition: all 0.2s; ${
              currentPath === l.path
                ? 'background: rgba(99, 102, 241, 0.25); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.4);'
                : 'color: #94a3b8; border: 1px solid transparent;'
            }">${l.label}</a>
          `,
            )
            .join('')}
        </nav>
      </div>
      <div style="display: flex; align-items: center; gap: 1rem;">
        <span style="font-size: 0.85rem; color: #94a3b8;">${admin.email}</span>
        <span style="font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 9999px; background: rgba(255, 255, 255, 0.08); color: ${roleColor}; font-weight: 600; text-transform: uppercase; border: 1px solid ${roleColor}40;">${admin.role}</span>
        <form method="POST" action="/admin/logout" style="margin: 0;">
          <button type="submit" style="padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: transparent; color: #cbd5e1; font-size: 0.8rem; cursor: pointer;">Log out</button>
        </form>
      </div>
    </header>
  `;
}

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

    app.get('/admin/catalog/maturity', async (req, reply) => {
      const admin = checkAdminSessionCookie(req, reply);
      if (!admin) return;

      const query = worksQuery.parse(req.query);
      const activeMaturity = query.maturity ?? '';
      const searchQuery = query.q ?? '';

      const { works, total } = await listCatalogWorks(db, {
        maturity: activeMaturity || undefined,
        q: searchQuery || undefined,
        limit: 30,
      });

      const canOverride = admin.role === 'admin';

      const maturityBadge = (m: string) => {
        if (m === 'general') return '<span style="background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">General</span>';
        if (m === 'mature') return '<span style="background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">Mature</span>';
        if (m === 'explicit') return '<span style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">Explicit</span>';
        return '<span style="background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">Unclassified</span>';
      };

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Maturity Review — Flyleaf Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0b0f19; color: #f1f5f9; min-height: 100vh; padding-bottom: 4rem; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
    .card { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; backdrop-filter: blur(8px); }
    .filter-btn { padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.85rem; font-weight: 500; text-decoration: none; color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(15, 23, 42, 0.6); transition: all 0.2s; }
    .filter-btn.active { background: rgba(99, 102, 241, 0.2); color: #818cf8; border-color: rgba(99, 102, 241, 0.4); }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 0.85rem 1rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; color: #64748b; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
    td { padding: 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.05); font-size: 0.9rem; vertical-align: middle; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .action-btn { padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer; border: 1px solid rgba(99, 102, 241, 0.4); background: rgba(99, 102, 241, 0.15); color: #a5b4fc; transition: all 0.2s; }
    .action-btn:hover:not(:disabled) { background: #6366f1; color: white; }
    .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  </style>
</head>
<body>
  ${adminNavbar('/admin/catalog/maturity', admin)}
  <div class="container">
    <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1.5rem;">
      <div>
        <h1 style="font-size: 1.75rem; font-weight: 700; margin-bottom: 0.35rem;">Catalog Maturity Review</h1>
        <p style="color: #94a3b8; font-size: 0.9rem;">Review and override classification ratings per PRD §7.8 & §27.5. Overrides are locked against re-ingestion.</p>
      </div>
      ${
        !canOverride
          ? '<div style="padding: 0.4rem 0.8rem; border-radius: 8px; background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); color: #fbbf24; font-size: 0.85rem;">🔒 Read-Only (Moderator Role)</div>'
          : ''
      }
    </div>

    <!-- Filters & Search -->
    <div class="card" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;">
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <a href="/admin/catalog/maturity" class="filter-btn ${activeMaturity === '' ? 'active' : ''}">All Works</a>
        <a href="/admin/catalog/maturity?maturity=unclassified" class="filter-btn ${activeMaturity === 'unclassified' ? 'active' : ''}">⚠️ Unclassified (Queue)</a>
        <a href="/admin/catalog/maturity?maturity=explicit" class="filter-btn ${activeMaturity === 'explicit' ? 'active' : ''}">Explicit</a>
        <a href="/admin/catalog/maturity?maturity=mature" class="filter-btn ${activeMaturity === 'mature' ? 'active' : ''}">Mature</a>
        <a href="/admin/catalog/maturity?maturity=general" class="filter-btn ${activeMaturity === 'general' ? 'active' : ''}">General</a>
      </div>
      <form method="GET" action="/admin/catalog/maturity" style="display: flex; gap: 0.5rem;">
        ${activeMaturity ? `<input type="hidden" name="maturity" value="${activeMaturity}">` : ''}
        <input type="text" name="q" placeholder="Search title or author…" value="${searchQuery}" style="padding: 0.5rem 0.85rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(15, 23, 42, 0.8); color: white; font-size: 0.85rem; width: 240px;">
        <button type="submit" class="action-btn">Search</button>
      </form>
    </div>

    <!-- Works List -->
    <div class="card" style="padding: 0; overflow: hidden;">
      <div style="padding: 1rem 1.5rem; border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center;">
        <span style="font-weight: 600; font-size: 0.95rem;">Showing ${works.length} of ${total} works</span>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Work</th>
              <th>Author</th>
              <th>Year</th>
              <th>Logs</th>
              <th>Rating</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${
              works.length === 0
                ? `<tr><td colspan="7" style="text-align: center; color: #64748b; padding: 3rem;">No works found matching current criteria.</td></tr>`
                : works
                    .map(
                      (w) => `
              <tr>
                <td>
                  <div style="font-weight: 600; color: #f8fafc;">${w.title}</div>
                  ${w.subtitle ? `<div style="font-size: 0.8rem; color: #94a3b8;">${w.subtitle}</div>` : ''}
                </td>
                <td style="color: #cbd5e1;">${w.author_name}</td>
                <td style="color: #94a3b8;">${w.first_publish_year ?? '—'}</td>
                <td style="color: #94a3b8;">${w.log_count}</td>
                <td>${maturityBadge(w.maturity)}</td>
                <td>
                  ${
                    w.is_locked
                      ? '<span style="font-size: 0.75rem; color: #38bdf8; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.25); padding: 0.15rem 0.5rem; border-radius: 4px;">🔒 Overridden</span>'
                      : '<span style="font-size: 0.75rem; color: #64748b;">Ingest Default</span>'
                  }
                </td>
                <td>
                  <button class="action-btn" ${!canOverride ? 'disabled' : ''} onclick="openOverrideModal('${w.id}', '${w.title.replace(/'/g, "\\'")}', '${w.maturity}')">Override</button>
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
  </div>

  <!-- Override Modal -->
  <div id="overrideModal" style="display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 100;">
    <div style="background: #1e293b; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 12px; width: 100%; max-width: 480px; padding: 2rem; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
      <h3 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem;">Override Maturity</h3>
      <p id="modalWorkTitle" style="font-size: 0.9rem; color: #94a3b8; margin-bottom: 1.5rem;"></p>
      <form id="overrideForm" onsubmit="submitOverride(event)">
        <input type="hidden" id="modalWorkId" name="work_id">
        <div style="margin-bottom: 1.25rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; color: #cbd5e1; margin-bottom: 0.5rem;">New Rating</label>
          <select id="modalRating" style="width: 100%; padding: 0.6rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.15); background: #0f172a; color: white; font-size: 0.9rem;">
            <option value="general">General (Ordinary literature)</option>
            <option value="mature">Mature (Adult themes handled seriously)</option>
            <option value="explicit">Explicit (Primary purpose is sexual content)</option>
            <option value="unclassified">Unclassified (Borderline / needs review)</option>
          </select>
        </div>
        <div style="margin-bottom: 1.5rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; color: #cbd5e1; margin-bottom: 0.5rem;">Audit Reason (Mandatory per PRD §27.5)</label>
          <textarea id="modalReason" required minlength="3" placeholder="Explain why this maturity rating is being assigned…" style="width: 100%; height: 80px; padding: 0.6rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.15); background: #0f172a; color: white; font-size: 0.85rem; resize: none;"></textarea>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
          <button type="button" onclick="closeOverrideModal()" style="padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.15); background: transparent; color: #cbd5e1; font-size: 0.85rem; cursor: pointer;">Cancel</button>
          <button type="submit" id="modalSubmitBtn" class="action-btn" style="padding: 0.5rem 1.25rem;">Save & Lock</button>
        </div>
      </form>
    </div>
  </div>

  <script>
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
          alert('Error overriding maturity: ' + (err.error?.message || res.statusText));
          btn.disabled = false;
          btn.textContent = 'Save & Lock';
          return;
        }
        window.location.reload();
      } catch (err) {
        alert('Network error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Save & Lock';
      }
    }
  </script>
</body>
</html>`;

      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(html);
    });

    app.get('/admin/ingest', async (req, reply) => {
      const admin = checkAdminSessionCookie(req, reply);
      if (!admin) return;

      const status = await getIngestDashboardStatus(db);

      const breakerBadge = (s: string) => {
        if (s === 'closed') {
          return '<span style="display: inline-flex; align-items: center; gap: 0.5rem; background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); padding: 0.3rem 0.8rem; border-radius: 9999px; font-weight: 600; font-size: 0.85rem;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #4ade80;"></span> Closed (Healthy)</span>';
        }
        if (s === 'half-open') {
          return '<span style="display: inline-flex; align-items: center; gap: 0.5rem; background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); padding: 0.3rem 0.8rem; border-radius: 9999px; font-weight: 600; font-size: 0.85rem;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #facc15;"></span> Half-Open (Probing)</span>';
        }
        return '<span style="display: inline-flex; align-items: center; gap: 0.5rem; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 0.3rem 0.8rem; border-radius: 9999px; font-weight: 600; font-size: 0.85rem;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #f87171;"></span> Open (Failing Fast)</span>';
      };

      const runStatusBadge = (s: string) => {
        if (s === 'done') return '<span style="color: #4ade80; font-weight: 600; font-size: 0.8rem;">✓ DONE</span>';
        if (s === 'running') return '<span style="color: #38bdf8; font-weight: 600; font-size: 0.8rem;">⚡ RUNNING</span>';
        if (s === 'interrupted') return '<span style="color: #facc15; font-weight: 600; font-size: 0.8rem;">⏸ INTERRUPTED</span>';
        return '<span style="color: #f87171; font-weight: 600; font-size: 0.8rem;">✕ FAILED</span>';
      };

      const formatNum = (n: number) => Number(n).toLocaleString();

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ingestion Status & Telemetry — Flyleaf Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0b0f19; color: #f1f5f9; min-height: 100vh; padding-bottom: 4rem; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.25rem; margin-bottom: 1.5rem; }
    .card { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 1.5rem; backdrop-filter: blur(8px); }
    .metric-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; color: #94a3b8; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
    .metric-value { font-size: 1.75rem; font-weight: 700; color: #f8fafc; }
    .metric-sub { font-size: 0.8rem; color: #64748b; margin-top: 0.35rem; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 0.85rem 1rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; color: #64748b; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
    td { padding: 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.05); font-size: 0.85rem; vertical-align: middle; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
  </style>
</head>
<body>
  ${adminNavbar('/admin/ingest', admin)}
  <div class="container">
    <div style="margin-bottom: 1.5rem;">
      <h1 style="font-size: 1.75rem; font-weight: 700; margin-bottom: 0.35rem;">Ingestion Status & Telemetry</h1>
      <p style="color: #94a3b8; font-size: 0.9rem;">Dump runs, catalog totals, maturity distribution, and circuit breaker telemetry (PRD §27.5).</p>
    </div>

    <!-- Top KPI Grid -->
    <div class="grid">
      <div class="card">
        <div class="metric-title">Outbound Circuit Breaker</div>
        <div style="margin-top: 0.5rem;">${breakerBadge(status.telemetry.circuit_breaker.state)}</div>
        <div class="metric-sub">${status.telemetry.circuit_breaker.threshold} fail threshold · ${status.telemetry.circuit_breaker.cooldown_seconds}s cooldown</div>
      </div>
      <div class="card">
        <div class="metric-title">Catalog Works</div>
        <div class="metric-value">${formatNum(status.catalog.works_count)}</div>
        <div class="metric-sub">${formatNum(status.catalog.works_with_cover_count)} with covers · ${formatNum(status.catalog.editions_count)} editions</div>
      </div>
      <div class="card">
        <div class="metric-title">Authors & Authorship</div>
        <div class="metric-value">${formatNum(status.catalog.authors_count)}</div>
        <div class="metric-sub">${formatNum(status.catalog.authorship_links_count)} links · ${formatNum(status.telemetry.pending_work_authors_count)} pending resolution</div>
      </div>
      <div class="card">
        <div class="metric-title">Raw Payloads & Dedupe</div>
        <div class="metric-value">${formatNum(status.catalog.raw_payloads_count)}</div>
        <div class="metric-sub">${status.telemetry.dedupe_queue_pending_count} pending duplicate review items</div>
      </div>
    </div>

    <!-- Maturity Distribution & Rate Limiter -->
    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 1.25rem; margin-bottom: 1.5rem;">
      <div class="card">
        <h3 style="font-size: 1.05rem; font-weight: 600; margin-bottom: 1rem;">Maturity Classification Breakdown</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.25rem;">
          <div style="background: rgba(15, 23, 42, 0.6); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05);">
            <div style="font-size: 0.75rem; color: #4ade80; font-weight: 600;">General</div>
            <div style="font-size: 1.4rem; font-weight: 700; margin-top: 0.25rem;">${formatNum(status.maturity_breakdown.general)}</div>
          </div>
          <div style="background: rgba(15, 23, 42, 0.6); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05);">
            <div style="font-size: 0.75rem; color: #facc15; font-weight: 600;">Mature</div>
            <div style="font-size: 1.4rem; font-weight: 700; margin-top: 0.25rem;">${formatNum(status.maturity_breakdown.mature)}</div>
          </div>
          <div style="background: rgba(15, 23, 42, 0.6); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05);">
            <div style="font-size: 0.75rem; color: #f87171; font-weight: 600;">Explicit</div>
            <div style="font-size: 1.4rem; font-weight: 700; margin-top: 0.25rem;">${formatNum(status.maturity_breakdown.explicit)}</div>
          </div>
          <div style="background: rgba(15, 23, 42, 0.6); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05);">
            <div style="font-size: 0.75rem; color: #94a3b8; font-weight: 600;">Unclassified</div>
            <div style="font-size: 1.4rem; font-weight: 700; margin-top: 0.25rem;">${formatNum(status.maturity_breakdown.unclassified)}</div>
          </div>
        </div>
        <div style="font-size: 0.85rem; color: #94a3b8;">
          🔒 <strong>${formatNum(status.maturity_breakdown.overridden_locked)}</strong> titles carry locked human overrides in <code>field_provenance</code>.
        </div>
      </div>

      <div class="card">
        <h3 style="font-size: 1.05rem; font-weight: 600; margin-bottom: 1rem;">Outbound Headroom</h3>
        <div style="margin-bottom: 1rem;">
          <div style="font-size: 0.8rem; color: #94a3b8;">Sustained Rate Limit</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: #f8fafc; margin-top: 0.2rem;">${status.telemetry.outbound_limiter.rate_per_second} req/sec</div>
        </div>
        <div style="margin-bottom: 1rem;">
          <div style="font-size: 0.8rem; color: #94a3b8;">Burst Capacity</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: #f8fafc; margin-top: 0.2rem;">${status.telemetry.outbound_limiter.burst} tokens</div>
        </div>
        <div style="font-size: 0.75rem; color: #64748b;">Shared across gap-fill and admin enrichment (architecture §5.2).</div>
      </div>
    </div>

    <!-- Ingest Runs History -->
    <div class="card" style="padding: 0; overflow: hidden;">
      <div style="padding: 1.25rem 1.5rem; border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center;">
        <h3 style="font-size: 1.05rem; font-weight: 600;">Recent Dump Ingest Runs</h3>
        <span style="font-size: 0.85rem; color: #94a3b8;">Total Runs: ${status.runs_summary.total_runs} (${status.runs_summary.completed} done, ${status.runs_summary.failed} failed)</span>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Dump Type</th>
              <th>Lines Read</th>
              <th>Rows Written</th>
              <th>Rows Skipped</th>
              <th>Duration</th>
              <th>Started At</th>
            </tr>
          </thead>
          <tbody>
            ${
              status.recent_runs.length === 0
                ? `<tr><td colspan="7" style="text-align: center; color: #64748b; padding: 2.5rem;">No ingest runs recorded yet.</td></tr>`
                : status.recent_runs
                    .map(
                      (r) => `
              <tr>
                <td>${runStatusBadge(r.status)}</td>
                <td style="font-weight: 600; text-transform: capitalize; color: #f8fafc;">${r.dump_type}</td>
                <td style="color: #cbd5e1;">${formatNum(r.lines_read)}</td>
                <td style="color: #4ade80;">${formatNum(r.rows_written)}</td>
                <td style="color: #94a3b8;">${formatNum(r.rows_skipped)}</td>
                <td style="color: #cbd5e1;">${r.duration_seconds !== null ? `${r.duration_seconds}s` : '—'}</td>
                <td style="color: #94a3b8;">${new Date(r.started_at).toLocaleString()}</td>
              </tr>
            `,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  </div>
</body>
</html>`;

      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(html);
    });
  };
}
