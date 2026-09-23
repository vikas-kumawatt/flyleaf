// Feed card types, headline formatting, and swipe action definitions (SO-15, PRD §12.2, §46.2).

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

export interface FeedActor {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface FeedWork {
  id: string;
  title: string;
  author_name: string | null;
  cover_id: number | null;
}

export interface FeedActivityItem {
  id: string;
  actor_id: string;
  actor: FeedActor;
  verb: ActivityVerb;
  work_id: string | null;
  work: FeedWork | null;
  object_type: string | null;
  object_id: string | null;
  metadata?: Record<string, any>;
  visibility: 'public' | 'followers' | 'private';
  created_at: string;
}

export type FeedCardType =
  | 'review'
  | 'finish'
  | 'rated'
  | 'dnf'
  | 'shelved'
  | 'followed'
  | 'started'
  | 'goal_reached'
  | 'quoted'
  | 'editorial';

export interface SwipeActionConfig {
  type: 'want_to_read' | 'rate_and_review';
  label: string;
  icon: 'bookmark' | 'star';
  color: string;
  backgroundColor: string;
  workId: string | null;
}

/**
  * Resolves the visual card type for a given feed activity item.
  */
export function getCardType(item: FeedActivityItem): FeedCardType {
  if (item.metadata?.is_editorial) {
    return 'editorial';
  }

  const meta = item.metadata ?? {};
  const verb = item.verb;

  if (verb === 'reviewed' || (verb === 'finished' && (meta.review_text || meta.review_body))) {
    return 'review';
  }
  if (verb === 'finished') {
    return 'finish';
  }
  if (verb === 'rated') {
    return 'rated';
  }
  if (verb === 'dnf') {
    return 'dnf';
  }
  if (verb === 'shelved') {
    return 'shelved';
  }
  if (verb === 'followed') {
    return 'followed';
  }
  if (verb === 'started') {
    return 'started';
  }
  if (verb === 'goal_reached') {
    return 'goal_reached';
  }
  if (verb === 'quoted') {
    return 'quoted';
  }

  return 'finish';
}

/**
  * Formats human-readable activity headline text (including aggregated cards).
  */
export function formatActivityHeadline(item: FeedActivityItem): string {
  const meta = item.metadata ?? {};
  const cardType = getCardType(item);

  if (meta.is_editorial) {
    return 'Welcome to Flyleaf';
  }

  if (meta.is_aggregated) {
    const count = meta.count ?? 1;
    if (item.verb === 'followed') {
      return `followed ${count} ${count === 1 ? 'reader' : 'readers'}`;
    }
    if (item.verb === 'shelved') {
      const shelfName = meta.shelf_name ? ` "${meta.shelf_name}"` : '';
      return `added ${count} ${count === 1 ? 'book' : 'books'} to${shelfName}`;
    }
    if (item.verb === 'started') {
      return `started reading ${count} ${count === 1 ? 'book' : 'books'}`;
    }
  }

  switch (cardType) {
    case 'review':
      return meta.rating ? `reviewed (${meta.rating} ★)` : 'reviewed';
    case 'finish':
      return meta.rating ? `finished and rated ${meta.rating} ★` : 'finished';
    case 'rated':
      return `rated ${meta.rating ?? ''} ★`.trim();
    case 'dnf':
      return "DNF'd";
    case 'shelved':
      return meta.shelf_name ? `added to "${meta.shelf_name}"` : 'shelved a book';
    case 'followed':
      return 'followed a reader';
    case 'started':
      return 'started reading';
    case 'goal_reached':
      return `reached 2026 reading goal! 🎉`;
    case 'quoted':
      return 'saved a quote';
    default:
      return item.verb;
  }
}

/**
  * Resolves Swipe Right action configuration ("Want to read").
  */
export function getSwipeRightAction(item: FeedActivityItem): SwipeActionConfig | null {
  const workId = item.work_id || item.metadata?.work_id || null;
  if (!workId) return null;

  return {
    type: 'want_to_read',
    label: 'Want to read',
    icon: 'bookmark',
    color: '#FFFFFF',
    backgroundColor: '#10B981', // Success Emerald / Accent
    workId,
  };
}

/**
  * Resolves Swipe Left action configuration ("Rate & Review").
  */
export function getSwipeLeftAction(item: FeedActivityItem): SwipeActionConfig | null {
  const workId = item.work_id || item.metadata?.work_id || null;
  if (!workId) return null;

  return {
    type: 'rate_and_review',
    label: 'Rate & Review',
    icon: 'star',
    color: '#FFFFFF',
    backgroundColor: '#3B82F6', // Primary Blue
    workId,
  };
}

/**
  * Extracts card badge label (for cold start / blended activities).
  */
export function getCardBadgeLabel(item: FeedActivityItem): { text: string; variant: 'popular' | 'wait' | 'editorial' } | null {
  const meta = item.metadata ?? {};
  if (meta.is_editorial) {
    return { text: 'Welcome Card', variant: 'editorial' };
  }
  if (meta.is_blended_popular) {
    if (meta.label === 'While you wait') {
      return { text: 'While you wait', variant: 'wait' };
    }
    return { text: 'Popular on Flyleaf', variant: 'popular' };
  }
  return null;
}
