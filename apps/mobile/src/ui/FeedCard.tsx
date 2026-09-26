// FeedCard component supporting all activity card types and swipe actions (SO-15, PRD §12.2, §46.2).

import React, { useState } from 'react';
import { View, Pressable, StyleSheet, Animated as RNAnimated } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import {
  Card,
  Cover,
  Stars,
  Txt,
  sheet,
} from './components';
import { space, useTheme } from './tokens';
import {
  type FeedActivityItem,
  getCardType,
  formatActivityHeadline,
  getSwipeRightAction,
  getSwipeLeftAction,
  getCardBadgeLabel,
  getCardInteraction,
} from '../lib/feedCard';
import { nextLikeState } from '../lib/comments';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useActionGate } from './ActionGate';

export interface FeedCardProps {
  item: FeedActivityItem;
  onWantToRead?: (workId: string) => void;
  onRateAndReview?: (workId: string) => void;
  /** Called with the state the user wants; send POST (true) or DELETE (false). */
  onLike?: (readId: string, liked: boolean) => void;
  onComment?: (readId: string) => void;
  onPressActor?: (actorId: string) => void;
  onPressWork?: (workId: string) => void;
}

export function FeedCard({
  item,
  onWantToRead,
  onRateAndReview,
  onLike,
  onComment,
  onPressActor,
  onPressWork,
}: FeedCardProps) {
  const c = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const [showSpoilers, setShowSpoilers] = useState(false);
  const interaction = getCardInteraction(item);
  const [likeState, setLikeState] = useState({
    liked: interaction?.liked ?? false,
    count: interaction?.likeCount ?? 0,
  });
  const liked = likeState.liked;
  const likeCount = likeState.count;

  const cardType = getCardType(item);
  const headline = formatActivityHeadline(item);
  const badge = getCardBadgeLabel(item);
  const rightActionConfig = getSwipeRightAction(item); // Swipe left -> reveals Rate & Review on right
  const leftActionConfig = getSwipeLeftAction(item);  // Swipe right -> reveals Want to read on left

  const workId = item.work_id || item.metadata?.work_id;
  // Likes and comments target the READ (SO-21), never the activity row.
  const readId = interaction?.readId ?? null;
  const meta = item.metadata ?? {};

  const handleLikePress = () => {
    if (!readId) return;
    if (!user) {
      promptAuth({ title: 'Sign up to like this', subtitle: 'Like reads and reviews from readers you follow.' });
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = nextLikeState(likeState);
    setLikeState(next);
    // The desired state goes out — POST or DELETE, never a flip.
    if (onLike) {
      onLike(readId, next.liked);
      return;
    }
    const previous = likeState;
    api.client
      .setLiked(readId, next.liked)
      .then((res) => setLikeState({ liked: res.liked, count: res.like_count }))
      .catch(() => setLikeState(previous));
  };

  const handleCommentPress = () => {
    if (!readId) return;
    if (onComment) onComment(readId);
    else router.push(`/read/${readId}/comments` as any);
  };

  const handleWantToRead = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (workId) {
      if (onWantToRead) {
        onWantToRead(workId);
      } else {
        router.push(`/work/${workId}`);
      }
    }
  };

  const handleRateAndReview = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (workId) {
      if (onRateAndReview) {
        onRateAndReview(workId);
      } else {
        router.push({ pathname: '/log', params: { workId } });
      }
    }
  };

  // Render Swipe Left Action (revealed on Right side) -> Rate & Review
  const renderRightActions = (
    _progress: RNAnimated.AnimatedInterpolation<number>,
    dragX: RNAnimated.AnimatedInterpolation<number>
  ) => {
    if (!rightActionConfig) return null;
    const trans = dragX.interpolate({
      inputRange: [-100, 0],
      outputRange: [0, 100],
      extrapolate: 'clamp',
    });

    return (
      <Pressable
        onPress={handleRateAndReview}
        style={{
          width: 90,
          backgroundColor: '#3B82F6', // Primary Blue
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: 16,
          marginVertical: space[1],
        }}
        accessibilityRole="button"
        accessibilityLabel="Rate and Review book"
      >
        <RNAnimated.View style={{ transform: [{ translateX: trans }], alignItems: 'center', gap: space[1] }}>
          <Ionicons name="star" size={24} color="#FFFFFF" />
          <Txt variant="caption" color="ground" style={{ fontWeight: '700' }}>
            Rate & Review
          </Txt>
        </RNAnimated.View>
      </Pressable>
    );
  };

  // Render Swipe Right Action (revealed on Left side) -> Want to Read
  const renderLeftActions = (
    _progress: RNAnimated.AnimatedInterpolation<number>,
    dragX: RNAnimated.AnimatedInterpolation<number>
  ) => {
    if (!leftActionConfig) return null;
    const trans = dragX.interpolate({
      inputRange: [0, 100],
      outputRange: [-100, 0],
      extrapolate: 'clamp',
    });

    return (
      <Pressable
        onPress={handleWantToRead}
        style={{
          width: 90,
          backgroundColor: '#10B981', // Emerald / Accent Green
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: 16,
          marginVertical: space[1],
        }}
        accessibilityRole="button"
        accessibilityLabel="Save book to Want to Read"
      >
        <RNAnimated.View style={{ transform: [{ translateX: trans }], alignItems: 'center', gap: space[1] }}>
          <Ionicons name="bookmark" size={24} color="#FFFFFF" />
          <Txt variant="caption" color="ground" style={{ fontWeight: '700' }}>
            Want to Read
          </Txt>
        </RNAnimated.View>
      </Pressable>
    );
  };

  return (
    <Swipeable
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      friction={2}
      leftThreshold={40}
      rightThreshold={40}
    >
      <Card
        onPress={() => {
          if (workId) {
            if (onPressWork) onPressWork(workId);
            else router.push(`/work/${workId}`);
          }
        }}
      >
        {/* Cold Start / Blended Badge Banner */}
        {badge && (
          <View
            style={{
              alignSelf: 'flex-start',
              backgroundColor: badge.variant === 'popular' ? c.accentSoft : c.surface2,
              paddingHorizontal: space[2],
              paddingVertical: 2,
              borderRadius: 6,
              marginBottom: space[2],
            }}
          >
            <Txt
              variant="caption"
              color={badge.variant === 'popular' ? 'accent' : 'ink2'}
              style={{ fontWeight: '600' }}
            >
              {badge.text}
            </Txt>
          </View>
        )}

        {/* Card Header: Actor Avatar, Handle, Action Headline */}
        <View style={[sheet.row, { justifyContent: 'space-between', marginBottom: space[2] }]}>
          <Pressable
            onPress={() => {
              if (item.actor_id && onPressActor) onPressActor(item.actor_id);
              else if (item.actor_id) router.push(`/user/${item.actor_id}`);
            }}
            style={sheet.row}
            accessibilityRole="button"
            accessibilityLabel={`User ${item.actor.username}`}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: c.surface2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Txt variant="caption" color="ink" style={{ fontWeight: '700' }}>
                {(item.actor.display_name || item.actor.username).substring(0, 1).toUpperCase()}
              </Txt>
            </View>
            <View>
              <Txt variant="body" color="ink" style={{ fontWeight: '600' }}>
                {item.actor.display_name || item.actor.username}
              </Txt>
              <Txt variant="caption" color="muted">
                {headline}
              </Txt>
            </View>
          </Pressable>

          {meta.rating ? <Stars value={meta.rating} size={16} /> : null}
        </View>

        {/* Work Preview Section (for Book-related Cards) */}
        {item.work && (
          <View style={[sheet.rowTop, { marginBottom: space[2] }]}>
            <Cover
              coverId={item.work.cover_id}
              title={item.work.title}
              author={item.work.author_name || undefined}
              size="s"
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="title" numberOfLines={2}>
                {item.work.title}
              </Txt>
              {item.work.author_name && (
                <Txt variant="caption" color="muted" numberOfLines={1}>
                  {item.work.author_name}
                </Txt>
              )}
              {meta.read_count && meta.read_count > 1 ? (
                <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                  Re-read #{meta.read_count}
                </Txt>
              ) : null}
            </View>
          </View>
        )}

        {/* Aggregated Collection Previews (Shelved / Followed / Started) */}
        {meta.is_aggregated && Array.isArray(meta.works) && (
          <View style={{ flexDirection: 'row', gap: space[2], marginVertical: space[2] }}>
            {meta.works.slice(0, 4).map((w: any, idx: number) => (
              <View key={w.id || idx} style={{ width: 48, alignItems: 'center' }}>
                <Cover coverId={w.cover_id} title={w.title} size="s" />
              </View>
            ))}
          </View>
        )}

        {/* Review / Quote Text Content */}
        {(meta.review_text || meta.review_body || meta.text || meta.description) && (
          <View style={{ marginVertical: space[2] }}>
            {meta.has_spoilers && !showSpoilers ? (
              <Pressable
                onPress={() => setShowSpoilers(true)}
                style={{
                  backgroundColor: c.surface2,
                  padding: space[3],
                  borderRadius: 8,
                  alignItems: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Show spoilers"
              >
                <Ionicons name="eye-off-outline" size={20} color={c.ink2} />
                <Txt variant="caption" color="ink2" style={{ marginTop: 4, fontWeight: '600' }}>
                  Contains spoilers (Tap to reveal)
                </Txt>
              </Pressable>
            ) : (
              <Txt variant="bodyL" color="ink" numberOfLines={cardType === 'review' ? 6 : 3}>
                {meta.review_text || meta.review_body || meta.text || meta.description}
              </Txt>
            )}
          </View>
        )}

        {/* Card Footer Action Bar (Like, Comment, Quick Actions for accessibility) */}
        {!meta.is_editorial && (
          <View
            style={[
              sheet.row,
              {
                justifyContent: 'space-between',
                borderTopWidth: 1,
                borderTopColor: c.line,
                paddingTop: space[2],
                marginTop: space[2],
              },
            ]}
          >
            <View style={sheet.row}>
              {/* Like & comment exist only on social objects: a finished or DNF read,
                  with or without a review (PRD §10.3). Never on "started" or shelf cards. */}
              {interaction && (
              <>
              {/* Like Button */}
              <Pressable
                onPress={handleLikePress}
                style={[sheet.row, styles.actionButton]}
                accessibilityRole="button"
                accessibilityLabel={liked ? 'Unlike post' : 'Like post'}
                hitSlop={8}
              >
                <Ionicons
                  name={liked ? 'heart' : 'heart-outline'}
                  size={20}
                  color={liked ? '#EF4444' : c.muted}
                />
                <Txt variant="caption" color={liked ? 'ink' : 'muted'} style={{ fontWeight: '600' }}>
                  {likeCount}
                </Txt>
              </Pressable>

              {/* Comment Button */}
              <Pressable
                onPress={handleCommentPress}
                style={[sheet.row, styles.actionButton]}
                accessibilityRole="button"
                accessibilityLabel="Comment on post"
                hitSlop={8}
              >
                <Ionicons name="chatbubble-outline" size={19} color={c.muted} />
                <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                  {interaction.commentCount}
                </Txt>
              </Pressable>
              </>
              )}
            </View>

            {/* Quick Action Shortcuts (Non-Gesture Callers & Screen Readers) */}
            {workId && (
              <View style={sheet.row}>
                <Pressable
                  onPress={handleWantToRead}
                  style={styles.actionButton}
                  accessibilityRole="button"
                  accessibilityLabel="Save to Want to Read"
                  hitSlop={8}
                >
                  <Ionicons name="bookmark-outline" size={20} color={c.accent} />
                </Pressable>
                <Pressable
                  onPress={handleRateAndReview}
                  style={styles.actionButton}
                  accessibilityRole="button"
                  accessibilityLabel="Rate and Review"
                  hitSlop={8}
                >
                  <Ionicons name="star-outline" size={20} color={c.ink2} />
                </Pressable>
              </View>
            )}
          </View>
        )}
      </Card>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    paddingHorizontal: space[2],
    paddingVertical: space[1],
    borderRadius: 8,
  },
});
