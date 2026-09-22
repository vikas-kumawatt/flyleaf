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
