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

import { sql, type SQL } from 'drizzle-orm';
import { ApiError } from '../http.js';
import type { Db } from '../platform/index.js';

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

// ---------------------------------------------------------------------------
// Relationship: everything canView() needs about (viewer, owner), in ONE query
// (Audit 05). Services used to run profile, block and follow lookups one after
// another, and each kept its own copy of them.
// ---------------------------------------------------------------------------

export interface Relationship {
  /** False when the owner does not exist or is soft-deleted (PRD §25.4: hidden platform-wide). */
  ownerExists: boolean;
  isOwnerPrivate: boolean;
  isBlocked: boolean;
  /** Viewer → owner. Only 'accepted' counts as following, anywhere. */
  followStatus: 'none' | 'pending' | 'accepted' | 'self';
  /** Owner → viewer, accepted. */
  followedBy: boolean;
}

export async function loadRelationship(db: Db, viewer: string | null, ownerId: string): Promise<Relationship> {
  const [row] = await db.execute<{
    is_private: boolean;
    blocked: boolean;
    follow_state: string | null;
    followed_by: boolean;
  }>(sql`
    SELECT p.is_private,
      ${viewer === null ? sql`false` : sql`EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_id = ${viewer}::uuid AND b.blocked_id = u.id)
           OR (b.blocker_id = u.id AND b.blocked_id = ${viewer}::uuid)
      )`} AS blocked,
      ${viewer === null ? sql`NULL::text` : sql`(
        SELECT f.state FROM follows f WHERE f.follower_id = ${viewer}::uuid AND f.followee_id = u.id
      )`} AS follow_state,
      ${viewer === null ? sql`false` : sql`EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_id = u.id AND f.followee_id = ${viewer}::uuid AND f.state = 'accepted'
      )`} AS followed_by
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    WHERE u.id = ${ownerId}::uuid AND u.deleted_at IS NULL
  `);

  if (!row) {
    return { ownerExists: false, isOwnerPrivate: false, isBlocked: false, followStatus: 'none', followedBy: false };
  }
  const self = viewer !== null && viewer === ownerId;
  return {
    ownerExists: true,
    isOwnerPrivate: Boolean(row.is_private),
    isBlocked: !self && Boolean(row.blocked),
    followStatus: self
      ? 'self'
      : row.follow_state === 'accepted'
        ? 'accepted'
        : row.follow_state === 'pending'
          ? 'pending'
          : 'none',
    followedBy: !self && Boolean(row.followed_by),
  };
}

/** canView() for one item, from a loaded relationship. A missing or deleted owner is never visible. */
export function canViewWith(
  viewer: string | null,
  ownerId: string,
  rel: Relationship,
  visibility: Visibility | string | null = 'public',
): boolean {
  if (!rel.ownerExists) return false;
  return canView({
    viewer,
    ownerId,
    visibility,
    isOwnerPrivate: rel.isOwnerPrivate,
    isBlocked: rel.isBlocked,
    isFollower: rel.followStatus === 'accepted',
  });
}

/**
 * The item visibilities this viewer may see of this owner's content, for a
 * list query over ONE owner: `WHERE visibility = ANY(...)`. Derived from
 * canView() itself, so the list can never disagree with the single-item path.
 */
export function visibleLevels(viewer: string | null, ownerId: string, rel: Relationship): Visibility[] {
  return VISIBILITIES.filter((v) => canViewWith(viewer, ownerId, rel, v));
}

/**
 * canView() as a SQL predicate, for list queries spanning many owners.
 *
 * The caller passes column expressions for the item owner, the item
 * visibility and the owner's profile privacy. Equivalence with canView() is
 * proven by authorization-equivalence.test.ts over the full viewer matrix;
 * change both or neither.
 */
export function canViewSql(
  viewer: string | null,
  cols: { ownerId: SQL | unknown; visibility: SQL | unknown; ownerIsPrivate: SQL | unknown },
): SQL {
  const { ownerId, visibility, ownerIsPrivate } = cols;
  const ownerAlive = sql`EXISTS (SELECT 1 FROM users du WHERE du.id = ${ownerId} AND du.deleted_at IS NULL)`;
  if (viewer === null) {
    return sql`(${ownerAlive} AND ${visibility} = 'public' AND NOT ${ownerIsPrivate})`;
  }
  return sql`(${ownerAlive} AND (
    ${ownerId} = ${viewer}::uuid
    OR (
      NOT EXISTS (
        SELECT 1 FROM blocks cb
        WHERE (cb.blocker_id = ${viewer}::uuid AND cb.blocked_id = ${ownerId})
           OR (cb.blocker_id = ${ownerId} AND cb.blocked_id = ${viewer}::uuid)
      )
      AND ${visibility} <> 'private'
      AND (
        (${visibility} = 'public' AND NOT ${ownerIsPrivate})
        OR EXISTS (
          SELECT 1 FROM follows cf
          WHERE cf.follower_id = ${viewer}::uuid AND cf.followee_id = ${ownerId} AND cf.state = 'accepted'
        )
      )
    )
  ))`;
}

// ---------------------------------------------------------------------------
// Capabilities (D-04-1, PRD §25.3 roles, §6.6, §42 #4)
// ---------------------------------------------------------------------------

/**
 * Unverified accounts can read, log reads and shelve, but cannot create
 * reviews, comments or follows. 403 (not 404): the refusal is about the
 * caller's own account and reveals nothing about anyone else. The client turns
 * `email_unverified` into a "verify your email" prompt.
 */
export async function requireVerified(db: Db, viewer: string): Promise<void> {
  const [row] = await db.execute<{ verified: boolean }>(sql`
    SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE id = ${viewer}::uuid
  `);
  if (!row?.verified) {
    throw ApiError.forbidden('email_unverified', 'Verify your email address to do that.');
  }
}

const RESTRICTIVENESS: Record<string, number> = { public: 0, followers: 1, private: 2 };

/**
 * The stricter of several visibilities. A review sits on a read and each has
 * its own visibility (PRD §26.2); what is shown is the stricter of the two.
 * canView() is monotone in strictness, so canView(strictest) equals the AND
 * of canView() over each. Unknown values count as private.
 */
export function mostRestrictive(...levels: (string | null | undefined)[]): Visibility {
  let best = 0;
  for (const l of levels) best = Math.max(best, RESTRICTIVENESS[l ?? 'public'] ?? 2);
  return VISIBILITIES[best]!;
}

/** mostRestrictive() in SQL, for two visibility columns. */
export function mostRestrictiveSql(a: SQL | unknown, b: SQL | unknown): SQL {
  return sql`(CASE
    WHEN ${a} = 'private' OR ${b} = 'private' THEN 'private'
    WHEN ${a} = 'followers' OR ${b} = 'followers' THEN 'followers'
    ELSE 'public' END)`;
}
