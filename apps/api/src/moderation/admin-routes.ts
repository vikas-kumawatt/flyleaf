// The console's moderation area (SO-42; PRD §27.5 [LOCKED] "Reports queue").
//
// REST under /v1/admin (the console's buttons call these with the session
// cookie, which the auth hook accepts only with a same-origin Origin: the
// Part 06 CSRF guard), and server-rendered pages under /admin (escaped
// values, a per-response script nonce, no inline handlers). Reading needs a
// moderator; acting needs a moderator, and a step that touches an account
// needs an admin (ladder.ts `needsAdmin`). Every action writes its audit row
// in its own transaction (ModerationService.act / resolveAppeal).

import type { FastifyInstance } from 'fastify';
import { requireModerator } from '../http.js';
import type { Db } from '../platform/index.js';
import { errorResponseSchema } from '../contract/schemas.js';
import { auditContext } from '../admin/auth.js';
import { adminPage, escapeHtml, sendAdminHtml } from '../admin/html.js';
import type { Notifier } from '../notify/index.js';
import { MIN_ACTION_REASON, ModerationService, type ModerationDeps, RULES, RULE_LABELS, SUBJECT_TYPES, type Rule, type SubjectType } from './index.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const freeObject = { type: 'object', additionalProperties: true } as const;
const nullableDate = { type: ['string', 'null'], format: 'date-time' } as const;

const actionSchema = {
  type: 'object',
  properties: {
    id: uuid,
    subject_type: { type: 'string', enum: [...SUBJECT_TYPES] },
    subject_id: uuid,
    target_user_id: { type: ['string', 'null'], format: 'uuid' },
    decision: { type: 'string', enum: ['dismiss', 'enforce', 'resolve'] },
    rule: { type: ['string', 'null'], enum: [...RULES, null] },
    step: { type: ['integer', 'null'] },
    effects: freeObject,
    reason: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    reversed_at: nullableDate,
    appeal: {
      type: ['object', 'null'],
      properties: { state: { type: 'string' }, body: { type: 'string' }, appealed_at: { type: 'string', format: 'date-time' }, resolved_at: nullableDate },
    },
  },
  required: ['id', 'subject_type', 'subject_id', 'target_user_id', 'decision', 'rule', 'step', 'effects', 'reason', 'created_at', 'reversed_at', 'appeal'],
} as const;

const userRef = { type: ['object', 'null'], properties: { id: uuid, username: { type: ['string', 'null'] } } } as const;

const queueResponse = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject_type: { type: 'string', enum: [...SUBJECT_TYPES] },
          subject_id: uuid,
          owner: userRef,
          report_count: { type: 'integer' },
          weight: { type: 'number', description: 'Sum of reporter reputations (an automated report counts 1)' },
          first_reported_at: { type: 'string', format: 'date-time' },
          last_reported_at: { type: 'string', format: 'date-time' },
          reasons: { type: 'array', items: { type: 'string' } },
          auto_rules: { type: 'array', items: { type: 'string' } },
          snapshot: freeObject,
        },
      },
    },
    open_cases: { type: 'integer' },
    pending_appeals: { type: 'integer' },
  },
  required: ['cases', 'open_cases', 'pending_appeals'],
} as const;

const caseResponse = {
  type: 'object',
  properties: {
    subject_type: { type: 'string' },
    subject_id: uuid,
    subject: { type: ['object', 'null'], additionalProperties: true },
    owner: {
      type: ['object', 'null'],
      properties: {
        id: uuid, username: { type: ['string', 'null'] }, display_name: { type: ['string', 'null'] },
        created_at: { type: 'string', format: 'date-time' }, suspended_until: nullableDate, banned_at: nullableDate,
        deleted_at: nullableDate, ratings_excluded_at: nullableDate, review_flag_until: nullableDate,
      },
    },
    reports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: uuid, source: { type: 'string' }, auto_rule: { type: ['string', 'null'] }, reason: { type: 'string' },
          detail: { type: ['string', 'null'] }, snapshot: freeObject, state: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' }, resolved_at: nullableDate,
          reporter: userRef, reporter_reputation: { type: ['number', 'null'] },
        },
      },
    },
    open_reports: { type: 'integer' },
    history: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: uuid, subject_type: { type: 'string' }, subject_id: uuid, decision: { type: 'string' }, rule: { type: ['string', 'null'] },
          step: { type: ['integer', 'null'] }, reason: { type: 'string' }, created_at: { type: 'string', format: 'date-time' },
          reversed_at: nullableDate, appeal_state: { type: ['string', 'null'] },
        },
      },
    },
    ladder: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule: { type: 'string' }, label: { type: 'string' }, strikes: { type: 'integer' }, step: { type: 'integer' },
          consequences: { type: 'array', items: { type: 'string' } }, needs_admin: { type: 'boolean' },
        },
      },
    },
  },
  required: ['subject_type', 'subject_id', 'subject', 'owner', 'reports', 'open_reports', 'history', 'ladder'],
} as const;

const subjectParams = {
  type: 'object',
  properties: { subjectType: { type: 'string', enum: [...SUBJECT_TYPES] }, subjectId: uuid },
  required: ['subjectType', 'subjectId'],
} as const;

const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };

export function adminModerationRoutes(db: Db, notifier?: Notifier, deps: ModerationDeps = {}) {
  const service = new ModerationService(db, notifier, deps);
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { subject_type?: SubjectType; limit?: number; offset?: number } }>(
      '/v1/admin/reports',
      {
        schema: {
          tags: ['Admin Moderation'],
          summary: 'Open reports grouped by subject, heaviest first (PRD §27.5)',
          querystring: {
            type: 'object',
            properties: {
              subject_type: { type: 'string', enum: [...SUBJECT_TYPES] },
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
          response: { 200: queueResponse, ...errors },
        },
      },
      async (req) => {
        requireModerator(req);
        return service.queue({ subjectType: req.query.subject_type, limit: req.query.limit, offset: req.query.offset });
      },
    );

    app.get<{ Params: { subjectType: SubjectType; subjectId: string } }>(
      '/v1/admin/reports/:subjectType/:subjectId',
      {
        schema: {
          tags: ['Admin Moderation'],
          summary: 'One reported subject in context: the content, its reports, the owner\'s history and the ladder',
          params: subjectParams,
          response: { 200: caseResponse, ...errors },
        },
      },
      async (req) => {
        requireModerator(req);
        return service.caseDetail(req.params.subjectType, req.params.subjectId);
      },
    );

    app.post<{
      Params: { subjectType: SubjectType; subjectId: string };
      Body: { decision: 'dismiss' | 'enforce' | 'resolve'; rule?: Rule; reason: string };
    }>(
      '/v1/admin/reports/:subjectType/:subjectId/action',
      {
        schema: {
          tags: ['Admin Moderation'],
          summary: 'Dismiss, resolve (books) or enforce a rule on a reported subject; closes its open reports',
          description: `Enforce applies the rule's next enforcement-ladder step (PRD §27.3). Steps that suspend, ban or change an account need the admin role. reason: ${MIN_ACTION_REASON}+ characters, kept in the audit log.`,
          params: subjectParams,
          body: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['dismiss', 'enforce', 'resolve'] },
              rule: { type: 'string', enum: [...RULES] },
              reason: { type: 'string', maxLength: 2000 },
            },
            required: ['decision', 'reason'],
            additionalProperties: false,
          },
          response: { 200: actionSchema, ...errors, 409: errorResponseSchema, 422: errorResponseSchema },
        },
      },
      async (req) => {
        const admin = requireModerator(req);
        return service.act(admin, req.params.subjectType, req.params.subjectId, req.body, auditContext(req));
      },
    );

    app.get<{ Querystring: { limit?: number; offset?: number } }>(
      '/v1/admin/appeals',
      {
        schema: {
          tags: ['Admin Moderation'],
          summary: 'Pending appeals, oldest first (PRD §27.6)',
          querystring: {
            type: 'object',
            properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                appeals: {
                  type: 'array',
                  items: { ...actionSchema, properties: { ...actionSchema.properties, owner: userRef, needs_admin: { type: 'boolean' } } },
                },
              },
              required: ['appeals'],
            },
            ...errors,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        return service.appeals(req.query);
      },
    );

    app.post<{ Params: { id: string }; Body: { decision: 'uphold' | 'overturn'; reason: string } }>(
      '/v1/admin/appeals/:id/resolve',
      {
        schema: {
          tags: ['Admin Moderation'],
          summary: 'Uphold (the decision stands) or overturn (everything it did is undone) an appeal',
          params: { type: 'object', properties: { id: uuid }, required: ['id'] },
          body: {
            type: 'object',
            properties: { decision: { type: 'string', enum: ['uphold', 'overturn'] }, reason: { type: 'string', maxLength: 2000 } },
            required: ['decision', 'reason'],
            additionalProperties: false,
          },
          response: { 200: actionSchema, ...errors, 422: errorResponseSchema },
        },
      },
      async (req) => {
        const admin = requireModerator(req);
        return service.resolveAppeal(admin, req.params.id, req.body, auditContext(req));
      },
    );

    // -----------------------------------------------------------------------
    // Console pages
    // -----------------------------------------------------------------------

    app.get<{ Querystring: { type?: string } }>('/admin/reports', { schema: { hide: true } }, async (req, reply) => {
      if (!req.admin) return reply.redirect('/admin/login');
      const admin = req.admin;
      const type = (SUBJECT_TYPES as readonly string[]).includes(req.query.type ?? '') ? (req.query.type as SubjectType) : undefined;
      const q = await service.queue({ subjectType: type, limit: 100 });
      return sendAdminHtml(reply, () => page('Reports', '/admin/reports', admin, `
        <div class="page-head"><div>
          <h1>Reports</h1>
          <p class="sub">${q.open_cases} open · ${q.pending_appeals} appeals waiting · heaviest first by reporter reputation, then oldest</p>
        </div></div>
        <div class="chips">${['all', ...SUBJECT_TYPES].map((t) => `<a class="chip ${(t === 'all' && !type) || t === type ? 'active' : ''}" href="/admin/reports${t === 'all' ? '' : `?type=${escapeHtml(t)}`}">${escapeHtml(t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1))}</a>`).join('')}</div>
        <div class="card flush table-wrap"><table>
          <thead><tr><th>Subject</th><th>Owner</th><th class="num">Reports</th><th class="num">Weight</th><th>Reasons</th><th>First reported</th><th>Content</th></tr></thead>
          <tbody>${q.cases.length === 0 ? '<tr><td colspan="7" class="empty">Nothing to review</td></tr>' : q.cases.map((c) => `
            <tr>
              <td><a href="/admin/reports/${escapeHtml(c.subject_type)}/${escapeHtml(c.subject_id)}">${escapeHtml(c.subject_type)}</a></td>
              <td>${escapeHtml(c.owner?.username ?? '—')}</td>
              <td class="num">${c.report_count}${c.auto_rules.length ? `<div class="tag">auto: ${escapeHtml(c.auto_rules.join(', '))}</div>` : ''}</td>
              <td class="num">${escapeHtml(c.weight.toFixed(2))}</td>
              <td>${escapeHtml(c.reasons.join(', '))}</td>
              <td class="nowrap mono meta">${escapeHtml(c.first_reported_at)}</td>
              <td class="snip">${escapeHtml(snippet(c.snapshot))}</td>
            </tr>`).join('')}</tbody>
        </table></div>`));
    });

    app.get<{ Params: { subjectType: string; subjectId: string } }>(
      '/admin/reports/:subjectType/:subjectId',
      { schema: { hide: true } },
      async (req, reply) => {
        if (!req.admin) return reply.redirect('/admin/login');
        const admin = req.admin;
        const { subjectType, subjectId } = req.params;
        if (!(SUBJECT_TYPES as readonly string[]).includes(subjectType) || !/^[0-9a-f-]{36}$/i.test(subjectId)) {
          return sendAdminHtml(reply, () => page('Not found', '/admin/reports', admin, '<h1>Not found</h1>'), 404);
        }
        let c;
        try {
          c = await service.caseDetail(subjectType as SubjectType, subjectId);
        } catch {
          return sendAdminHtml(reply, () => page('Not found', '/admin/reports', admin, '<h1>Not found</h1>'), 404);
        }
        return sendAdminHtml(reply, (nonce) => page(`Report: ${subjectType}`, '/admin/reports', admin, `
          <div class="page-head"><div>
            <p class="meta"><a href="/admin/reports">Reports</a> / ${escapeHtml(subjectType)}</p>
            <h1 style="margin-top: 4px;">${escapeHtml(subjectType.charAt(0).toUpperCase() + subjectType.slice(1))}</h1>
            <p class="sub mono">${escapeHtml(subjectId)}</p>
          </div></div>
          <div class="card"><h2>Content now</h2>${c.subject ? kv(c.subject) : '<p class="meta">Gone</p>'}</div>
          <div class="card"><h2>Owner</h2>${c.owner ? kv(c.owner) : '<p class="meta">None, it is a book, or the account was deleted</p>'}</div>
          <div class="card stack"><h2>Act · ${c.open_reports} open</h2>
            ${c.open_reports === 0 ? '<p class="meta">No open reports</p>' : `
            <form id="act" class="stack" style="max-width: 560px;" data-type="${escapeHtml(subjectType)}" data-id="${escapeHtml(subjectId)}">
              <label>Decision
                <select name="decision">
                  <option value="dismiss">Dismiss: no violation</option>
                  ${subjectType === 'work' ? '<option value="resolve">Resolve: handled with the catalog tools</option>' : '<option value="enforce">Enforce a rule</option>'}
                </select></label>
              ${c.ladder.length ? `<label>Rule
                <select name="rule"><option value="">—</option>${c.ladder.map((l) => `<option value="${escapeHtml(l.rule)}">${escapeHtml(l.label)} (strike ${l.strikes + 1}${l.needs_admin ? ', admin only' : ''})</option>`).join('')}</select></label>` : ''}
              <label>Reason, at least ${MIN_ACTION_REASON} characters, kept in the audit trail<textarea name="reason" rows="3" required minlength="${MIN_ACTION_REASON}"></textarea></label>
              <div class="row"><button type="submit" class="primary">Apply</button> <span id="act-result" class="meta"></span></div>
            </form>`}
            <div class="table-wrap"><table><thead><tr><th>Rule</th><th class="num">Strikes</th><th class="num">Next step</th><th>What it does</th></tr></thead><tbody>
            ${c.ladder.map((l) => `<tr><td>${escapeHtml(l.label)}</td><td class="num">${l.strikes}</td><td class="num">${l.step}${l.needs_admin ? ' <span class="tag">admin</span>' : ''}</td><td>${escapeHtml(l.consequences.join(' '))}</td></tr>`).join('')}
            </tbody></table></div>
          </div>
          <div class="card flush"><div class="card-head"><h2>Reports</h2></div><div class="table-wrap"><table><thead><tr><th>When</th><th>By</th><th>Reputation</th><th>Reason</th><th>Detail</th><th>Snapshot</th><th>State</th></tr></thead><tbody>
            ${c.reports.map((r) => `<tr><td class="nowrap mono meta">${escapeHtml(r.created_at)}</td><td>${escapeHtml(r.reporter?.username ?? (r.source === 'automated' ? `layer 1: ${r.auto_rule}` : '—'))}</td>
              <td>${r.reporter_reputation === null ? '—' : escapeHtml(r.reporter_reputation.toFixed(2))}</td><td>${escapeHtml(r.reason)}</td>
              <td>${escapeHtml(r.detail ?? '')}</td><td class="snip">${escapeHtml(snippet(r.snapshot))}</td><td>${escapeHtml(r.state)}</td></tr>`).join('')}
          </tbody></table></div></div>
          <div class="card flush"><div class="card-head"><h2>Owner's history</h2></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Decision</th><th>Rule</th><th>Step</th><th>Reason</th><th>Appeal</th><th>Reversed</th></tr></thead><tbody>
            ${c.history.map((h) => `<tr><td class="nowrap mono meta">${escapeHtml(h.created_at)}</td><td>${escapeHtml(h.decision)}</td><td>${escapeHtml(h.rule ?? '—')}</td><td>${escapeHtml(h.step ?? '')}</td><td>${escapeHtml(h.reason)}</td><td>${escapeHtml(h.appeal_state ?? '')}</td><td>${escapeHtml(h.reversed_at ?? '')}</td></tr>`).join('')}
          </tbody></table></div></div>
          <script nonce="${nonce}">
            const form = document.getElementById('act');
            if (form) form.addEventListener('submit', async (e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(form));
              const body = { decision: data.decision, reason: data.reason };
              if (data.decision === 'enforce') body.rule = data.rule;
              const res = await fetch('/v1/admin/reports/' + form.dataset.type + '/' + form.dataset.id + '/action', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
              });
              const out = document.getElementById('act-result');
              if (res.ok) { location.reload(); return; }
              const err = await res.json().catch(() => ({}));
              out.textContent = (err.error && err.error.message) || 'Could not apply the decision';
            });
          </script>`));
      },
    );

    app.get('/admin/appeals', { schema: { hide: true } }, async (req, reply) => {
      if (!req.admin) return reply.redirect('/admin/login');
      const admin = req.admin;
      const { appeals } = await service.appeals({ limit: 100 });
      return sendAdminHtml(reply, (nonce) => page('Appeals', '/admin/appeals', admin, `
        <div class="page-head"><div>
          <h1>Appeals</h1>
          <p class="sub">Each appeal is reviewed by a person. Overturning undoes everything the decision did</p>
        </div></div>
        <div class="card flush table-wrap"><table><thead><tr><th>Appealed</th><th>Owner</th><th>Subject</th><th>Rule / step</th><th>Decision reason</th><th>Appeal</th><th></th></tr></thead><tbody>
        ${appeals.length === 0 ? '<tr><td colspan="7" class="empty">No appeals waiting</td></tr>' : appeals.map((a) => `
          <tr>
            <td class="nowrap mono meta">${escapeHtml(a.appeal?.appealed_at ?? '')}</td>
            <td>${escapeHtml(a.owner?.username ?? '—')}</td>
            <td><a href="/admin/reports/${escapeHtml(a.subject_type)}/${escapeHtml(a.subject_id)}">${escapeHtml(a.subject_type)}</a></td>
            <td>${escapeHtml(a.rule ? RULE_LABELS[a.rule] : '')} · ${escapeHtml(a.step ?? '')}</td>
            <td>${escapeHtml(a.reason)}</td>
            <td class="snip">${escapeHtml(a.appeal?.body ?? '')}</td>
            <td><div class="row" style="justify-content: flex-end;">${a.needs_admin && admin.role !== 'admin' ? '<span class="meta">Overturning needs an administrator</span>' : ''}
              <button class="sm" data-appeal="${escapeHtml(a.id)}" data-decision="uphold">Uphold</button>
              ${a.needs_admin && admin.role !== 'admin' ? '' : `<button class="sm danger" data-appeal="${escapeHtml(a.id)}" data-decision="overturn">Overturn</button>`}</div></td>
          </tr>`).join('')}
        </tbody></table></div>
        <script nonce="${nonce}">
          document.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-appeal]');
            if (!b) return;
            const reason = prompt('Reason, at least ${MIN_ACTION_REASON} characters, kept in the audit trail', '');
            if (reason === null) return;
            const res = await fetch('/v1/admin/appeals/' + b.dataset.appeal + '/resolve', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: b.dataset.decision, reason }),
            });
            if (res.ok) { location.reload(); return; }
            const err = await res.json().catch(() => ({}));
            alert((err.error && err.error.message) || 'Could not resolve the appeal');
          });
        </script>`));
    });
  };
}

function snippet(snapshot: Record<string, unknown>): string {
  const text = ['body', 'name', 'bio', 'display_name', 'username', 'title', 'description']
    .map((k) => snapshot[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' · ');
  return text.length > 280 ? `${text.slice(0, 280)}…` : text;
}

function kv(obj: Record<string, unknown>): string {
  return `<dl>${Object.entries(obj)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))}</dd>`)
    .join('')}</dl>`;
}

function page(title: string, path: string, admin: { email: string; role: string }, body: string): string {
  return adminPage({ title, path, admin, body });
}
