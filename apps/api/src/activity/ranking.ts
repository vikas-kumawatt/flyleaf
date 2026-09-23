// Feed Ranking & Diversity engine (SO-12, PRD §12.2–12.4, Architecture §8).
//
// Key Rules:
//  1. Score formula: rank = activity_weight * recency_decay(age_hours) * affinity(viewer, actor) * diversity_penalty.
//  2. recency_decay(age_hours) = exp(-age_hours / 36.0).
//  3. Activity weights:
//     - reviewed: 1.0
//     - finished with rating: 0.9
//     - finished without rating: 0.7
//     - dnf: 0.5
//     - shelved: 0.3
//     - started: 0.2
//     - goal_reached: 0.6
//     - followed: 0.1
//     - quoted: 0.4
//  4. Hard Diversity Constraints (AC-11):
//     - Max 2 consecutive cards from the same actor.
//     - Max 3 cards about the same book (work_id) per 20-item page window.
//     - Max 1 "started" card per 10-item block.
//     - Min 1 low-affinity / rarely engaged actor card per 10-item block (if available in candidate set).

import type { ActivityVerb, FeedActivityItem } from './index.js';

export const ACTIVITY_WEIGHTS: Record<ActivityVerb, number> = {
  reviewed: 1.0,
  finished: 0.9,
  rated: 0.8,
  dnf: 0.5,
  shelved: 0.3,
  started: 0.2,
  goal_reached: 0.6,
  followed: 0.1,
  quoted: 0.4,
};

export function getActivityWeight(verb: ActivityVerb, metadata?: Record<string, any>): number {
  if (verb === 'finished') {
    return metadata?.rating != null ? 0.9 : 0.7;
  }
  const baseWeight = ACTIVITY_WEIGHTS[verb] ?? 0.5;
  if (metadata?.is_aggregated && metadata?.count > 1) {
    return Math.min(1.0, baseWeight + 0.05 * Math.min(metadata.count - 1, 4));
  }
  return baseWeight;
}

export function calculateRecencyDecay(createdAt: string | Date, now: Date = new Date()): number {
  const createdTime = new Date(createdAt).getTime();
  const nowTime = now.getTime();
  const ageHours = Math.max(0, (nowTime - createdTime) / (1000 * 60 * 60));
  return Math.exp(-ageHours / 36.0);
}

export function calculateDiversityPenalty(
  item: FeedActivityItem,
  selectedItemsSoFar: FeedActivityItem[],
): number {
  let penalty = 1.0;

  // Consecutive items by same actor
  let consecutiveActorCount = 0;
  for (let i = selectedItemsSoFar.length - 1; i >= 0; i--) {
    const prev = selectedItemsSoFar[i];
    if (prev && prev.actor_id === item.actor_id) {
      consecutiveActorCount++;
    } else {
      break;
    }
  }

  if (consecutiveActorCount === 2) {
    penalty *= 0.5;
  } else if (consecutiveActorCount >= 3) {
    penalty *= 0.25;
  }

  // Book frequency in recently selected items (last 20)
  if (item.work_id) {
    const recentWindow = selectedItemsSoFar.slice(-20);
    const workCount = recentWindow.filter((i) => i.work_id === item.work_id).length;
    if (workCount === 2) {
      penalty *= 0.7;
    } else if (workCount >= 3) {
      penalty *= 0.3;
    }
  }

  return penalty;
}

export interface RankingOptions {
  now?: Date;
  affinities?: Record<string, number>; // actorId -> affinity multiplier
  allowMultipleStarted?: boolean;
}

export function computeItemRankScore(
  item: FeedActivityItem,
  selectedItemsSoFar: FeedActivityItem[] = [],
  options: RankingOptions = {},
): number {
  const weight = getActivityWeight(item.verb, item.metadata);
  const decay = calculateRecencyDecay(item.created_at, options.now);
  const affinity = (options.affinities && options.affinities[item.actor_id]) ?? 1.0;
  const diversityPenalty = calculateDiversityPenalty(item, selectedItemsSoFar);

  return weight * decay * affinity * diversityPenalty;
}

export function violatesHardConstraints(
  candidate: FeedActivityItem,
  selectedItemsSoFar: FeedActivityItem[],
  options: RankingOptions = {},
): boolean {
  const len = selectedItemsSoFar.length;

  // Constraint 1: Max 2 consecutive cards from the same actor
  if (len >= 2) {
    const last = selectedItemsSoFar[len - 1];
    const prev = selectedItemsSoFar[len - 2];
    if (last && prev && last.actor_id === candidate.actor_id && prev.actor_id === candidate.actor_id) {
      return true;
    }
  }

  // Constraint 2: Max 3 cards about the same book (work_id) in any 20-item window
  if (candidate.work_id) {
    const recent20 = selectedItemsSoFar.slice(-20);
    const workCount = recent20.filter((i) => i.work_id === candidate.work_id).length;
    if (workCount >= 3) {
      return true;
    }
  }

  // Constraint 3: Max 1 "started" card per 10-item block (PRD §12.4), unless feed is thin/allowMultipleStarted is set
  if (candidate.verb === 'started' && !options.allowMultipleStarted) {
    const currentBlockStart = Math.floor(len / 10) * 10;
    const currentBlock = selectedItemsSoFar.slice(currentBlockStart);
    const startedCount = currentBlock.filter((i) => i.verb === 'started').length;
    if (startedCount >= 1) {
      return true;
    }
  }

  return false;
}

/**
 * SO-13: Feed Aggregation engine (PRD §12.2, AC-11).
 * Aggregates repetitive low-weight activities by the same actor (shelved, followed, started) into single summary cards.
 */
export function aggregateFeedItems(items: FeedActivityItem[]): FeedActivityItem[] {
  if (items.length <= 1) {
    return items;
  }

  const result: FeedActivityItem[] = [];

  const shelvedGroups = new Map<string, FeedActivityItem[]>();
  const followedGroups = new Map<string, FeedActivityItem[]>();
  const startedGroups = new Map<string, FeedActivityItem[]>();
  const nonAggregatedItems: FeedActivityItem[] = [];

  for (const item of items) {
    if (item.verb === 'shelved') {
      const shelfId =
        item.metadata?.shelfId ??
        item.metadata?.shelf_id ??
        item.metadata?.shelf_name ??
        item.metadata?.shelf_slug ??
        (item.object_type === 'shelf' ? item.object_id : 'default');
      const key = `${item.actor_id}:shelved:${shelfId}`;
      const group = shelvedGroups.get(key) ?? [];
      group.push(item);
      shelvedGroups.set(key, group);
    } else if (item.verb === 'followed') {
      const key = `${item.actor_id}:followed`;
      const group = followedGroups.get(key) ?? [];
      group.push(item);
      followedGroups.set(key, group);
    } else if (item.verb === 'started') {
      const day = item.created_at.slice(0, 10);
      const key = `${item.actor_id}:started:${day}`;
      const group = startedGroups.get(key) ?? [];
      group.push(item);
      startedGroups.set(key, group);
    } else {
      nonAggregatedItems.push(item);
    }
  }

  const buildAggregatedShelvedItem = (group: FeedActivityItem[]): FeedActivityItem => {
    if (group.length === 1) return group[0]!;
    group.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const primary = group[0]!;

    const worksMap = new Map<string, any>();
    for (const i of group) {
      if (i.work) {
        worksMap.set(i.work.id, i.work);
      }
    }

    const shelfName = primary.metadata?.shelf_name ?? primary.metadata?.name ?? null;

    return {
      ...primary,
      work_id: null,
      work: null,
      metadata: {
        ...primary.metadata,
        is_aggregated: true,
        count: group.length,
        shelf_name: shelfName,
        works: Array.from(worksMap.values()),
      },
    };
  };

  const buildAggregatedFollowedItem = (group: FeedActivityItem[]): FeedActivityItem => {
    if (group.length === 1) return group[0]!;
    group.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const primary = group[0]!;

    const targetsMap = new Map<string, any>();
    for (const i of group) {
      const targetId = i.object_id ?? i.metadata?.target_id;
      if (targetId) {
        targetsMap.set(targetId, {
          id: targetId,
          username: i.metadata?.target_username ?? i.metadata?.username ?? 'reader',
          display_name: i.metadata?.target_display_name ?? i.metadata?.display_name ?? null,
        });
      }
    }

    return {
      ...primary,
      metadata: {
        ...primary.metadata,
        is_aggregated: true,
        count: group.length,
        targets: Array.from(targetsMap.values()),
      },
    };
  };

  const buildAggregatedStartedItem = (group: FeedActivityItem[]): FeedActivityItem => {
    if (group.length === 1) return group[0]!;
    group.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const primary = group[0]!;

    const worksMap = new Map<string, any>();
    for (const i of group) {
      if (i.work) {
        worksMap.set(i.work.id, i.work);
      }
    }

    return {
      ...primary,
      metadata: {
        ...primary.metadata,
        is_aggregated: true,
        count: group.length,
        works: Array.from(worksMap.values()),
      },
    };
  };

  for (const group of shelvedGroups.values()) {
    result.push(buildAggregatedShelvedItem(group));
  }

  for (const group of followedGroups.values()) {
    result.push(buildAggregatedFollowedItem(group));
  }

  for (const group of startedGroups.values()) {
    result.push(buildAggregatedStartedItem(group));
  }

  result.push(...nonAggregatedItems);
  result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return result;
}

/**
 * Re-ranks candidates and applies hard diversity rules (PRD §12.3, §12.4, AC-11).
 */
export function rankAndDiversifyFeed(
  candidates: FeedActivityItem[],
  limit: number = 20,
  options: RankingOptions = {},
): FeedActivityItem[] {
  if (candidates.length === 0) {
    return [];
  }

  // SO-13: Aggregate shelf adds, follows, and started books prior to ranking
  const aggregatedCandidates = aggregateFeedItems(candidates);

  const hasOtherVerbs = aggregatedCandidates.some((c) => c.verb !== 'started');
  const effectiveOpts: RankingOptions = {
    ...options,
    allowMultipleStarted: options.allowMultipleStarted ?? !hasOtherVerbs,
  };

  const selected: FeedActivityItem[] = [];
  let remaining = [...aggregatedCandidates];

  while (selected.length < limit && remaining.length > 0) {
    // 1. Calculate current rank score for each remaining candidate relative to selected so far
    const scoredCandidates = remaining.map((item) => ({
      item,
      score: computeItemRankScore(item, selected, effectiveOpts),
    }));

    // Sort descending by score
    scoredCandidates.sort((a, b) => b.score - a.score);

    // 2. Check for low-affinity requirement: At least 1 low-affinity card per 10 items block if at slot 9 (9th in block)
    const currentBlockIndex = selected.length % 10;
    const currentBlockStart = Math.floor(selected.length / 10) * 10;
    const currentBlock = selected.slice(currentBlockStart);
    const hasLowAffinityInBlock = currentBlock.some((item) => {
      const aff = (effectiveOpts.affinities && effectiveOpts.affinities[item.actor_id]) ?? 1.0;
      return aff < 0.8;
    });

    let picked: FeedActivityItem | null = null;

    // If at 9th item of a 10-block and no low-affinity actor selected yet, try finding a low-affinity candidate
    if (currentBlockIndex === 9 && !hasLowAffinityInBlock && effectiveOpts.affinities) {
      const lowAffinityCandidate = scoredCandidates.find(({ item }) => {
        const aff = effectiveOpts.affinities![item.actor_id] ?? 1.0;
        return aff < 0.8 && !violatesHardConstraints(item, selected, effectiveOpts);
      });
      if (lowAffinityCandidate) {
        picked = lowAffinityCandidate.item;
      }
    }

    // Otherwise, pick highest scoring candidate that satisfies hard constraints
    if (!picked) {
      const validCandidate = scoredCandidates.find(({ item }) =>
        !violatesHardConstraints(item, selected, effectiveOpts),
      );
      if (validCandidate) {
        picked = validCandidate.item;
      }
    }

    // Secondary pass: If no candidate passed strict constraints, but remaining items are 'started' and we need items, allow started cards
    if (!picked && !effectiveOpts.allowMultipleStarted) {
      const relaxedOpts = { ...effectiveOpts, allowMultipleStarted: true };
      const relaxedCandidate = scoredCandidates.find(({ item }) =>
        !violatesHardConstraints(item, selected, relaxedOpts),
      );
      if (relaxedCandidate) {
        picked = relaxedCandidate.item;
      }
    }

    // Fallback: If no candidate satisfies hard constraints, pick top candidate ONLY if selected is empty (never empty feed, PRD §12.5)
    if (!picked && selected.length === 0 && scoredCandidates.length > 0) {
      picked = scoredCandidates[0]!.item;
    }

    if (picked) {
      selected.push(picked);
      remaining = remaining.filter((i) => i.id !== picked!.id);
    } else {
      break;
    }
  }

  return selected;
}
