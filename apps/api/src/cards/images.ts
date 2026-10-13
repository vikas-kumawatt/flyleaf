// Images on share cards (ST-07): from our own storage, never hot-linked.
//
// A card is a picture that leaves the app, so it must not depend on, or point
// at, anyone else's server. Every image a template draws is a data: URI made
// here from bytes in OUR object storage (the storage port, PV-01):
//
//   covers   `covers/ol/<cover id>-L.jpg`. The first card that needs a cover
//            copies it from Open Library once, through the one shared
//            outbound limiter and breaker (platform/outbound.ts, architecture
//            §5.2; by cover id, never ISBN: §40.3), and stores it. Every later
//            card reads our copy. While a cover cannot be had (Open Library
//            down, the limiter busy, no such cover), the card draws a
//            typographic poster instead: a card is never held up past its
//            budget, and never has a hole.
//   avatars  the profile's current avatar object (uploads), as stored.
//
// Only JPEG and PNG are drawn (the magic bytes decide, not a header); a WebP
// avatar is shown as initials. Nothing over MAX_IMAGE_BYTES is read.

import type { ObjectStorage } from '../providers/storage/index.js';
import { readAll } from '../providers/storage/index.js';
import { outbound, type OutboundResult } from '../platform/outbound.js';
import { imageTypeOf } from '../uploads/index.js';
import type { CardImage } from './templates.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** How long a card waits for covers it has not copied yet. AC-18 gives the whole card 2 s. */
export const COVER_BUDGET_MS = 1_200;
/** A cover Open Library does not have is not asked for again for this long. */
const MISSING_TTL_MS = 60 * 60 * 1000;

export type FetchBytes = (url: string) => Promise<OutboundResult<{ bytes: Buffer; contentType: string | null }>>;

/** The production fetch: the shared outbound client, waiting its turn at the limiter. */
export const outboundFetch: FetchBytes = (url) =>
  outbound.getBytes(url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 3_000, blocking: true });

export const coverKey = (coverId: number) => `covers/ol/${coverId}-L.jpg`;

/** `default=false`: a missing cover is a 404, not Open Library's placeholder image. */
export const openLibraryCoverUrl = (coverId: number) => `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`;

export function toImage(bytes: Buffer): CardImage | null {
  const type = imageTypeOf(bytes.subarray(0, 16));
  if (type !== 'image/jpeg' && type !== 'image/png') return null;
  return { uri: `data:${type};base64,${bytes.toString('base64')}` };
}

export class CardImages {
  readonly #missing = new Map<number, number>();
  readonly #inflight = new Map<number, Promise<CardImage | null>>();

  constructor(
    private readonly storage: ObjectStorage | null,
    private readonly fetchBytes: FetchBytes = outboundFetch,
    private readonly budgetMs = COVER_BUDGET_MS,
  ) {}

  async #read(key: string): Promise<Buffer | null> {
    if (!this.storage) return null;
    const info = await this.storage.head(key);
    if (!info || info.size > MAX_IMAGE_BYTES) return null;
    const stream = await this.storage.getStream(key);
    return stream ? readAll(stream) : null;
  }

  /** Our copy of a cover, copying it first if we have none. null: draw a poster. */
  async #cover(coverId: number): Promise<CardImage | null> {
    if (!this.storage || !Number.isSafeInteger(coverId) || coverId <= 0) return null;
    const key = coverKey(coverId);
    const stored = await this.#read(key);
    if (stored) return toImage(stored);
    const missingUntil = this.#missing.get(coverId);
    if (missingUntil !== undefined && missingUntil > Date.now()) return null;
    const res = await this.fetchBytes(openLibraryCoverUrl(coverId));
    if (!res.ok) {
      if (res.reason === 'http' || res.reason === 'parse') this.#missing.set(coverId, Date.now() + MISSING_TTL_MS);
      return null;
    }
    const image = toImage(res.data.bytes);
    if (!image) {
      this.#missing.set(coverId, Date.now() + MISSING_TTL_MS);
      return null;
    }
    await this.storage.put(key, res.data.bytes, image.uri.slice(5, image.uri.indexOf(';')));
    return image;
  }

  /**
   * Covers for a card, in order, waiting at most the budget for any not yet
   * copied. A copy still running at the deadline finishes in the background
   * and is there for the next card.
   */
  async covers(ids: Array<number | null>): Promise<Array<CardImage | null>> {
    const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), this.budgetMs).unref());
    return Promise.all(ids.map((id) => {
      if (id === null) return null;
      let pending = this.#inflight.get(id);
      if (!pending) {
        pending = this.#cover(id).catch(() => null).finally(() => this.#inflight.delete(id));
        this.#inflight.set(id, pending);
      }
      return Promise.race([pending, deadline]);
    }));
  }

  async avatar(key: string | null): Promise<CardImage | null> {
    if (!key) return null;
    const bytes = await this.#read(key).catch(() => null);
    return bytes ? toImage(bytes) : null;
  }
}
