// Authorization: centralized visibility and access resolution (FN-70, FN-71, Architecture §4).
//
// There is no row-level security doing this for us. Authorization lives in
// exactly one place: canView().
//
// Rules enforced here:
//   1. Block is bidirectional and complete: blocked users see nothing (PRD §26.3).
//   2. Owner always sees own data (Architecture §4).
//   3. Private items are visible ONLY to the owner.
//   4. Private accounts require the viewer to be an accepted follower.
//   5. Followers-only items require the viewer to be an accepted follower.
//   6. Public items on public accounts are visible to all (including guests where viewer === null).
//   7. If access is denied to another user's resource, return 404 NOT FOUND, never 403 (PRD §25.3).

import { ApiError } from '../http.js';

export const VISIBILITIES = ['public', 'followers', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface CanViewParams {
  viewer: string | null;
  ownerId: string;
  visibility?: Visibility | string | null;
  isOwnerPrivate?: boolean;
  isBlocked?: boolean;
  isFollower?: boolean;
}

/**
 * Single visibility resolver covering public / followers / private / blocked / guest.
 *
 * Supports both options object and positional arguments:
 *   canView(viewer, ownerId, visibility, isPrivate, blocked, isFollower)
 *   canView({ viewer, ownerId, visibility, isOwnerPrivate, isBlocked, isFollower })
 */
export function canView(params: CanViewParams): boolean;
export function canView(
  viewer: string | null,
  ownerId: string,
  visibility?: Visibility | string | null,
  isOwnerPrivate?: boolean,
  isBlocked?: boolean,
  isFollower?: boolean,
): boolean;
export function canView(
  viewerOrParams: string | null | CanViewParams,
  ownerIdArg?: string,
  visibilityArg?: Visibility | string | null,
  isOwnerPrivateArg?: boolean,
  isBlockedArg?: boolean,
  isFollowerArg?: boolean,
): boolean {
  let viewer: string | null;
  let ownerId: string;
  let visibility: string;
  let isOwnerPrivate: boolean;
  let isBlocked: boolean;
  let isFollower: boolean;

  if (typeof viewerOrParams === 'object' && viewerOrParams !== null && 'ownerId' in viewerOrParams) {
    viewer = viewerOrParams.viewer;
    ownerId = viewerOrParams.ownerId;
    visibility = viewerOrParams.visibility ?? 'public';
    isOwnerPrivate = viewerOrParams.isOwnerPrivate ?? false;
    isBlocked = viewerOrParams.isBlocked ?? false;
    isFollower = viewerOrParams.isFollower ?? false;
  } else {
    viewer = viewerOrParams as string | null;
    ownerId = ownerIdArg!;
    visibility = visibilityArg ?? 'public';
    isOwnerPrivate = isOwnerPrivateArg ?? false;
    isBlocked = isBlockedArg ?? false;
    isFollower = isFollowerArg ?? false;
  }

  // 1. Block: complete, bidirectional invisibility (PRD §26.3, Architecture §4).
  // If either party blocked the other, neither can view the other's profile or content.
  if (isBlocked) return false;

  // 2. Owner: can always view their own resources (Architecture §4).
  if (viewer !== null && viewer === ownerId) return true;

  // 3. Private item: visible only to the owner (Architecture §4, PRD §26.2).
  if (visibility === 'private') return false;

  // 4. Private account: only approved followers can view anything (PRD §26.1).
  // Guests (viewer === null) and non-followers receive false.
  if (isOwnerPrivate) {
    return Boolean(viewer !== null && isFollower);
  }

  // 5. Followers-only item: visible only to approved followers.
  if (visibility === 'followers') {
    return Boolean(viewer !== null && isFollower);
  }

  // 6. Public item on a public account: visible to all, including guests.
  return true;
}

/**
 * Asserts that the viewer can view the resource.
 * Throws 404 Not Found (never 403) on failure to avoid confirming existence.
 */
export function assertCanView(params: CanViewParams, message = 'Not found.'): void {
  if (!canView(params)) {
    throw ApiError.notFound(message);
  }
}
