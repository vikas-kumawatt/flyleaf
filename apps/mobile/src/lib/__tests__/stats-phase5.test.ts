// Phase 5 part A on the phone: ST-03 disclosure copy, ST-06 streak framing,
// ST-05 the goal ring and where it may appear (PRD §8.6 [LOCKED]).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoalResponse, ReadingStats } from '@flyleaf/api-client';
import { coverageNote, goalRingModel, parseGoalTarget, streakCopy, type CoverageKey } from '../statsView.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const KEYS: CoverageKey[] = [
  'pages', 'months', 'ratings', 'vs_crowd', 'formats', 'authors', 'genres', 'decades', 'languages', 'velocity', 'audio', 'pace', 'speed',
];
const full = Object.fromEntries(KEYS.map((k) => [k, { based_on: 4, of: 4 }])) as ReadingStats['coverage'];
const withGap = (key: CoverageKey, based_on: number, of: number) => ({ coverage: { ...full, [key]: { based_on, of } } });

describe('ST-03: every figure says what it is based on', () => {
  it('the PRD §17.4 sentence, word for word', () => {
    assert.equal(coverageNote(withGap('pages', 180, 247), 'pages'), 'Based on 180 of your 247 books — 67 are missing page counts.');
  });

  for (const key of KEYS) {
    it(`${key}: a gap is disclosed with its reason; no gap, no note`, () => {
      const one = coverageNote(withGap(key, 3, 4), key)!;
      assert.match(one, /^Based on 3 of your 4 \w[\w ]* — 1 \w/, one);
      const many = coverageNote(withGap(key, 1, 4), key, 'their')!;
      assert.match(many, /^Based on 1 of their 4 \w[\w ]* — 3 \w/, many);
      assert.notEqual(one.split(' — ')[1]!.slice(2), many.split(' — ')[1]!.slice(2), 'singular and plural reasons');
      assert.equal(coverageNote({ coverage: full }, key), null);
      assert.equal(coverageNote(withGap(key, 0, 0), key), null);
    });
  }

  it('sessions are counted as sessions, rated books as rated books', () => {
    assert.match(coverageNote(withGap('speed', 34, 210), 'speed')!, /^Based on 34 of your 210 sessions — 176 have no minutes or pages logged\.$/);
    assert.match(coverageNote(withGap('vs_crowd', 2, 5), 'vs_crowd')!, /of your 5 rated books/);
  });

  it('the stats screen shows a note for every figure (ST-04: its cards come from statCards)', () => {
    const cards = readFileSync(join(ROOT, 'src/lib/statCards.ts'), 'utf8');
    for (const key of KEYS) assert.match(cards, new RegExp(`note\\('${key}'\\)`), key);
    assert.match(readFileSync(join(ROOT, 'app/stats.tsx'), 'utf8'), /statCards\(/);
  });
});

describe('ST-06: streaks are an achievement, never a loss (PRD §8.7)', () => {
  const s = (current: number, longest: number, range: [string, string] | null = null) =>
    streakCopy({ current_streak: current, longest_streak: longest, longest_streak_range: range && { start: range[0], end: range[1] } });

  it('a live streak shows its days, and the longest beside it when that is longer', () => {
    assert.deepEqual(s(5, 5, ['2025-03-01', '2025-03-05']), { hero: '5 days', label: 'Reading streak', detail: null });
    assert.deepEqual(s(1, 47, ['2025-03-12', '2025-04-27']), {
      hero: '1 day', label: 'Reading streak', detail: 'Longest: 47 days (12 Mar 2025 – 27 Apr 2025)',
    });
  });

  it('a broken streak is "Longest streak: N days", with its dates', () => {
    assert.deepEqual(s(0, 47, ['2025-03-12', '2025-04-27']), { hero: '47 days', label: 'Longest streak', detail: '12 Mar 2025 – 27 Apr 2025' });
  });

  it('never logged progress: nothing, so nobody is told they are missing one (§8.3)', () => {
    assert.equal(s(0, 0), null);
  });

  it('no loss words anywhere in the copy, or on the screens that show it', () => {
    const all = [s(5, 5), s(1, 47, ['2025-03-12', '2025-04-27']), s(0, 47, ['2025-03-12', '2025-04-27'])].map((x) => JSON.stringify(x)).join(' ');
    assert.doesNotMatch(all, /lost|broke|broken|ended|missed|reset|0 days/i);
    for (const f of ['app/stats.tsx', 'src/lib/statCards.ts', 'app/(tabs)/profile.tsx', 'app/user/[id].tsx']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /current_streak\}|Daily Streak|\(best /, f);
    }
    // The streak is drawn through streakCopy on every screen that shows it (the stats screen through its cards).
    for (const f of ['src/lib/statCards.ts', 'app/(tabs)/profile.tsx', 'app/user/[id].tsx']) {
      assert.match(readFileSync(join(ROOT, f), 'utf8'), /streakCopy\(/, f);
    }
  });
});

describe('ST-05: the goal ring (PRD §8.6 [LOCKED])', () => {
  const goal = (books: number, target: number): GoalResponse => ({
    year: 2025,
    goal: {
      target_books: target, target_pages: null, books_count: books, pages_count: 0, books_reached: books >= target, pages_reached: null,
      pages_coverage: { based_on: 0, of: books },
    },
  });

  it('shows read/target and fills to the share read, never past full', () => {
    assert.deepEqual(goalRingModel(goal(6, 24)), { progress: 0.25, label: '6/24', accessibilityLabel: 'Reading goal 2025: 6 of 24 books', reached: false });
    assert.equal(goalRingModel(goal(30, 24))!.progress, 1);
    assert.equal(goalRingModel(goal(30, 24))!.reached, true);
    assert.equal(goalRingModel(goal(0, 24))!.progress, 0);
  });

  it('no goal, no ring', () => {
    assert.equal(goalRingModel({ year: 2025, goal: null }), null);
    assert.equal(goalRingModel(null), null);
  });

  it('says nothing about schedule: no "behind", "ahead", "left" or "remaining"', () => {
    const words = [goal(1, 52), goal(51, 52), goal(52, 52)].map((g) => JSON.stringify(goalRingModel(g))).join(' ');
    assert.doesNotMatch(words, /behind|ahead|left|remaining|schedule|pace|on track/i);
    const ui = ['src/ui/GoalRing.tsx', 'src/ui/GoalSheet.tsx'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    assert.doesNotMatch(ui.replace(/^\s*\/\/.*$/gm, ''), /behind|ahead of|remaining|on track|are you sure/i);
  });

  it('targets: whole numbers in range only', () => {
    assert.equal(parseGoalTarget(' 24 ', 10_000), 24);
    for (const bad of ['', '0', '-3', '2.5', '1e3', 'ten', '10001']) assert.equal(parseGoalTarget(bad, 10_000), null, bad);
  });

  it('appears on the two profile screens and nowhere else', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === '__tests__' || name === 'node_modules') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(ROOT, 'app'));
    walk(join(ROOT, 'src'));
    const users = files
      .filter((f) => /GoalRing|GoalSheet|myGoal\(|userGoal\(|getMyGoal|getUserGoal/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split('\\').join('/'))
      .sort();
    assert.deepEqual(users, [
      'app/(tabs)/profile.tsx',
      'app/user/[id].tsx',
      'src/lib/api.ts', //        the client wrapper
      'src/lib/statsView.ts', //  the ring's model (goalRingModel)
      'src/ui/GoalRing.tsx', //   the component itself
      'src/ui/GoalSheet.tsx', //  its editor, opened from the own-profile ring
    ]);
  });
});
