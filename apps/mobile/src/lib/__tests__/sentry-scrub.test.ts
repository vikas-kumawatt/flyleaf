// Audit 10 (SL-82): what a mobile crash report may carry.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, sentryEventId } from '../sentryScrub.js';

describe('mobile crash report scrubbing (SL-82, audit 10)', () => {
  it('removes the export download token, bearer tokens, query secrets and email addresses', () => {
    const msg =
      'GET https://api.flyleaf.app/v1/exports/x/download?token=abc123&format=csv failed; ' +
      'Authorization: Bearer eyJhbGciOi.payload.sig; reset?code=654321; reader@example.com';
    const out = scrubText(msg);
    assert.doesNotMatch(out, /abc123|eyJhbGciOi|654321|reader@example\.com/);
    assert.match(out, /token=\[REDACTED\]&format=csv/);
    assert.match(out, /Bearer \[REDACTED\]/);
  });

  it('leaves ordinary text alone', () => {
    assert.equal(scrubText('TypeError: undefined is not a function (reading.tsx:42)'), 'TypeError: undefined is not a function (reading.tsx:42)');
  });

  it('event ids are 32 hex characters, as Sentry requires', () => {
    assert.match(sentryEventId('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), /^[0-9a-f]{32}$/);
  });
});
