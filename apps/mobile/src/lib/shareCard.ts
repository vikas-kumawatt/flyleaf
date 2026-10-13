// The share preview (PRD §6.45; ST-04, ST-09): what to ask the server for,
// what to call the file, what to say when there is no card. Pure; the screen
// is app/share.tsx.
//
// A card is always the server's (ST-07: "generated server-side so it is
// identical everywhere"), shown in full before the share sheet opens: nobody
// shares an image they have not seen. Aggregate cards count public reads
// only, so the preview says so: the card can show less than the screen.

import type { ShareCard, StatCardKind, YearInReviewCardKind } from '@flyleaf/api-client';

export interface ShareOption {
  /** The template switcher's label (§6.45 "2–3 options"). */
  label: string;
  card: ShareCard;
}

const TEMPLATES = new Set(['finish', 'review', 'stat', 'profile', 'wall', 'year']);

/** Route params carry the options as JSON. */
export function encodeShareOptions(options: ShareOption[]): string {
  return JSON.stringify(options);
}

/** The options from route params; anything malformed is no options (the screen says it cannot make a card). */
export function parseShareOptions(raw: string | string[] | undefined): ShareOption[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((o): o is ShareOption => !!o && typeof o === 'object'
        && typeof (o as ShareOption).label === 'string'
        && !!(o as ShareOption).card && TEMPLATES.has((o as ShareOption).card.template))
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** A stat card for this year, with All time beside it where that is a different card (§6.45 switcher). */
export function statShareOptions(userId: string, stat: StatCardKind, year: string, tz?: string): ShareOption[] {
  const card = (y: number | 'all'): ShareCard => ({ template: 'stat', userId, stat, year: y, ...(tz ? { tz } : {}) });
  if (stat === 'streak') return [{ label: 'Streak', card: card('all') }];
  if (year === 'all') return [{ label: 'All time', card: card('all') }];
  const options: ShareOption[] = [{ label: year, card: card(Number(year)) }];
  // Months are per year: "all time" would fold every March together.
  if (stat !== 'months') options.push({ label: 'All time', card: card('all') });
  return options;
}

export function yearShareOptions(userId: string, year: number, kind: YearInReviewCardKind, tz?: string): ShareOption[] {
  return [{ label: String(year), card: { template: 'year', userId, year, card: kind, ...(tz ? { tz } : {}) } }];
}

/** The analytics events of PRD §6.40, §6.41, §6.45 for a shared card. */
export function shareEvents(card: ShareCard): Array<{ name: string; props: Record<string, string> }> {
  const generic = { name: 'share_completed', props: { destination: 'share_sheet', template: card.template } };
  switch (card.template) {
    case 'stat': return [{ name: 'stat_card_shared', props: { card: card.stat } }, generic];
    case 'year': return [{ name: 'yir_card_shared', props: { card: card.card } }, generic];
    case 'wall': return [{ name: 'wall_shared', props: { layout: card.layout ?? '4x4' } }, generic];
    case 'profile': return [{ name: 'profile_shared', props: {} }, generic];
    default: return [generic];
  }
}

/** A file name the share sheet shows: the card's content hash keeps two cards apart. */
export function cardFileName(etag: string | null, fallback: string): string {
  const hash = (etag ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 16);
  return `flyleaf-${hash || fallback.replace(/[^0-9a-z]/gi, '').slice(0, 16) || 'card'}.png`;
}

/** What to say when the server has no card for this (design.md §8: explain, offer a way on). */
export function shareErrorMessage(err: unknown): string {
  const e = err as { status?: number; code?: string } | null;
  if (e?.code === 'nothing_to_share') {
    return 'There is nothing for this card from your public reads yet. Cards show public reads only.';
  }
  if (e?.code === 'year_in_review_locked') return 'Your Year in Review opens on 1 December.';
  if (e?.status === 429) return 'That was a lot of cards at once. Try again in a minute.';
  if (e?.status === 404) return 'This card is not available.';
  return "We couldn't make this card. Try again.";
}

/** Bytes to a Uint8Array for the file writer. */
export function pngBytes(png: ArrayBuffer): Uint8Array {
  return new Uint8Array(png);
}
