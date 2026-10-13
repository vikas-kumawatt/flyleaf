// Year in Review (ST-09; PRD §6.41, §17.5, §17.6, §18.2, §29.1 loop 2, §8.6).
//
//   GET /v1/me/year-in-review?year=&tz=     the reader's own, as story cards
//
// Built from the SAME per-viewer stats as the stats screen: every figure on a
// card is a field of ReadingService.getStats(viewer, user, year, tz), the
// owner's full data on the screen (§17.5 "Year in Review uses the owner's full
// data"). The share cards (cards/index.ts) call the same function with
// `publicOnly`, so a card that leaves the app carries public figures only and
// says so. The few things the stats response does not carry (the top four by
// rating, the books of the year, the days with reading) come from one more
// query under the same visibility levels.
//
// UNLOCK (§6.41, §17.6): 1 December of that year, in the reader's own time
// zone, and re-viewable any time after. Before then the response says when,
// and nothing is computed.
//
// LOW VOLUME (§17.6): under 5 books read in the year, a gentle variant that
// celebrates without measuring: no counts at all, only the books, a favourite,
// the genres by name and (if met) the goal. Nothing in either variant says
// "only", "just", "behind" or how far from a goal anyone is: a goal appears
// only when it was reached (§8.6: never a shortfall).
//
// NEVER FABRICATE (§17.4): a card whose figure has nothing under it is left
// out, and a figure based on part of the books carries ST-03's sentence.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { ApiError, requireViewer } from '../http.js';
import { errorResponseSchema } from '../contract/schemas.js';
import { canViewWith, loadRelationship, visibleLevels } from '../authorization/index.js';
import { ReadingService, isTimeZone, localDate, type ReadingStats } from './index.js';

/** §17.6 "Under 5 books → a celebratory variant". */
export const LOW_VOLUME_BOOKS = 5;

export const YIR_FULL_KINDS = ['books', 'pages', 'genres', 'top', 'longest', 'author', 'crowd', 'calendar', 'goal', 'summary'] as const;
export const YIR_GENTLE_KINDS = ['shelf', 'favourite', 'genre_names', 'goal', 'summary_gentle'] as const;
export const YIR_CARD_KINDS = [...new Set([...YIR_FULL_KINDS, ...YIR_GENTLE_KINDS])] as const;
export type YirCardKind = (typeof YIR_CARD_KINDS)[number];

/**
 * A card asked for by its full-variant name when the figures it would be
 * drawn from are low-volume (a share card counts public reads only, so it can
 * be gentle where the screen is not): the gentle card in its place.
 */
export const GENTLE_EQUIVALENT: Partial<Record<YirCardKind, YirCardKind>> = {
  books: 'shelf', summary: 'summary_gentle', top: 'favourite', genres: 'genre_names',
};

export interface YirBook {
  work_id: string;
  title: string;
  author_name: string | null;
  cover_id: number | null;
  rating: number | null;
  explicit: boolean;
}

export interface YirCard {
  kind: YirCardKind;
  heading: string;
  /** The one figure, formatted; null on cards that have none (every gentle card). */
  value: string | null;
  caption: string | null;
  detail: string | null;
  /** ST-03's sentence when the figure is based on part of the books. */
  note: string | null;
  books: YirBook[];
  bars: Array<{ label: string; value: number; text: string }>;
  /** Twelve months of days, 1 = read that day, 0 = not; null on other cards. */
  calendar: number[][] | null;
}

export interface YearInReview {
  year: number;
  unlocked: boolean;
  /** YYYY-12-01: the reader's local date it opens. */
  unlocks_on: string;
  /** null while locked; 'empty' with no finished book in the year. */
  variant: 'full' | 'gentle' | 'empty' | null;
  cards: YirCard[];
}

export const unlocksOn = (year: number) => `${year}-12-01`;

/** Unlocked from 1 December of `year` in `tz` (§6.41), for good. */
export function isUnlocked(year: number, tz: string, now: Date): boolean {
  return localDate(tz, now) >= unlocksOn(year);
}

/** The latest year that is open in `tz`: this year from 1 December, else last year. */
export function latestYear(tz: string, now: Date): number {
  const today = localDate(tz, now);
  const y = Number(today.slice(0, 4));
  return today >= unlocksOn(y) ? y : y - 1;
}

const num = (n: number) => n.toLocaleString('en-GB');
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function coverage(c: { based_on: number; of: number }, missing: [string, string], unit: [string, string] = ['book', 'books']): string | null {
  if (c.of === 0 || c.based_on >= c.of) return null;
  const left = c.of - c.based_on;
  return `Based on ${num(c.based_on)} of ${num(c.of)} ${c.of === 1 ? unit[0] : unit[1]} — ${num(left)} ${left === 1 ? missing[0] : missing[1]}.`;
}

/** "Fantasy", "Fantasy and history", "Fantasy, history and poetry". */
function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Twelve rows of 1/0 for the days in `active` (YYYY-MM-DD), within `year`. */
export function calendarGrid(year: number, active: string[]): number[][] {
  const set = new Set(active);
  return Array.from({ length: 12 }, (_, m) =>
    Array.from({ length: daysInMonth(year, m + 1) }, (_, d) =>
      (set.has(`${year}-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`) ? 1 : 0)));
}

export interface YearExtras {
  /** Up to four rated finishes, best first (§17.6 "Your top 4 by rating"); each book once. */
  top: YirBook[];
  /** Up to four finished books of the year, latest first; each book once. */
  shelf: YirBook[];
  /** Local days in the year with a progress event or a finish (the streak's days). */
  activeDays: string[];
  /** The account's goal for the year, if one is set. */
  goalTarget: number | null;
}

/**
 * The cards, from the stats and the extras of one viewer. Pure: the screen and
 * the share cards both come through here, so they cannot disagree.
 */
export function yearInReviewCards(year: number, s: ReadingStats, x: YearExtras): Pick<YearInReview, 'variant' | 'cards'> {
  if (s.books_count === 0) return { variant: 'empty', cards: [] };
  const blank = { value: null, caption: null, detail: null, note: null, books: [], bars: [], calendar: null };
  const goalMet = x.goalTarget !== null && s.books_count >= x.goalTarget;
  const genres = s.genres.top.map((g) => g.name).filter((n) => n.trim() !== '');

  if (s.books_count < LOW_VOLUME_BOOKS) {
    // §17.6: celebrate, never measure. No count appears on any of these.
    const cards: YirCard[] = [
      { ...blank, kind: 'shelf', heading: `The books of your ${year}`, books: x.shelf },
    ];
    const fav = x.top[0];
    if (fav) cards.push({ ...blank, kind: 'favourite', heading: 'A favourite', caption: fav.title, detail: fav.author_name, books: [fav] });
    if (genres.length > 0) {
      cards.push({ ...blank, kind: 'genre_names', heading: 'What you read', caption: namesList(genres.slice(0, 3)) });
    }
    if (goalMet) cards.push({ ...blank, kind: 'goal', heading: 'Goal reached', caption: `You set a reading goal for ${year} and reached it.` });
    cards.push({ ...blank, kind: 'summary_gentle', heading: `Your ${year} in books`, caption: 'A year of good reading.', books: x.shelf });
    return { variant: 'gentle', cards };
  }

  const cards: YirCard[] = [];
  const undated = s.excluded.undated;
  cards.push({
    ...blank, kind: 'books', heading: 'Books read', value: num(s.books_count), caption: plural(s.books_count, 'book'),
    detail: s.distinct_works_count < s.books_count ? `${num(s.distinct_works_count)} different ${plural(s.distinct_works_count, 'book')}` : null,
    note: undated > 0 ? `${num(undated)} ${plural(undated, 'book has', 'books have')} no finish date and ${undated === 1 ? 'is' : 'are'} in no year.` : null,
  });
  if (s.coverage.pages.based_on > 0) {
    cards.push({
      ...blank, kind: 'pages', heading: 'Pages read', value: num(s.pages_count), caption: plural(s.pages_count, 'page'),
      note: coverage(s.coverage.pages, ['has no page count', 'have no page count']),
    });
  }
  if (genres.length > 0) {
    const top = s.genres.top.filter((g) => g.name.trim() !== '');
    cards.push({
      ...blank, kind: 'genres', heading: 'Genre mix', caption: top[0]!.name, detail: `${num(top[0]!.count)} ${plural(top[0]!.count, 'book')}`,
      bars: top.slice(0, 5).map((g) => ({ label: g.name, value: g.count, text: num(g.count) })),
      note: coverage(s.coverage.genres, ['has no genre', 'have no genre']),
    });
  }
  if (x.top.length > 0) {
    cards.push({ ...blank, kind: 'top', heading: x.top.length === 4 ? 'Your top 4' : 'Your top rated', books: x.top });
  }
  if (s.longest_book) {
    const b = s.longest_book;
    cards.push({
      ...blank, kind: 'longest', heading: 'Longest book', value: num(b.page_count ?? 0), caption: 'pages', detail: b.title,
      books: [{ work_id: b.work_id, title: b.title, author_name: b.author_name, cover_id: b.cover_id, rating: null, explicit: false }],
    });
  }
  // A "most-read" author with one book is every author: no card.
  if (s.most_read_author && s.most_read_author.count >= 2) {
    cards.push({
      ...blank, kind: 'author', heading: 'Most-read author', value: num(s.most_read_author.count), caption: s.most_read_author.name,
      detail: 'books', note: coverage(s.coverage.authors, ['has no author recorded', 'have no author recorded']),
    });
  }
  if (s.vs_crowd !== null) {
    const d = s.vs_crowd;
    cards.push({
      ...blank, kind: 'crowd', heading: 'You vs the crowd',
      value: d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`,
      caption: d === 0 ? 'You rate books just like everyone else' : d > 0 ? 'stars above the average, per book' : 'stars below the average, per book',
      note: coverage(s.coverage.vs_crowd, ['has no other ratings yet', 'have no other ratings yet'], ['rated book', 'rated books']),
    });
  }
  if (x.activeDays.length > 0) {
    cards.push({
      ...blank, kind: 'calendar', heading: 'Reading calendar', value: num(x.activeDays.length),
      caption: plural(x.activeDays.length, 'day with reading', 'days with reading'), calendar: calendarGrid(year, x.activeDays),
    });
  }
  if (goalMet) {
    cards.push({ ...blank, kind: 'goal', heading: 'Goal reached', value: num(s.books_count), caption: `books, for a goal of ${num(x.goalTarget!)}` });
  }
  const pagesPart = s.coverage.pages.based_on > 0 ? `${num(s.pages_count)} ${plural(s.pages_count, 'page')}` : null;
  cards.push({
    ...blank, kind: 'summary', heading: `${year} in books`, value: num(s.books_count), caption: plural(s.books_count, 'book'),
    detail: [pagesPart, genres[0] ? `mostly ${genres[0]}` : null].filter(Boolean).join(' · ') || null,
    books: x.top.length > 0 ? x.top : x.shelf,
  });
  return { variant: 'full', cards };
}

type BookRow = { work_id: string; title: string; author_name: string | null; cover_id: number | null; rating: string | null; explicit: boolean };
const toBook = (r: BookRow): YirBook => ({
  work_id: r.work_id, title: r.title, author_name: r.author_name, cover_id: r.cover_id === null ? null : Number(r.cover_id),
  rating: r.rating === null ? null : Number(r.rating), explicit: Boolean(r.explicit),
});

export interface YearInReviewOptions {
  now?: () => Date;
}

export class YearInReviewService {
  readonly #reading: ReadingService;
  readonly #now: () => Date;

  constructor(private readonly db: Db, opts: YearInReviewOptions = {}) {
    this.#reading = new ReadingService(db);
    this.#now = opts.now ?? (() => new Date());
  }

  /** What the reader may count in the year, for this viewer, under the stats' visibility levels. */
  async extras(viewer: string | null, userId: string, year: number, tz: string, opts: { publicOnly?: boolean } = {}): Promise<YearExtras> {
    const rel = await loadRelationship(this.db, viewer, userId);
    if (!canViewWith(viewer, userId, rel)) throw ApiError.notFound('User not found.');
    const levels = visibleLevels(viewer, userId, rel).filter((l) => !opts.publicOnly || l === 'public');
    const levelList = sql.join(levels.map((l) => sql`${l}`), sql`, `);
    const ys = `${year}-01-01`;
    const ye = `${year + 1}-01-01`;
    // The same finishes as the stats' books_count for the year: finished,
    // dated within it, in the viewer's levels. Each book once, at its best
    // rating (top) or latest finish (shelf).
    const book = sql`
      SELECT DISTINCT ON (r.work_id) r.work_id, w.title, r.rating::text AS rating, r.finished_at, w.maturity = 'explicit' AS explicit,
             (SELECT a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id
               WHERE wa.work_id = w.id ORDER BY wa.position, a.name LIMIT 1) AS author_name,
             COALESCE(e.ol_cover_id, w.ol_cover_id,
               (SELECT e2.ol_cover_id FROM editions e2 WHERE e2.work_id = w.id AND e2.ol_cover_id IS NOT NULL LIMIT 1)) AS cover_id
        FROM reads r JOIN works w ON w.id = r.work_id LEFT JOIN editions e ON e.id = r.edition_id
       WHERE r.user_id = ${userId}::uuid AND r.visibility IN (${levelList}) AND r.status = 'finished'
         AND r.finished_at >= ${ys}::date AND r.finished_at < ${ye}::date`;
    const [top, shelf, days, goal] = await Promise.all([
      this.db.execute<BookRow>(sql`
        SELECT * FROM (${book} AND r.rating IS NOT NULL ORDER BY r.work_id, r.rating DESC, r.finished_at DESC) b
         ORDER BY b.rating::numeric DESC, b.finished_at DESC, b.work_id LIMIT 4`),
      this.db.execute<BookRow>(sql`
        SELECT * FROM (${book} ORDER BY r.work_id, r.finished_at DESC, r.attempt_no DESC) b
         ORDER BY b.finished_at DESC, b.work_id LIMIT 4`),
      this.db.execute<{ d: string }>(sql`
        SELECT DISTINCT (pe.at AT TIME ZONE ${tz})::date::text AS d
          FROM reads r JOIN progress_events pe ON pe.read_id = r.id
         WHERE r.user_id = ${userId}::uuid AND r.visibility IN (${levelList})
           AND pe.at >= (${ys}::timestamp AT TIME ZONE ${tz}) AND pe.at < (${ye}::timestamp AT TIME ZONE ${tz})
        UNION
        SELECT r.finished_at::text FROM reads r
         WHERE r.user_id = ${userId}::uuid AND r.visibility IN (${levelList})
           AND r.finished_at >= ${ys}::date AND r.finished_at < ${ye}::date`),
      this.db.execute<{ target_books: number }>(sql`SELECT target_books FROM goals WHERE user_id = ${userId}::uuid AND year = ${year}`),
    ]);
    return {
      top: top.map(toBook),
      shelf: shelf.map(toBook),
      activeDays: days.map((d) => d.d).sort(),
      goalTarget: goal[0] ? Number(goal[0].target_books) : null,
    };
  }

  /**
   * The Year in Review of `userId` as `viewer` may count it. The screen asks as
   * the owner; share cards ask with `publicOnly`. `year` absent: the latest
   * open year in `tz`.
   */
  async get(viewer: string, userId: string, yearParam?: string, tzParam?: string, opts: { publicOnly?: boolean } = {}): Promise<YearInReview> {
    const tz = tzParam ?? 'UTC';
    if (!isTimeZone(tz)) throw ApiError.unprocessable('invalid_timezone', 'Unknown time zone. Send an IANA name such as Europe/London.', 'tz');
    const now = this.#now();
    let year: number;
    if (yearParam === undefined) year = latestYear(tz, now);
    else if (/^\d{4}$/.test(yearParam) && Number(yearParam) >= 1900) year = Number(yearParam);
    else throw ApiError.unprocessable('invalid_year', 'Year is YYYY.', 'year');

    if (!isUnlocked(year, tz, now)) return { year, unlocked: false, unlocks_on: unlocksOn(year), variant: null, cards: [] };
    const [stats, extras] = await Promise.all([
      this.#reading.getStats(viewer, userId, String(year), tz, opts),
      this.extras(viewer, userId, year, tz, opts),
    ]);
    return { year, unlocked: true, unlocks_on: unlocksOn(year), ...yearInReviewCards(year, stats, extras) };
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const yirBookSchema = {
  type: 'object',
  properties: {
    work_id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    author_name: { type: ['string', 'null'] },
    cover_id: { type: ['integer', 'null'] },
    rating: { type: ['number', 'null'] },
    explicit: { type: 'boolean' },
  },
  required: ['work_id', 'title', 'author_name', 'cover_id', 'rating', 'explicit'],
} as const;

export const yirCardSchema = {
  type: 'object',
  description: 'One story card, its words composed by the server so the screen and the share card say the same thing.',
  properties: {
    kind: { type: 'string', enum: [...YIR_CARD_KINDS] },
    heading: { type: 'string' },
    value: { type: ['string', 'null'], description: 'The figure, formatted; null on gentle cards, which carry no counts.' },
    caption: { type: ['string', 'null'] },
    detail: { type: ['string', 'null'] },
    note: { type: ['string', 'null'], description: 'ST-03: "Based on N of M books — K have …" when the figure is based on part of the books.' },
    books: { type: 'array', items: yirBookSchema },
    bars: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'integer' }, text: { type: 'string' } },
        required: ['label', 'value', 'text'],
      },
    },
    calendar: {
      anyOf: [{ type: 'array', items: { type: 'array', items: { type: 'integer' } } }, { type: 'null' }],
      description: 'Twelve months of days, 1 = read that day.',
    },
  },
  required: ['kind', 'heading', 'value', 'caption', 'detail', 'note', 'books', 'bars', 'calendar'],
} as const;

export const yearInReviewResponseSchema = {
  type: 'object',
  description: 'ST-09, PRD §6.41, §17.6: the reader\'s Year in Review from their own full stats (§17.5).',
  properties: {
    year: { type: 'integer' },
    unlocked: { type: 'boolean' },
    unlocks_on: { type: 'string', format: 'date', description: '1 December of the year, in the reader\'s time zone.' },
    variant: { type: ['string', 'null'], enum: ['full', 'gentle', 'empty', null], description: 'gentle: under 5 books, no counts (§17.6). null while locked.' },
    cards: { type: 'array', items: yirCardSchema },
  },
  required: ['year', 'unlocked', 'unlocks_on', 'variant', 'cards'],
} as const;

export function yearInReviewRoutes(db: Db, opts: YearInReviewOptions = {}) {
  return async (app: import('fastify').FastifyInstance) => {
    const service = new YearInReviewService(db, opts);
    app.get<{ Querystring: { year?: string; tz?: string } }>('/me/year-in-review', {
      schema: {
        tags: ['Reading'],
        summary: 'My Year in Review',
        description: 'Story cards for a year (default: the latest open one in tz), from the same stats as GET /me/stats?year=, private reads included (PRD §17.5). Opens on 1 December in tz and stays open (§6.41); before then unlocked is false and cards is empty. Under 5 books the gentle variant carries no counts (§17.6).',
        security: [{ BearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            year: { type: 'string', description: 'YYYY. Default: this year from 1 December in tz, else last year.' },
            tz: { type: 'string', maxLength: 64, description: 'IANA zone: the reader\'s day. Default UTC.' },
          },
        },
        response: { 200: yearInReviewResponseSchema, 401: errorResponseSchema, 422: errorResponseSchema },
      },
    }, async (req) => {
      const viewer = requireViewer(req);
      return service.get(viewer, viewer, req.query.year, req.query.tz);
    });
  };
}
