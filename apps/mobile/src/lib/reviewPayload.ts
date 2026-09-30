// What the review composer sends (SL-63, audit 09). A plain function so the
// rules are testable without rendering the screen.

/**
 * A review belongs to a read that has been started (A-09-026, decided
 * 2026-09-30): no read, or a book only on the want list, cannot be reviewed.
 * The server refuses a want read with 422 review_needs_reading.
 */
export function canReview(readStatus: string | null | undefined): boolean {
  return readStatus != null && readStatus !== 'want';
}

export interface ComposerState {
  body: string;
  hasSpoilers: boolean;
  /** The page field's text: digits, or empty. */
  spoilerAfterPage: string;
  visibility: 'public' | 'followers' | 'private';
  rating: number | null;
  ratingTouched: boolean;
  hearted: boolean;
  heartTouched: boolean;
}

export function buildReviewPayload(s: ComposerState) {
  return {
    body: s.body.trim(),
    has_spoilers: s.hasSpoilers,
    // The page means nothing without the spoiler switch; the field keeps its
    // text when the switch goes off.
    spoiler_after_page: s.hasSpoilers && s.spoilerAfterPage ? parseInt(s.spoilerAfterPage, 10) : null,
    visibility: s.visibility,
    // Only what was changed here: a screen that could not load the read's
    // rating or heart must not overwrite them with blanks (null clears).
    ...(s.ratingTouched ? { rating: s.rating } : {}),
    ...(s.heartTouched ? { hearted: s.hearted } : {}),
  };
}
