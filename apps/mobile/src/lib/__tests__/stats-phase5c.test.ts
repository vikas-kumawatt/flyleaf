// Phase 5 C on the phone: ST-04 (one stat per card, share on each, never a
// made-up figure), the share preview (§6.45), ST-09 (Year in Review entry
// and states), ST-10 (milestone moments: in-app, never volume-chasing).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Milestone, ReadingStats, YearInReview } from '@flyleaf/api-client';
import { STATS_MIN_BOOKS, statCards, statsEmpty } from '../statCards.js';
import { cardFileName, encodeShareOptions, parseShareOptions, shareErrorMessage, shareEvents, statShareOptions, yearShareOptions } from '../shareCard.js';
import { yirBanner, yirEmptyCopy } from '../yearInReview.js';
import { LONGEST_YET, momentFor } from '../milestones.js';
import { backStackFor } from '../notifications.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const cov = (based_on: number, of: number) => ({ based_on, of });
const U = '11111111-2222-4333-8444-555555555555';

function empty(): ReadingStats {
  const zero = cov(0, 0);
  return {
    year: '2026', books_count: 0, distinct_works_count: 0, books_in_progress: 0, pages_count: 0, audio_hours: 0, avg_rating: null, vs_crowd: null,
    rating_distribution: {}, format_breakdown: { print: 0, ebook: 0, audiobook: 0, unknown: 0 },
    monthly_pace: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, books: 0, pages: 0 })),
    genres: { top: [], other: 0 }, decades: [], languages: [],
    velocity: { median_days: null, by_month: [] }, speed: { pages_per_hour: null, pages: 0, minutes: 0 }, pace: [],
    time_of_day: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    longest_book: null, shortest_book: null, fastest_read: null, slowest_read: null, highest_rated: null, lowest_rated: null,
    oldest_publication: null, most_reread: null, most_read_author: null, dnf_count: 0, dnf_rate: 0,
    current_streak: 0, longest_streak: 0, current_streak_range: null, longest_streak_range: null,
    excluded: { undated: 0, missing_page_count: 0 },
    coverage: { pages: zero, months: zero, ratings: zero, vs_crowd: zero, formats: zero, authors: zero, genres: zero, decades: zero, languages: zero, velocity: zero, audio: zero, pace: zero, speed: zero },
  } as unknown as ReadingStats;
}

function full(): ReadingStats {
  const s = empty() as any;
  const book = (title: string, extra: object = {}) => ({ work_id: U, title, author_name: 'An Author', page_count: 320, cover_id: null, ...extra });
  const tod = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  tod[2]![21] = 4;
  return {
    ...s, books_count: 247, distinct_works_count: 240, pages_count: 52_000, audio_hours: 12.5, avg_rating: 3.84, vs_crowd: 0.43, dnf_count: 6, dnf_rate: 0.024,
    rating_distribution: { '4.0': 100, '3.5': 80 }, format_breakdown: { print: 200, ebook: 30, audiobook: 10, unknown: 7 },
    monthly_pace: s.monthly_pace.map((m: any) => (m.month === 3 ? { ...m, books: 30 } : m)),
    genres: { top: [{ name: 'Fantasy', count: 90 }], other: 10 }, decades: [{ decade: 2010, count: 150 }], languages: [{ language: 'en', count: 200 }, { language: 'fr', count: 7 }],
    velocity: { median_days: 9, by_month: [] }, speed: { pages_per_hour: 40, pages: 4000, minutes: 6000 },
    pace: [{ week_start: '2026-03-02', pages: 410, pages_per_day: 58.6 }], time_of_day: tod,
    longest_book: book('Long'), shortest_book: book('Short', { page_count: 90 }), fastest_read: { ...book('Fast'), days: 1 }, slowest_read: { ...book('Slow'), days: 60 },
    highest_rated: { ...book('Best'), rating: 5 }, lowest_rated: { ...book('Worst'), rating: 1 }, oldest_publication: { ...book('Old'), year: 1818 },
    most_reread: { ...book('Again'), count: 3 }, most_read_author: { name: 'Ursula K. Le Guin', count: 12 },
    current_streak: 5, longest_streak: 5, current_streak_range: { start: '2026-10-01', end: '2026-10-05' }, longest_streak_range: { start: '2026-10-01', end: '2026-10-05' },
    excluded: { undated: 0, missing_page_count: 67 },
    coverage: { ...s.coverage, pages: cov(180, 247), ratings: cov(180, 247), vs_crowd: cov(150, 180), formats: cov(240, 247), authors: cov(247, 247), genres: cov(200, 247), decades: cov(240, 247), languages: cov(207, 247), velocity: cov(100, 247), audio: cov(9, 10), pace: cov(300, 320), speed: cov(80, 320), months: cov(247, 247) },
  } as ReadingStats;
}

describe('ST-04: one stat per card, each from the response, each with its disclosure', () => {
  it('a card for every figure the response has, in §6.40 order, each a server stat card kind', () => {
    const kinds = statCards(full()).map((c) => c.kind);
    assert.deepEqual(kinds, [
      'books', 'pages', 'audio', 'months', 'pace', 'genres', 'formats', 'rating', 'crowd', 'author', 'decades', 'languages', 'velocity', 'speed', 'time', 'streak', 'dnf',
      'longest', 'shortest', 'fastest', 'slowest', 'highest', 'lowest', 'oldest', 'reread',
    ]);
    // Every kind is one the server can draw (apps/api cards STAT_KINDS).
    const server = readFileSync(join(ROOT, '../api/src/cards/index.ts'), 'utf8');
    for (const k of kinds) assert.match(server, new RegExp(`'${k}'`), k);
  });

  it('the PRD §17.4 sentence under the figure it qualifies', () => {
    const pages = statCards(full()).find((c) => c.kind === 'pages')!;
    assert.equal(pages.hero, '52,000');
    assert.equal(pages.note, 'Based on 180 of your 247 books — 67 are missing page counts.');
    const crowd = statCards(full(), 'their').find((c) => c.kind === 'crowd')!;
    assert.equal(crowd.hero, '+0.4');
    assert.equal(crowd.note, 'Based on 150 of their 180 rated books — 30 have no other ratings yet.');
  });

  it('never fabricates: a figure with nothing under it has no card, not a zero', () => {
    assert.deepEqual(statCards(empty()).map((c) => c.kind), []);
    const one = { ...full(), languages: [{ language: 'en', count: 247 }] } as ReadingStats;
    assert.ok(!statCards(one).some((c) => c.kind === 'languages'), '§17.2: one language is no language card');
    const all = { ...full(), year: 'all' } as ReadingStats;
    assert.ok(!statCards(all).some((c) => c.kind === 'months'), 'months need a year');
    for (const c of statCards(full())) assert.doesNotMatch(c.hero, /^(0|NaN|undefined|null)?$/, c.kind);
  });

  it('derived figures explain themselves on tap (§17.3)', () => {
    const cards = statCards(full());
    for (const k of ['pages', 'audio', 'crowd', 'velocity', 'speed', 'pace', 'streak']) {
      assert.ok(cards.find((c) => c.kind === k)?.method, k);
    }
  });

  it('fewer than 3 finished books is the empty state (§6.40)', () => {
    assert.equal(STATS_MIN_BOOKS, 3);
    assert.equal(statsEmpty({ books_count: 2 }), true);
    assert.equal(statsEmpty({ books_count: 3 }), false);
    assert.equal(statsEmpty(null), true);
    assert.match(readFileSync(join(ROOT, 'app/stats.tsx'), 'utf8'), /Finish a few books and your stats will appear/);
  });

  it('the screen shares each card through the preview, on your own stats only; no goal ring there (§8.6)', () => {
    const screen = readFileSync(join(ROOT, 'app/stats.tsx'), 'utf8');
    assert.match(screen, /statShareOptions\(/);
    assert.match(screen, /router\.push\(`\/share\?options=/);
    assert.match(screen, /isOtherUser \|\| !targetUserId\s*\?\s*undefined/);
    assert.doesNotMatch(screen, /GoalRing|myGoal|userGoal/);
  });
});

describe('§6.45: the share preview', () => {
  it('a stat for a year, with All time beside it; months and streaks have one option', () => {
    assert.deepEqual(statShareOptions(U, 'books', '2026', 'Asia/Kolkata').map((o) => [o.label, o.card]), [
      ['2026', { template: 'stat', userId: U, stat: 'books', year: 2026, tz: 'Asia/Kolkata' }],
      ['All time', { template: 'stat', userId: U, stat: 'books', year: 'all', tz: 'Asia/Kolkata' }],
    ]);
    assert.equal(statShareOptions(U, 'months', '2026').length, 1);
    assert.equal(statShareOptions(U, 'streak', '2026').length, 1);
    assert.equal(statShareOptions(U, 'books', 'all').length, 1);
  });

  it('options survive the route params; anything malformed is none', () => {
    const opts = [...statShareOptions(U, 'pages', '2025'), ...yearShareOptions(U, 2026, 'calendar')];
    assert.deepEqual(parseShareOptions(encodeShareOptions(opts)), opts.slice(0, 3));
    for (const bad of [undefined, '', 'nope', '{}', JSON.stringify([{ label: 'x', card: { template: 'evil' } }])]) {
      assert.deepEqual(parseShareOptions(bad as string | undefined), [], String(bad));
    }
  });

  it('the analytics events of §6.40, §6.41 and §6.45', () => {
    assert.deepEqual(shareEvents({ template: 'stat', userId: U, stat: 'pages' }).map((e) => e.name), ['stat_card_shared', 'share_completed']);
    assert.deepEqual(shareEvents({ template: 'year', userId: U, year: 2026, card: 'top' })[0], { name: 'yir_card_shared', props: { card: 'top' } });
  });

  it('says why there is no card, in words', () => {
    assert.match(shareErrorMessage({ status: 422, code: 'nothing_to_share' }), /public reads/);
    assert.match(shareErrorMessage({ status: 422, code: 'year_in_review_locked' }), /1 December/);
    assert.match(shareErrorMessage({ status: 429 }), /minute/);
    assert.match(shareErrorMessage(new Error('x')), /Try again/);
    assert.equal(cardFileName('"abcdef0123456789abcd"', 'stat'), 'flyleaf-abcdef0123456789.png');
    assert.equal(cardFileName(null, 'stat0'), 'flyleaf-stat0.png');
  });

  it('the preview is shown before the share sheet, and says cards are public reads only', () => {
    const src = readFileSync(join(ROOT, 'app/share.tsx'), 'utf8');
    assert.ok(src.indexOf('<Image') > 0 && src.indexOf('Sharing.shareAsync') > 0);
    assert.match(src, /disabled=\{!uri \|\| sharing\}/);
    assert.match(src, /public reads only/);
    const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
    assert.ok(appJson.expo.plugins.includes('expo-sharing'), 'native module in the config: needs a native rebuild');
  });
});

describe('ST-09: Year in Review on the phone', () => {
  const yir = (over: Partial<YearInReview>): YearInReview => ({ year: 2026, unlocked: true, unlocks_on: '2026-12-01', variant: 'full', cards: [], ...over });

  it('offered only once open and with a book: no countdown before (design.md §8)', () => {
    assert.equal(yirBanner(yir({ unlocked: false, variant: null })), null);
    assert.equal(yirBanner(yir({ variant: 'empty' })), null);
    assert.equal(yirBanner(null), null);
    assert.deepEqual(yirBanner(yir({ variant: 'gentle' }))?.year, 2026);
  });

  it('locked and empty say so plainly, with no count and no shortfall', () => {
    assert.deepEqual(yirEmptyCopy(yir({ unlocked: false, variant: null })), { title: 'Your 2026 Year in Review', subtitle: 'It opens on 1 December.' });
    const e = yirEmptyCopy(yir({ variant: 'empty' }))!;
    assert.doesNotMatch(`${e.title} ${e.subtitle}`, /only|no books|zero|0 books|yet to|behind/i);
    assert.equal(yirEmptyCopy(yir({ cards: [{ kind: 'books' } as any] })), null);
  });

  it('the notification opens it, under Profile → Stats', () => {
    assert.deepEqual(backStackFor('flyleaf://year-in-review/2026'), ['/profile', '/stats', '/year-in-review?year=2026']);
    const screen = readFileSync(join(ROOT, 'app/year-in-review.tsx'), 'utf8');
    assert.match(screen, /pagingEnabled/);
    assert.match(screen, /yearShareOptions\(/);
    assert.match(screen, /yir_viewed/);
    // The words come from the server: the screen draws card.heading, never its own counts.
    assert.doesNotMatch(screen, /books_count|pages_count/);
  });
});

describe('ST-10: milestone moments', () => {
  const m = (key: string, treatment: Milestone['treatment'] = 'full', data: Record<string, unknown> = {}): Milestone => ({ key, treatment, achieved_at: '2026-10-13T00:00:00Z', data });

  it('§18.4: full for the 1st, 100th, 500th, 1,000th, first review and the goal; subtle for the 10th; the first follower is a note only', () => {
    assert.equal(momentFor(m('books_1', 'full', { read_id: U }), U)?.style, 'full');
    assert.deepEqual(momentFor(m('books_1', 'full', { read_id: U }), U)?.share, { template: 'finish', readId: U });
    assert.equal(momentFor(m('books_10', 'subtle'), U)?.style, 'subtle');
    assert.equal(momentFor(m('books_10', 'subtle'), U)?.share, null);
    assert.deepEqual(momentFor(m('books_100'), U)?.share, { template: 'stat', userId: U, stat: 'books', year: 'all' });
    assert.equal(momentFor(m('books_1000'), U)?.title, '1,000 books');
    assert.deepEqual(momentFor(m('goal_2026'), U)?.share, { template: 'stat', userId: U, stat: 'books', year: 2026 });
    assert.deepEqual(momentFor(m('first_review', 'full', { review_id: U }), U)?.share, { template: 'review', reviewId: U });
    assert.equal(momentFor(m('first_follower', 'note'), U), null);
    assert.equal(LONGEST_YET.style, 'subtle');
  });

  it('a mirror, not a scoreboard: nothing about what is next, how far, or anyone else', () => {
    const all = ['books_1', 'books_10', 'books_100', 'books_500', 'books_1000', 'goal_2026', 'first_review']
      .map((k) => momentFor(m(k, k === 'books_10' ? 'subtle' : 'full'), U)!)
      .concat(LONGEST_YET)
      .map((x) => `${x.title} ${x.body}`).join(' ');
    assert.doesNotMatch(all, /next milestone|to go|away from|only|just|behind|keep it up|don't stop|streak|rank|than (other|your friends)|badge|points|level/i);
  });

  it('in-app only: the bridge is mounted in the session, asks after the finish has synced, and never asks for push permission', () => {
    const layout = readFileSync(join(ROOT, 'app/_layout.tsx'), 'utf8');
    assert.match(layout, /<MilestoneBridge \/>/);
    const bridge = readFileSync(join(ROOT, 'src/ui/MilestoneBridge.tsx'), 'utf8');
    assert.match(bridge, /unsyncedCount/);
    assert.match(bridge, /markMilestonesSeen/);
    assert.doesNotMatch(bridge, /expo-notifications|requestPermissions|scheduleNotification/);
    assert.match(readFileSync(join(ROOT, 'app/finish/[id].tsx'), 'utf8'), /requestMilestoneCheck\(readId\)/);
    assert.match(readFileSync(join(ROOT, 'app/review/compose/[id].tsx'), 'utf8'), /requestMilestoneCheck\(\)/);
  });
});
