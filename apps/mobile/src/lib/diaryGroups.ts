// Diary grouping and totals (SL-70, PRD §6.18, §17.4; audit 10). Plain
// functions so the rules are tested against the code the screen runs.

export interface DiaryRead {
  finished_at?: string | null;
  page_count?: number | null;
}

export interface DiaryGroup<R> {
  monthKey: string;
  monthLabel: string;
  reads: R[];
}

const UNDATED = 'undated';

/**
 * Newest month first, by the finish DATE as written (YYYY-MM-DD): parsing it
 * with new Date() made it UTC midnight, so a 1 March finish showed under
 * February west of Greenwich. A read with no finish date is never placed by
 * another date (§17.4 "never fabricate"): it goes under "Undated", last
 * (§6.18).
 */
export function groupDiary<R extends DiaryRead>(reads: R[], locale?: string): DiaryGroup<R>[] {
  const dated = reads
    .filter((r) => r.finished_at && /^\d{4}-\d{2}/.test(r.finished_at))
    .sort((a, b) => b.finished_at!.localeCompare(a.finished_at!));
  const groups: DiaryGroup<R>[] = [];
  for (const r of dated) {
    const key = r.finished_at!.slice(0, 7);
    let group = groups[groups.length - 1];
    if (!group || group.monthKey !== key) {
      const [y, m] = key.split('-').map(Number);
      const label = new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
      group = { monthKey: key, monthLabel: label, reads: [] };
      groups.push(group);
    }
    group.reads.push(r);
  }
  const undated = reads.filter((r) => !r.finished_at || !/^\d{4}-\d{2}/.test(r.finished_at));
  if (undated.length > 0) groups.push({ monthKey: UNDATED, monthLabel: 'Undated', reads: undated });
  return groups;
}

/** Pages of the finished books shown: their page counts, never the bookmark position. */
export function diaryPages(reads: DiaryRead[]): number {
  return reads.reduce((sum, r) => sum + (r.page_count ?? 0), 0);
}
