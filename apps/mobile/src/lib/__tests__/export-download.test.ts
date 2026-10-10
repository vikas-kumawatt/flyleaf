// Audit 12 (A-12-016): the export list's Download button.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isExportDownloadable } from '../exportDownload';

describe('isExportDownloadable', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');

  test('a completed export inside its 48 hours can be downloaded, with no download_url', () => {
    assert.equal(isExportDownloadable({ state: 'completed', expires_at: '2026-10-11T12:00:00Z' }, now), true);
  });

  test('an expired, queued or failed export cannot', () => {
    assert.equal(isExportDownloadable({ state: 'completed', expires_at: '2026-10-09T12:00:00Z' }, now), false);
    assert.equal(isExportDownloadable({ state: 'queued', expires_at: '2026-10-11T12:00:00Z' }, now), false);
    assert.equal(isExportDownloadable({ state: 'failed', expires_at: null }, now), false);
  });
});
