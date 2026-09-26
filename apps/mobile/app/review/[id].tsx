// Review Detail Screen (SL-64, PRD §6.26, §10.7).
//
// Governed by:
//   1. The review as a first-class piece of content.
//   2. Author header (avatar, username, date).
//   3. Book context strip (cover, title, author, tap to navigate).
//   4. Star rating and Heart affection.
//   5. Spoiler protection gate: hidden behind tap-to-reveal.
//   6. Like (idempotent POST/DELETE on the read, SO-21) and comments link (SO-22).
//   7. Share sheet.

import React, { useState, useEffect } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  Share,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Review } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useActionGate } from '@/ui/ActionGate';
import { useOfflineSync } from '@/offline/sync';
import { Button, Card, Cover, Screen, Stars, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function ReviewDetailScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { setLiked: setQueuedLike } = useOfflineSync();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [liking, setLiking] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function loadReview() {
      if (!id) return;
      try {
        const data = await api.client.getReview(id);
        if (mounted && data) {
          setReview(data);
          setLiked(data.viewer_has_liked);
          setLikeCount(data.like_count);
        }
      } catch (err: any) {
        if (mounted) {
          Alert.alert('Not found', 'This review could not be found or has been removed.', [
            { text: 'OK', onPress: () => router.back() },
          ]);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadReview();
    return () => {
      mounted = false;
    };
  }, [id]);

  const handleToggleLike = async () => {
    if (!review) return;
    if (!user) {
      promptAuth({
        title: 'Sign up to like reviews',
        subtitle: 'Join Flyleaf to like reviews and connect with readers.',
      });
      return;
    }
    if (liking) return;

    setLiking(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Optimistic update
    const nextLiked = !liked;
    const nextCount = nextLiked ? likeCount + 1 : Math.max(0, likeCount - 1);
    setLiked(nextLiked);
    setLikeCount(nextCount);

    try {
      // Queued (D-07-2): the optimistic state stands; a refusal shows on Couldn't sync.
      await setQueuedLike(review.read_id, nextLiked);
    } catch {
      // Revert on failure
      setLiked(!nextLiked);
      setLikeCount(likeCount);
    } finally {
      setLiking(false);
    }
  };

  const handleShare = async () => {
    if (!review) return;
    try {
      await Share.share({
        message: `Review of ${review.work_title ?? 'Book'} by ${review.author.username} on Flyleaf:\n\n"${review.body.slice(0, 200)}..."`,
      });
    } catch {
      // User cancelled
    }
  };

  const handleDelete = () => {
    if (!review) return;
    Alert.alert('Delete review?', 'Are you sure you want to delete your review?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.client.deleteReview(review.id);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            router.back();
          } catch (err: any) {
            Alert.alert('Error', err?.message || 'Could not delete review.');
          }
        },
      },
    ]);
  };

  if (loading || !review) {
    return (
      <Screen>
        <View style={[sheet.pad, { paddingTop: insets.top + space[6] }]}>
          <Txt color="muted">Loading review…</Txt>
        </View>
      </Screen>
    );
  }

  const isAuthor = user && user.id === review.user_id;
  const isSpoiled = review.has_spoilers && !spoilerRevealed;

  return (
    <Screen>
      {/* Header bar */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          backgroundColor: c.ground,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </Pressable>

        <Txt variant="body" style={{ fontWeight: '600' }}>
          Review
        </Txt>

        <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
          <Pressable
            onPress={handleShare}
            accessibilityRole="button"
            accessibilityLabel="Share review"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="share-outline" size={22} color={c.ink} />
          </Pressable>
          {isAuthor && (
            <Pressable
              onPress={handleDelete}
              accessibilityRole="button"
              accessibilityLabel="Delete review"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="trash-outline" size={20} color={c.critical} />
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          gap: space[4],
          paddingBottom: space[12],
        }}
      >
        {/* 1. Author Header Strip */}
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <View style={[sheet.row, { gap: space[3] }]}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: c.surface2,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: c.line,
              }}
            >
              <Txt variant="title" style={{ fontWeight: '600' }}>
                {review.author.username.charAt(0).toUpperCase()}
              </Txt>
            </View>
            <View style={{ gap: 2 }}>
              <Txt variant="body" style={{ fontWeight: '600' }}>
                {review.author.display_name || review.author.username}
              </Txt>
              <Txt variant="caption" color="muted">
                @{review.author.username} · {new Date(review.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                {review.edited_at ? ' (edited)' : ''}
              </Txt>
            </View>
          </View>
        </View>

        {/* 2. Book Context Strip (tap opens work detail) */}
        <Pressable
          onPress={() => router.push(`/work/${review.work_id}` as any)}
          accessibilityRole="button"
          accessibilityLabel={`Go to book ${review.work_title ?? ''}`}
        >
          <Card
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              backgroundColor: c.surface2,
            }}
          >
            <Cover
              coverId={review.work_cover_id}
              title={review.work_title ?? 'Book'}
              author={review.work_author ?? ''}
              size="s"
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="body" style={{ fontWeight: '600' }} numberOfLines={2}>
                {review.work_title ?? 'Book'}
              </Txt>
              {review.work_author ? (
                <Txt variant="caption" color="muted">
                  {review.work_author}
                </Txt>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={c.muted} />
          </Card>
        </Pressable>

        {/* 3. Rating & Affection Header */}
        <View style={[sheet.row, { justifyContent: 'space-between', paddingHorizontal: space[1] }]}>
          <View style={[sheet.row, { gap: space[2] }]}>
            <Stars value={review.rating ?? null} size={22} />
          </View>
          {review.hearted && (
            <View style={[sheet.row, { gap: space[1] }]}>
              <Txt variant="body" style={{ color: c.heart }}>
                ♥
              </Txt>
              <Txt variant="micro" color="muted">
                Loved
              </Txt>
            </View>
          )}
        </View>

        {/* 4. Review Body with Spoiler Gate (PRD §6.25, §6.26) */}
        <Card style={{ gap: space[3], minHeight: 120 }}>
          {isSpoiled ? (
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setSpoilerRevealed(true);
              }}
              style={{
                paddingVertical: space[6],
                alignItems: 'center',
                justifyContent: 'center',
                gap: space[2],
              }}
              accessibilityRole="button"
              accessibilityLabel="Reveal spoiler review content"
            >
              <Ionicons name="alert-circle-outline" size={32} color={c.accent} />
              <Txt variant="body" style={{ fontWeight: '600', textAlign: 'center' }}>
                This review contains spoilers
              </Txt>
              {review.spoiler_after_page ? (
                <Txt variant="caption" color="muted">
                  (Spoilers start after page {review.spoiler_after_page})
                </Txt>
              ) : null}
              <Txt variant="caption" color="accent" style={{ marginTop: space[1] }}>
                Tap to reveal review
              </Txt>
            </Pressable>
          ) : (
            <Txt
              variant="body"
              color="ink"
              style={{ fontSize: 17, lineHeight: 26, letterSpacing: -0.2 }}
            >
              {review.body}
            </Txt>
          )}
        </Card>

        {/* 5. Like Button & Social Footer */}
        <View style={[sheet.row, { justifyContent: 'space-between', marginTop: space[2] }]}>
          <Pressable
            onPress={handleToggleLike}
            accessibilityRole="button"
            accessibilityLabel={liked ? 'Unlike review' : 'Like review'}
            style={[
              sheet.row,
              {
                paddingHorizontal: space[4],
                paddingVertical: space[2],
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: liked ? c.heart : c.line,
                backgroundColor: liked ? c.surface2 : c.surface,
                gap: space[2],
              },
            ]}
          >
            <Txt variant="title" style={{ color: liked ? c.heart : c.lineStrong }}>
              {liked ? '♥' : '♡'}
            </Txt>
            <Txt variant="caption" style={{ fontWeight: '600', color: liked ? c.heart : c.ink }} tabular>
              {likeCount > 0 ? likeCount.toLocaleString() : 'Like'}
            </Txt>
          </Pressable>

          <Pressable
            onPress={() => router.push(`/read/${review.read_id}/comments` as any)}
            accessibilityRole="button"
            accessibilityLabel={`Comments, ${review.comment_count ?? 0}`}
            style={[
              sheet.row,
              {
                paddingHorizontal: space[4],
                paddingVertical: space[2],
                minHeight: 44,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: c.surface,
                gap: space[2],
              },
            ]}
          >
            <Ionicons name="chatbubble-outline" size={16} color={c.ink} />
            <Txt variant="caption" style={{ fontWeight: '600', color: c.ink }} tabular>
              {(review.comment_count ?? 0) > 0 ? (review.comment_count ?? 0).toLocaleString() : 'Comment'}
            </Txt>
          </Pressable>

          <Txt variant="micro" color="muted">
            Visibility: {review.visibility}
          </Txt>
        </View>
      </ScrollView>
    </Screen>
  );
}
