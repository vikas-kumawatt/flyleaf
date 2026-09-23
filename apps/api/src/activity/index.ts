// Activity service: write-on-action activity logging & visibility (SO-10).
//
// Key rules:
//  1. Write on action: every social activity (start, finish, rate, review, dnf, shelf, follow, goal_reached, quote)
//     emits an activity row atomically or within the same service call.
//  2. Exclude imports (IM-07, PRD §4410): reads/reviews with source = 'import' NEVER generate activity rows.
//  3. Respect per-item visibility: items with visibility = 'private' generate NO activity row at all (PRD §26.2).
//  4. Respect private accounts: if user account is private (isPrivate = true), activity visibility is forced to 'followers' (PRD §16.3).
//  5. Support retroactive account privacy updates: when user toggles isPrivate from false to true, existing public activity rows
//     for that actor are restricted to 'followers' (PRD §16.3, §26.1).

import { eq, and, sql, desc } from 'drizzle-orm';
import { activity, profiles, type Activity } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import type { Visibility } from '../authorization/index.js';

export type ActivityVerb =
  | 'started'
  | 'finished'
  | 'rated'
  | 'reviewed'
  | 'dnf'
  | 'shelved'
  | 'followed'
  | 'goal_reached'
  | 'quoted';

export interface RecordActivityParams {
  actorId: string;
  verb: ActivityVerb;
  workId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  metadata?: Record<string, any>;
  visibility?: Visibility | string | null;
  source?: string | null;
}

export class ActivityService {
  constructor(private db: Db) {}

  /**
   * Records an activity row respecting source exclusion, item privacy, and account privacy.
   */
  async recordActivity(
    dbOrTx: Db,
    params: RecordActivityParams,
  ): Promise<Activity | null> {
    // 1. Exclude imports (IM-07, PRD §4410)
    if (params.source === 'import') {
      return null;
    }

    const itemVis: Visibility = (params.visibility as Visibility) ?? 'public';

    // 2. Private items generate NO activity row at all (PRD §26.2)
    if (itemVis === 'private') {
      return null;
    }

    // Check actor profile privacy
    const [actorProfile] = await dbOrTx
      .select({ isPrivate: profiles.isPrivate })
      .from(profiles)
      .where(eq(profiles.userId, params.actorId))
      .limit(1);

    const isActorPrivate = actorProfile?.isPrivate ?? false;

    // 3. Effective visibility: if account is private, force to 'followers'
    const effectiveVisibility: Visibility = isActorPrivate ? 'followers' : itemVis;

    const [row] = await dbOrTx
      .insert(activity)
      .values({
        actorId: params.actorId,
        verb: params.verb,
        workId: params.workId ?? null,
        objectType: params.objectType ?? null,
        objectId: params.objectId ?? null,
        metadata: params.metadata ?? {},
        visibility: effectiveVisibility,
      })
      .returning();

    return row ?? null;
  }

  /**
   * Updates activity visibility when underlying item visibility changes.
   */
  async updateActivityVisibility(
    dbOrTx: Db,
    objectType: string,
    objectId: string,
    newVisibility: Visibility,
  ): Promise<void> {
    if (newVisibility === 'private') {
      // If changed to private, delete or hide the activity row
      await dbOrTx
        .delete(activity)
        .where(and(eq(activity.objectType, objectType), eq(activity.objectId, objectId)));
    } else {
      await dbOrTx
        .update(activity)
        .set({ visibility: newVisibility })
        .where(and(eq(activity.objectType, objectType), eq(activity.objectId, objectId)));
    }
  }

  /**
   * Deletes activity row associated with a deleted item.
   */
  async deleteActivity(
    dbOrTx: Db,
    objectType: string,
    objectId: string,
  ): Promise<void> {
    await dbOrTx
      .delete(activity)
      .where(and(eq(activity.objectType, objectType), eq(activity.objectId, objectId)));
  }

  /**
   * Deletes follow activity row for a specific actor and followee.
   */
  async deleteFollowActivity(
    dbOrTx: Db,
    actorId: string,
    followeeId: string,
  ): Promise<void> {
    await dbOrTx
      .delete(activity)
      .where(
        and(
          eq(activity.actorId, actorId),
          eq(activity.verb, 'followed'),
          eq(activity.objectType, 'user'),
          eq(activity.objectId, followeeId),
        ),
      );
  }

  /**
   * Retroactively adjusts public activities for an actor when account privacy changes (PRD §16.3, §26.1).
   */
  async setAccountPrivacy(
    dbOrTx: Db,
    actorId: string,
    isPrivate: boolean,
  ): Promise<void> {
    if (isPrivate) {
      // Switching to private: restrict all public activities to 'followers'
      await dbOrTx
        .update(activity)
        .set({ visibility: 'followers' })
        .where(and(eq(activity.actorId, actorId), eq(activity.visibility, 'public')));
    }
  }
}
