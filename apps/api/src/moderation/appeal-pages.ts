// The banned account's appeal (owner decision on SO-4x, 13 Oct 2026): a ban
// soft-deletes the account and ends its sessions, so it cannot sign in to use
// POST /v1/me/moderation/:id/appeal. Instead the ban emails a one-time link
// (ModerationService.act) to this page, which shows the decision and takes the
// one appeal PRD §27.6 allows.
//
// The link is the proof of identity, so it behaves like the reset link
// (identity/link-pages.ts, same page shell and headers): a GET never spends it
// (mail scanners and previews fetch URLs), the POST that carries the appeal
// does, in the appeal's own transaction; it expires after APPEAL_LINK_DAYS.
// Rate limits: the Auth tier, like the other emailed links.

import type { FastifyInstance } from 'fastify';

import { escapeHtml } from '../admin/html.js';
import { ApiError } from '../http.js';
import { bodyField, MAX_TOKEN, queryToken, sendPage } from '../identity/link-pages.js';
import { APPEAL_LINK_DAYS, APPEAL_MAX_LENGTH, type ModerationService, type NoticeView } from './index.js';

function decision(n: NoticeView): string {
  return `<p><strong>${escapeHtml(n.rule_label)}.</strong> ${escapeHtml(n.summary)}</p>
${n.consequences.length ? `<ul>${n.consequences.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}`;
}

function appealForm(token: string, n: NoticeView, nonce: string, error?: string) {
  return `<h1>Appeal a decision</h1>
${decision(n)}
<p>A person will review your appeal. You can appeal once.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/appeal" id="appeal">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="body">Why is the decision wrong?</label>
<textarea id="body" name="body" rows="8" maxlength="${APPEAL_MAX_LENGTH}" required></textarea>
<button type="submit">Send appeal</button>
</form>
<style>textarea { box-sizing: border-box; width: 100%; padding: .7rem; margin: 0 0 1rem; font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 8px; }</style>
<script nonce="${escapeHtml(nonce)}">
  var form = document.getElementById('appeal');
  form.addEventListener('submit', function () { form.querySelector('button').disabled = true; });
</script>`;
}

const expired = `<h1>This link has expired</h1>
<p>Appeal links work once, for ${APPEAL_LINK_DAYS} days. If you have not appealed yet and need a new link, reply to the email it came in.</p>`;

const closed = (n: NoticeView | null) => `<h1>Already appealed</h1>
${n?.appeal ? `<p>Your appeal was received. ${n.appeal.state === 'pending' ? 'A person will review it and email you the outcome.' : n.appeal.state === 'overturned' ? 'The decision was reversed.' : 'The decision stands.'}</p>` : '<p>This decision can no longer be appealed.</p>'}`;

export function appealPages(service: ModerationService) {
  return async (app: FastifyInstance) => {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16384 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    app.get('/appeal', { schema: { hide: true } }, async (req, reply) => {
      const token = queryToken(req.query);
      if (!token) return sendPage(reply, 400, 'Link incomplete', () => '<h1>This link is incomplete</h1>\n<p>Copy the whole link from the email.</p>');
      const { state, notice } = await service.appealLinkState(token);
      if (state === 'open') return sendPage(reply, 200, 'Appeal', (nonce) => appealForm(token, notice!, nonce));
      if (state === 'expired') return sendPage(reply, 400, 'Link expired', () => expired);
      return sendPage(reply, 200, 'Already appealed', () => closed(notice));
    });

    app.post('/appeal', { schema: { hide: true } }, async (req, reply) => {
      const token = bodyField(req.body, 'token');
      const body = bodyField(req.body, 'body');
      if (!token || token.length > MAX_TOKEN) {
        return sendPage(reply, 400, 'Link incomplete', () => '<h1>This link is incomplete</h1>\n<p>Copy the whole link from the email.</p>');
      }
      if (!body.trim() || [...body.trim()].length > APPEAL_MAX_LENGTH) {
        // Nothing spent: the link still works for a corrected appeal.
        const { state, notice } = await service.appealLinkState(token);
        if (state !== 'open') return sendPage(reply, 400, 'Link expired', () => expired);
        const msg = body.trim() ? `An appeal is at most ${APPEAL_MAX_LENGTH} characters.` : 'Tell us why the decision is wrong.';
        return sendPage(reply, 422, 'Appeal', (nonce) => appealForm(token, notice!, nonce, msg));
      }
      try {
        await service.appealByLink(token, body);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_or_expired_token') return sendPage(reply, 400, 'Link expired', () => expired);
        if (err instanceof ApiError && err.code === 'appeal_closed') return sendPage(reply, 409, 'Already appealed', () => closed(null));
        throw err;
      }
      return sendPage(reply, 200, 'Appeal sent', () => `<h1>Appeal sent</h1>
<p>A person will review it and email you the outcome. This link has now been used.</p>`);
    });
  };
}
