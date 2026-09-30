// Half-star rating rules for the Stars control (SL-60, PRD §9.2–9.3).
// Plain functions so they are testable without rendering.

/** The half-star under x on a row `rowWidth` wide: 0.5 … 5.0, never 0. */
export function starTarget(x: number, rowWidth: number): number {
  const clamped = Math.max(0, Math.min(rowWidth, x));
  const bucket = Math.ceil((clamped / rowWidth) * 10);
  return Math.max(0.5, Math.min(5.0, bucket * 0.5));
}

/** A tap on the current value takes the rating away (PRD §9.3: a rating is optional). */
export function tapRating(target: number, current: number | null): number | null {
  return target === current ? null : target;
}

/** Screen-reader decrement: below half a star is no rating at all. */
export function decrementRating(current: number | null): number | null {
  return current && current > 0.5 ? current - 0.5 : null;
}

/** Screen-reader increment: from no rating to half a star, capped at five. */
export function incrementRating(current: number | null): number {
  return Math.min(5, (current ?? 0) + 0.5);
}
