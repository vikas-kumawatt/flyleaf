// Social & Follow UI Helpers (SO-01, SO-02).

export type FollowStatus = 'none' | 'pending' | 'accepted' | 'self';

export interface ProfileFollowState {
  isPrivate: boolean;
  isRestricted?: boolean;
  followStatus?: FollowStatus;
}

export function getFollowButtonText(followStatus: FollowStatus): string {
  switch (followStatus) {
    case 'accepted':
      return 'Following';
    case 'pending':
      return 'Requested';
    case 'none':
      return 'Follow';
    case 'self':
      return '';
    default:
      return 'Follow';
  }
}

export function getFollowButtonVariant(followStatus: FollowStatus): 'primary' | 'outline' {
  return followStatus === 'none' ? 'primary' : 'outline';
}

export function isProfileViewRestricted(profile: ProfileFollowState): boolean {
  if (profile.isRestricted !== undefined) {
    return profile.isRestricted;
  }
  return (
    profile.isPrivate &&
    profile.followStatus !== 'accepted' &&
    profile.followStatus !== 'self'
  );
}

export function formatFollowCount(count: number): string {
  if (count < 0) return '0';
  if (count >= 1_000_000) {
    const formatted = (count / 1_000_000).toFixed(1);
    return formatted.endsWith('.0') ? `${Math.floor(count / 1_000_000)}M` : `${formatted}M`;
  }
  if (count >= 1_000) {
    const formatted = (count / 1_000).toFixed(1);
    return formatted.endsWith('.0') ? `${Math.floor(count / 1_000)}k` : `${formatted}k`;
  }
  return String(count);
}

/** Followers / following page size: the API's default (SO-05). */
export const FOLLOW_PAGE_SIZE = 50;

/**
 * The next page appended to the rows already shown (audit 13, A-13-013: the
 * screens showed the first 50 and no more). The list is offset-paged, so a
 * follow made between two pages shifts the next page by one; a row seen
 * already is not shown twice.
 */
export function appendFollowPage<T extends { id: string }>(shown: T[], page: T[]): T[] {
  const seen = new Set(shown.map((u) => u.id));
  return [...shown, ...page.filter((u) => !seen.has(u.id))];
}

/** More to load: fewer shown than the total, and the last page was not empty. */
export function hasMoreFollows(shown: number, total: number, lastPageSize: number): boolean {
  return lastPageSize > 0 && shown < total;
}
