// The stats screen as cards (ST-04; PRD §6.40, §17.2–17.4): one statistic per
// card, one dominant number, the chart as support, a share button on each.
//
// Pure, so the rules are tested against the code the screen runs:
//   - every figure is a field of the stats response, formatted, never made up:
//     a figure with nothing under it has no card (§17.4), as the server's
//     share card answers 422 nothing_to_share for it;
//   - every figure that can lack data carries ST-03's sentence
//     (coverageNote), "Based on 180 of your 247 books — 67 are missing page
//     counts.";
//   - every card names the server stat card that shares it (`share`), the
//     same kind, so sharing a stat is the ST-08 card for it;
//   - a derived figure says how it is worked out (`method`, §17.3 "tap for
//     method").

import type { ReadingStats, StatCardKind } from '@flyleaf/api-client';
import { coverageNote, dnfPercent, excludedNote, formatShares, statsRatingRows, streakCopy } from './statsView';

export interface StatBar {
  label: string;
  value: number;
  text: string;
}

export interface StatBook {
  work_id: string;
  title: string;
  author_name?: string | null;
  cover_id?: number | null;
}

export interface StatCardView {
  kind: StatCardKind;
  /** Section heading on the card ("Pages read"). */
  title: string;
  /** The one dominant number, formatted. */
  hero: string;
  caption: string | null;
  detail: string | null;
  /** ST-03 / §17.4: what the figure leaves out, or null when nothing. */
  note: string | null;
  bars: StatBar[];
  book: StatBook | null;
  /** §17.3: how a derived figure is worked out, shown on tap. */
  method: string | null;
}

/** PRD §6.40 "Fewer than 3 finished books → 'Finish a few books and your stats will appear'". */
export const STATS_MIN_BOOKS = 3;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const num = (n: number) => n.toLocaleString('en-GB');
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function languageName(code: string): string {
  try {
    const Names = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of(c: string): string | undefined } }).DisplayNames;
    return (Names ? new Names(['en'], { type: 'language' }).of(code) : undefined) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function hourName(h: number): string {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

function shortDate(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3)} ${d.slice(0, 4)}`;
}

export const METHODS: Partial<Record<StatCardKind, string>> = {
  pages: "Pages come from each book's edition page count. A book without one adds nothing to the total.",
  audio: 'Listening hours are the furthest point you reached in each audiobook, not the sum of every session.',
  crowd: "For each rated book someone else has rated too: your rating minus that book's average without yours, averaged over those books.",
  velocity: 'Days from the start date to the finish date, both days included. The middle value of your books (the median).',
  speed: 'Pages divided by minutes, over the sessions where you logged both. Time between sessions is never counted as reading.',
  pace: 'Pages logged in each week, Monday to Sunday: the rise in page number from one logged page to the next.',
  streak: 'A streak carries on across up to two days without reading.',
  genres: 'Each book counts once, under its strongest genre.',
  months: 'Books by the month you finished them. A book without a finish date is in no month.',
  time: 'When you logged progress, in your own time zone.',
  rating: 'The mean of your star ratings on finished books.',
};

/**
 * The cards, in the order of PRD §6.40's components. `whose` is "your" on your
 * own stats and "their" on someone else's.
 */
export function statCards(s: ReadingStats, whose: 'your' | 'their' = 'your'): StatCardView[] {
  const cards: StatCardView[] = [];
  const add = (c: Omit<StatCardView, 'method' | 'bars' | 'book' | 'detail' | 'note' | 'caption'> & Partial<StatCardView>) =>
    cards.push({ caption: null, detail: null, note: null, bars: [], book: null, method: METHODS[c.kind] ?? null, ...c });
  const note = (key: Parameters<typeof coverageNote>[1]) => coverageNote(s, key, whose);

  if (s.books_count > 0) {
    add({
      kind: 'books', title: 'Books read', hero: num(s.books_count), caption: plural(s.books_count, 'book'),
      detail: s.distinct_works_count < s.books_count ? `${num(s.distinct_works_count)} different ${plural(s.distinct_works_count, 'book')}` : null,
      note: excludedNote(s),
    });
  }
  if (s.coverage.pages.based_on > 0) {
    add({ kind: 'pages', title: 'Pages read', hero: num(s.pages_count), caption: plural(s.pages_count, 'page'), note: note('pages') });
  }
  if (s.audio_hours > 0) {
    add({ kind: 'audio', title: 'Listening', hero: num(s.audio_hours), caption: s.audio_hours === 1 ? 'hour listened' : 'hours listened', note: note('audio') });
  }
  if (s.year !== 'all') {
    const months = s.monthly_pace.filter((m) => m.books > 0);
    const top = [...months].sort((a, b) => b.books - a.books || a.month - b.month)[0];
    if (top) {
      add({
        kind: 'months', title: 'Biggest month', hero: num(top.books), caption: `${plural(top.books, 'book')} in ${MONTHS[top.month - 1]}`,
        bars: s.monthly_pace.map((m) => ({ label: MONTHS[m.month - 1]!.slice(0, 3), value: m.books, text: m.books > 0 ? num(m.books) : '' })),
        note: note('months'),
      });
    }
  }
  const topWeek = [...s.pace].sort((a, b) => b.pages - a.pages || a.week_start.localeCompare(b.week_start))[0];
  if (topWeek && topWeek.pages > 0) {
    add({ kind: 'pace', title: 'Biggest reading week', hero: num(topWeek.pages), caption: 'pages', detail: `Week of ${shortDate(topWeek.week_start)}`, note: note('pace') });
  }
  const genres = s.genres.top.filter((g) => g.name.trim() !== '');
  if (genres.length > 0) {
    add({
      kind: 'genres', title: 'Top genre', hero: num(genres[0]!.count), caption: genres[0]!.name, detail: plural(genres[0]!.count, 'book'),
      bars: [...genres.map((g) => ({ label: g.name, value: g.count, text: num(g.count) })), ...(s.genres.other > 0 ? [{ label: 'Other', value: s.genres.other, text: num(s.genres.other) }] : [])],
      note: note('genres'),
    });
  }
  const formats = formatShares(s.format_breakdown).filter((f) => f.key !== 'unknown');
  const topFormat = [...formats].sort((a, b) => b.count - a.count)[0];
  if (topFormat && topFormat.count > 0) {
    const label = { print: 'Print', ebook: 'Ebook', audiobook: 'Audiobook', unknown: 'Unknown' } as const;
    add({
      kind: 'formats', title: 'How you read', hero: num(topFormat.count),
      caption: topFormat.key === 'print' ? 'in print' : topFormat.key === 'ebook' ? 'as ebooks' : 'as audiobooks',
      bars: formats.map((f) => ({ label: label[f.key], value: f.count, text: `${num(f.count)} (${f.pct}%)` })),
      note: note('formats'),
    });
  }
  if (s.avg_rating != null) {
    add({
      kind: 'rating', title: 'Average rating', hero: s.avg_rating.toFixed(2), caption: 'out of 5',
      bars: statsRatingRows(s.rating_distribution).map((r) => ({ label: `${r.bucket}★`, value: r.count, text: num(r.count) })),
      note: note('ratings'),
    });
  }
  if (s.vs_crowd !== null) {
    const d = s.vs_crowd;
    add({
      kind: 'crowd', title: 'You vs the crowd', hero: d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`,
      caption: d === 0 ? 'You rate books just like everyone else' : d > 0 ? 'stars above the average, per book' : 'stars below the average, per book',
      note: note('vs_crowd'),
    });
  }
  if (s.most_read_author) {
    add({
      kind: 'author', title: 'Most-read author', hero: num(s.most_read_author.count), caption: s.most_read_author.name,
      detail: plural(s.most_read_author.count, 'book'), note: note('authors'),
    });
  }
  if (s.decades.length > 0) {
    const sorted = [...s.decades].sort((a, b) => b.count - a.count || a.decade - b.decade);
    add({
      kind: 'decades', title: 'Favourite decade', hero: `${sorted[0]!.decade}s`, caption: `${num(sorted[0]!.count)} ${plural(sorted[0]!.count, 'book')} first published then`,
      bars: [...s.decades].sort((a, b) => a.decade - b.decade).map((d) => ({ label: `${d.decade}s`, value: d.count, text: num(d.count) })),
      note: note('decades'),
    });
  }
  // §17.2: shown only when there is more than one language.
  if (s.languages.length > 1) {
    add({
      kind: 'languages', title: 'Languages', hero: num(s.languages.length), caption: 'languages read',
      bars: s.languages.map((l) => ({ label: languageName(l.language), value: l.count, text: num(l.count) })),
      note: note('languages'),
    });
  }
  if (s.velocity.median_days !== null) {
    add({
      kind: 'velocity', title: 'Time to finish', hero: num(s.velocity.median_days),
      caption: s.velocity.median_days === 1 ? 'day for a typical book' : 'days for a typical book', note: note('velocity'),
    });
  }
  if (s.speed.pages_per_hour !== null) {
    add({
      kind: 'speed', title: 'Reading speed', hero: num(s.speed.pages_per_hour), caption: 'pages an hour',
      detail: `${num(s.speed.pages)} pages in ${num(s.speed.minutes)} timed minutes`, note: note('speed'),
    });
  }
  const byHour = Array.from({ length: 24 }, (_, h) => s.time_of_day.reduce((n, row) => n + (row[h] ?? 0), 0));
  const hour = byHour.reduce((bi, n, i) => (n > byHour[bi]! ? i : bi), 0);
  if (byHour[hour]! > 0) {
    let slot = { day: 0, hour: 0, n: 0 };
    s.time_of_day.forEach((row, day) => row.forEach((n, h) => { if (n > slot.n) slot = { day, hour: h, n }; }));
    add({ kind: 'time', title: 'When you read', hero: hourName(hour), caption: 'is your reading hour', detail: `Most of all on ${DAYS[slot.day]} at ${hourName(slot.hour)}` });
  }
  const streak = streakCopy(s);
  if (streak) add({ kind: 'streak', title: streak.label, hero: streak.hero, caption: null, detail: streak.detail });
  if (s.dnf_count > 0) {
    // design.md §8: "Stopped reading", never "gave up".
    add({ kind: 'dnf', title: 'Stopped reading', hero: num(s.dnf_count), caption: plural(s.dnf_count, 'book'), detail: `${dnfPercent(s.dnf_rate)}% of the books you started · Not every book is for every reader.` });
  }

  const extreme = (kind: StatCardKind, title: string, b: StatBook | null | undefined, hero: string, caption: string) => {
    if (b) add({ kind, title, hero, caption, detail: b.title, book: { work_id: b.work_id, title: b.title, author_name: b.author_name ?? null, cover_id: b.cover_id ?? null } });
  };
  extreme('longest', 'Longest book', s.longest_book, num(s.longest_book?.page_count ?? 0), 'pages');
  extreme('shortest', 'Shortest book', s.shortest_book, num(s.shortest_book?.page_count ?? 0), 'pages');
  extreme('fastest', 'Fastest read', s.fastest_read, num(s.fastest_read?.days ?? 0), s.fastest_read?.days === 1 ? 'day' : 'days');
  extreme('slowest', 'Slowest read', s.slowest_read, num(s.slowest_read?.days ?? 0), s.slowest_read?.days === 1 ? 'day' : 'days');
  extreme('highest', 'Highest rated', s.highest_rated, (s.highest_rated?.rating ?? 0).toFixed(1), 'stars');
  extreme('lowest', 'Lowest rated', s.lowest_rated, (s.lowest_rated?.rating ?? 0).toFixed(1), 'stars');
  extreme('oldest', 'Oldest book', s.oldest_publication, String(s.oldest_publication?.year ?? ''), 'first published');
  extreme('reread', 'Most re-read', s.most_reread, num(s.most_reread?.count ?? 0), 'times read');
  return cards;
}

/** The empty state: too few books for the screen to be about anything yet (§6.40). */
export function statsEmpty(s: Pick<ReadingStats, 'books_count'> | null): boolean {
  return !s || s.books_count < STATS_MIN_BOOKS;
}
