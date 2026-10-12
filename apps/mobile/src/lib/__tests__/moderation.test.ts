// SO-40 / SO-42 (app side): the report sheet's reasons and copy, the notice
// screen's appeal status, the moderation deep link, and that every surface
// the PRD lists actually mounts the report sheet.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPORT_REASONS, appealStatus, moderationRefusal, reasonsFor, reportConfirmation, reportErrorMessage, reportTitle,
} from '../moderation';
import { HOME, backStackFor } from '../notifications';

const ROOT = join(__dirname, '..', '..', '..');
const M = '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6';

describe('the report sheet (PRD §6.44)', () => {
  test('the reason picker is §6.44\'s eight reasons, in order', () => {
    assert.deepEqual(REPORT_REASONS.map((r) => r.label), [
      'Spam', 'Harassment', 'Hate speech', 'Spoilers unmarked', 'NSFW', 'Copyright', 'Fake review', 'Other',
    ]);
  });

  test('each surface offers the reasons that fit it', () => {
    assert.ok(reasonsFor('review').some((r) => r.key === 'fake_review'));
    assert.ok(!reasonsFor('comment').some((r) => r.key === 'fake_review'));
    assert.ok(!reasonsFor('user').some((r) => r.key === 'spoilers'));
    for (const s of ['review', 'comment', 'user', 'shelf', 'work'] as const) {
      assert.ok(reasonsFor(s).some((r) => r.key === 'other'), s);
      assert.match(reportTitle(s), /^Report /);
    }
  });

  test('the confirmation promises no outcome; every refusal has reader copy', () => {
    assert.doesNotMatch(reportConfirmation(), /will be (removed|banned|deleted)/i);
    assert.match(reportConfirmation(), /review/);
    for (const code of ['not_found', 'cannot_report_self', 'rate_limited', undefined]) {
      assert.ok(reportErrorMessage(code).length > 0);
    }
  });

  test('layer 1 and suspension refusals pass the server\'s reason through', () => {
    assert.equal(moderationRefusal('content_rejected', 'This contains language…'), 'This contains language…');
    assert.match(moderationRefusal('review_removed')!, /appeal/);
    assert.equal(moderationRefusal('something_else'), null);
  });
});

describe('the moderation notice (PRD §27.6)', () => {
  test('appeal status for every state', () => {
    assert.match(appealStatus({ can_appeal: true, reversed: false, appeal: null }), /appeal once/);
    assert.match(appealStatus({ can_appeal: false, reversed: false, appeal: { state: 'pending' } }), /with a moderator/);
    assert.match(appealStatus({ can_appeal: false, reversed: false, appeal: { state: 'upheld' } }), /stands/);
    assert.match(appealStatus({ can_appeal: false, reversed: true, appeal: { state: 'overturned' } }), /reversed/);
  });

  test('flyleaf://moderation/<id> opens the notice under the Profile tab; anything else is Home', () => {
    assert.deepEqual(backStackFor(`flyleaf://moderation/${M}`), ['/profile', `/moderation/${M}`]);
    assert.deepEqual(backStackFor('flyleaf://moderation/not-a-uuid'), [HOME]);
    assert.deepEqual(backStackFor(`flyleaf://moderation/${M}/x`), [HOME]);
    assert.ok(existsSync(join(ROOT, 'app', 'moderation', '[id].tsx')));
  });
});

describe('every surface the PRD lists mounts the report sheet', () => {
  for (const [file, type] of [
    ['app/review/[id].tsx', "type: 'review'"],
    ['app/read/[id]/comments.tsx', "type: 'comment'"],
    ['app/user/[id].tsx', "type: 'user'"],
    ['app/shelf/[id].tsx', "type: 'shelf'"],
    ['app/work/[id].tsx', "type: 'work'"],
  ] as const) {
    test(file, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      assert.match(src, /<ReportSheet target=\{reportTarget\}/);
      assert.ok(src.includes(`setReportTarget({ ${type}`), `${file} reports ${type}`);
    });
  }
  test('the sheet posts the report and records content_reported{type, reason}', () => {
    const src = readFileSync(join(ROOT, 'src/ui/ReportSheet.tsx'), 'utf8');
    assert.match(src, /api\.createReport\(/);
    assert.match(src, /track\('content_reported', \{ type: target\.type, reason \}\)/);
  });
});
