// SO-51 / SO-52 (app side): the public links the server renders (PRD §16.5)
// and the onboarding follow suggestions' copy (PRD §6.11).

import type { FollowSuggestion, FollowSuggestionReason } from '@flyleaf/api-client';

export const PUBLIC_BASE_URL = 'https://flyleaf.app';

/** flyleaf.app/@username: the profile page anyone without the app can open (SO-51). */
export function profileShareUrl(username: string, baseUrl = PUBLIC_BASE_URL): string {
  return `${baseUrl}/@${encodeURIComponent(username)}`;
}

/** flyleaf.app/book/<id>: the book page (SO-50). */
export function bookShareUrl(workId: string, baseUrl = PUBLIC_BASE_URL): string {
  return `${baseUrl}/book/${encodeURIComponent(workId)}`;
}

/** Why this reader is suggested, in a few words (the server's ranking reason). */
export function suggestionReason(reason: FollowSuggestionReason): string {
  switch (reason) {
    case 'favourites':
      return 'Shares a favourite of yours';
    case 'genres':
      return 'Reads the genres you read';
    case 'reviewer':
      return 'Writes reviews often';
    case 'popular':
      return 'Popular on Flyleaf';
  }
}

/** "Follow all" follows only the readers not followed yet, in the list's order. */
export function toFollowAll(users: Pick<FollowSuggestion, 'id'>[], followed: ReadonlySet<string>): string[] {
  return users.map((u) => u.id).filter((id) => !followed.has(id));
}
