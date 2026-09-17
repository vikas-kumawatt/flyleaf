// Book Detail Screen (PRD §6.24, design.md §10, SL-41).
//
// Features:
// - Hero: cover, title, tappable author, series indicator, publication year
// - Status control: Want to read / Reading / Finished / Stopped (with guest mode & Action Gate)
// - Rating & 5-bar distribution histogram
// - Expandable description
// - Edition metadata strip
// - Tabs: Reviews / Editions / Reading History

import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  TextInput,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Work, type Review } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Heart,
  ProgressBar,
  Screen,
  SegmentedControl,
  Stars,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

const STATUSES: { key: string; label: string }[] = [
  { key: 'want', label: 'Want to read' },
  { key: 'reading', label: 'Reading' },
  { key: 'finished', label: 'Finished' },
  { key: 'dnf', label: 'Stopped' },
];

const formatLabel = (f?: string | null) =>
  f ? f.charAt(0).toUpperCase() + f.slice(1) : null;

export default function WorkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { isSaved, addBook, removeBook } = useGuestShelf();
  const router = useRouter();
  const c = useTheme();

  const [work, setWork] = useState<Work | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const [descExpanded, setDescExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'reviews' | 'editions' | 'history'>('reviews');

  // Reviews state (SL-64)
  const [reviewsList, setReviewsList] = useState<Review[]>([]);
  const [reviewsTotal, setReviewsTotal] = useState(0);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewSort, setReviewSort] = useState<'friends' | 'likes' | 'newest' | 'highest' | 'lowest'>('friends');
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  const [revealedSpoilers, setRevealedSpoilers] = useState<Set<string>>(new Set());

  const loadReviews = async () => {
    if (!id) return;
    setReviewsLoading(true);
    try {
      const res = await api.client.getWorkReviews(id, {
        sort: reviewSort,
        rating: ratingFilter ?? undefined,
      });
      setReviewsList(res.data);
      setReviewsTotal(res.total);
    } catch {
      // Ignore
    } finally {
      setReviewsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'reviews' && id) {
      loadReviews().catch(() => {});
    }
  }, [id, activeTab, reviewSort, ratingFilter]);

  const toggleReviewLike = async (review: Review) => {
    if (!user) {
      promptAuth({
        title: 'Sign up to like reviews',
        subtitle: 'Join Flyleaf to like reviews and follow readers.',
      });
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const res = await api.client.toggleLike(review.read_id);
      setReviewsList((prev) =>
        prev.map((r) =>
          r.id === review.id
            ? { ...r, viewer_has_liked: res.liked, like_count: res.like_count }
            : r,
        ),
      );
    } catch {
      // Ignore
    }
  };

  const load = async () => {
    if (id) {
      setWork(await api.work(id));
    }
  };

  useEffect(() => {
    load().catch(() => {});
  }, [id, user?.id]);

  if (!work) {
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt color="muted">Loading book…</Txt>
        </View>
      </Screen>
    );
  }

  const edition = work.editions?.[0];
  const total = edition?.page_count ?? null;
  const page = work.your_read?.page ?? null;
  const percent =
    total && page
      ? Math.round((page / total) * 100)
      : work.your_read?.percent ?? null;
  const savedInGuestShelf = !user && isSaved(work.id);

  // Status control handler (SL-31, SL-32, SL-41)
  const setStatus = async (status: string) => {
    if (!user) {
      if (status === 'want') {
        if (savedInGuestShelf) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await removeBook(work.id);
        } else {
          const res = await addBook({
            id: work.id,
            title: work.title,
            author_name: work.author_name,
            cover_id: work.cover_id,
            first_publish_year: work.first_publish_year,
            format: edition?.format,
          });
          if (!res.success && res.reason === 'cap_reached') {
            promptAuth({
              title: 'Sign up to save more than 20 books',
              subtitle:
                'Your device shelf is full. Create an account to save unlimited books across all your devices.',
            });
          } else {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }
        return;
      }

      // Guest logging reading, finished, or stopped
      promptAuth({
        title: `Sign up to log ${work.title}`,
        subtitle: `Keep track of ${work.title}, record your daily progress, and build your private reading history.`,
      });
      return;
    }

    setBusy(true);
    try {
      await api.setStatus(work.id, status);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: number) => {
    if (!user) {
      promptAuth({
        title: `Sign up to rate ${work.title}`,
        subtitle: 'Share your ratings with half-star precision and build your personal taste profile.',
      });
      return;
    }
    setBusy(true);
    try {
      await api.setStatus(work.id, work.your_read?.status ?? 'finished', rating);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitProgress = async () => {
    const n = parseInt(pageInput, 10);
    if (!work.your_read || Number.isNaN(n)) return;
    setBusy(true);
    try {
      await api.addProgress(work.your_read.id, n, total ? (n / total) * 100 : null);
      setPageInput('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Mock histogram ratings distribution (PRD §6.24)
  const ratingsDistribution = [
    { stars: 5, pct: 64, count: 912 },
    { stars: 4, pct: 24, count: 341 },
    { stars: 3, pct: 8, count: 114 },
    { stars: 2, pct: 3, count: 42 },
    { stars: 1, pct: 1, count: 14 },
  ];

  const defaultDescription =
    'Piranesi lives in the House. Perhaps he always has. In his notebooks, day after day, he makes a clear and careful record of its wonders: the labyrinth of halls, the thousands upon thousands of statues, the tides that surge up staircases, the clouds that move in slow procession through the upper halls. A singular, spellbinding work of the imagination.';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: space[16], gap: space[6] }}>
        {/* 1. Hero Header */}
        <View style={{ alignItems: 'center', gap: space[3] }}>
          <Cover coverId={work.cover_id} size="xl" />
          <View style={{ alignItems: 'center', gap: space[1] }}>
            <Txt variant="displayM" style={{ textAlign: 'center' }}>
              {work.title}
            </Txt>

            {/* Author Link */}
            <Pressable
              onPress={() => router.push(`/author/${encodeURIComponent(work.author_name)}` as any)}
              accessibilityRole="link"
              accessibilityLabel={`Author ${work.author_name}`}
              hitSlop={8}
            >
              <Txt variant="bodyL" color="accent" style={{ fontWeight: '500' }}>
                {work.author_name}
              </Txt>
            </Pressable>

            {/* Series Link */}
            <Pressable
              onPress={() => router.push('/series/earthsea' as any)}
              accessibilityRole="link"
              accessibilityLabel="Series Earthsea Cycle Book 1"
              hitSlop={8}
            >
              <Txt variant="caption" color="muted">
                Earthsea Cycle · Book 1
              </Txt>
            </Pressable>

            {/* Metadata line */}
            <Txt variant="caption" color="muted">
              {[work.first_publish_year, formatLabel(edition?.format), total ? `${total} pages` : null]
                .filter(Boolean)
                .join(' · ')}
            </Txt>
          </View>
        </View>

        {/* 2. Primary Status Control (Largest element after cover) */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {STATUSES.map((s) => {
            const active =
              s.key === 'want'
                ? user
                  ? work.your_read?.status === 'want'
                  : savedInGuestShelf
                : work.your_read?.status === s.key;
            const label =
              !user && s.key === 'want' && savedInGuestShelf
                ? 'Saved to Want to read ✓'
                : s.label;
            return (
              <Button
                key={s.key}
                label={label}
                variant={active ? 'primary' : 'secondary'}
                disabled={busy}
                onPress={() => setStatus(s.key)}
                style={{ flex: 1, minWidth: 140 }}
              />
            );
          })}
        </View>

        {/* 3. Rating & 5-Bar Distribution Histogram */}
        <Card style={{ gap: space[3] }}>
          <View style={[sheet.row, { justifyContent: 'space-between' }]}>
            <Txt variant="micro" color="muted">
              YOUR RATING
            </Txt>
            <Txt variant="caption" color="muted">
              Optional
            </Txt>
          </View>

          <View style={[sheet.row, { justifyContent: 'space-between', alignItems: 'center' }]}>
            <Stars value={work.your_read?.rating ?? null} onChange={rate} size={28} />
            {work.your_read?.rating ? (
              <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                {work.your_read.rating} ★
              </Txt>
            ) : null}
          </View>

          {/* Histogram Divider */}
          <View style={{ height: 1, backgroundColor: c.line, marginVertical: space[1] }} />

          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <View style={sheet.row}>
                {work.rating_count && work.rating_count >= 5 ? (
                  <>
                    <Txt variant="displayM" tabular style={{ marginRight: space[2] }}>
                      {work.avg_rating ? Number(work.avg_rating).toFixed(1) : '—'}
                    </Txt>
                    <View>
                      <Stars value={work.avg_rating ? Number(work.avg_rating) : null} size={14} />
                      <Txt variant="micro" color="muted">
                        {work.rating_count.toLocaleString()} ratings
                      </Txt>
                    </View>
                  </>
                ) : work.rating_count && work.rating_count > 0 ? (
                  <View>
                    <Txt variant="body" style={{ fontWeight: '600' }}>
                      {work.rating_count} {work.rating_count === 1 ? 'rating' : 'ratings'}
                    </Txt>
                    <Stars value={work.avg_rating ? Number(work.avg_rating) : null} size={14} />
                  </View>
                ) : (
                  <View>
                    <Txt variant="body" color="muted">
                      No ratings yet
                    </Txt>
                    <Txt variant="micro" color="muted">
                      Be the first to rate
                    </Txt>
                  </View>
                )}
              </View>
            </View>

            {/* 5-Bar Distribution */}
            {ratingsDistribution.map((item) => (
              <View key={item.stars} style={[sheet.row, { gap: space[2] }]}>
                <Txt variant="caption" color="muted" tabular style={{ width: 22 }}>
                  {item.stars}★
                </Txt>
                <View
                  style={{
                    flex: 1,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: c.surface2,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${item.pct}%`,
                      backgroundColor: c.accent,
                      borderRadius: 4,
                    }}
                  />
                </View>
                <Txt variant="micro" color="muted" tabular style={{ width: 34, textAlign: 'right' }}>
                  {item.pct}%
                </Txt>
              </View>
            ))}
          </View>
        </Card>

        {/* 4. Active Progress Card (when reading) */}
        {work.your_read?.status === 'reading' && (
          <Card style={{ gap: space[3] }}>
            <Txt variant="micro" color="muted">
              CURRENT READING PROGRESS
            </Txt>
            <ProgressBar percent={percent ?? 0} />
            <Txt variant="caption" color="ink2">
              {page && total
                ? `Page ${page} of ${total} (${percent}%)`
                : percent
                ? `${percent}% complete`
                : 'Reading started'}
            </Txt>
            <View style={sheet.row}>
              <TextInput
                value={pageInput}
                onChangeText={setPageInput}
                keyboardType="number-pad"
                placeholder="Current page"
                placeholderTextColor={c.muted}
                accessibilityLabel="Enter current page"
                style={{
                  flex: 1,
                  minHeight: 48,
                  paddingHorizontal: space[3],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.line,
                  backgroundColor: c.surface,
                  color: c.ink,
                }}
              />
              <Button
                label="Save progress"
                variant="primary"
                onPress={submitProgress}
                disabled={busy || !pageInput}
              />
            </View>
          </Card>
        )}

        {/* 5. Description (Expandable) */}
        <Card style={{ gap: space[2] }}>
          <Txt variant="micro" color="muted">
            ABOUT THIS BOOK
          </Txt>
          <Txt
            variant="body"
            color="ink"
            numberOfLines={descExpanded ? undefined : 3}
            style={{ lineHeight: 22 }}
          >
            {defaultDescription}
          </Txt>
          <Pressable
            onPress={() => setDescExpanded(!descExpanded)}
            accessibilityRole="button"
            accessibilityLabel={descExpanded ? 'Show less description' : 'Read full description'}
            hitSlop={8}
          >
            <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
              {descExpanded ? 'Show less' : 'Read more'}
            </Txt>
          </Pressable>
        </Card>

        {/* 6. Metadata Strip */}
        <Card style={{ gap: space[2] }}>
          <Txt variant="micro" color="muted">
            EDITION DETAILS
          </Txt>
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Format
              </Txt>
              <Txt variant="caption" color="ink" style={{ textTransform: 'capitalize' }}>
                {edition?.format ?? 'Paperback'}
              </Txt>
            </View>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Pages
              </Txt>
              <Txt variant="caption" color="ink" tabular>
                {total ?? '245'} pages
              </Txt>
            </View>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                First Published
              </Txt>
              <Txt variant="caption" color="ink" tabular>
                {work.first_publish_year ?? '2020'}
              </Txt>
            </View>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                ISBN-13
              </Txt>
              <Txt variant="caption" color="ink" tabular>
                {edition?.isbn13 ?? '9780571353408'}
              </Txt>
            </View>
          </View>
        </Card>

        {/* 7. Tabs: Reviews / Editions / History */}
        <View style={{ gap: space[3], marginTop: space[2] }}>
          <SegmentedControl
            values={['reviews', 'editions', 'history'] as const}
            selected={activeTab}
            onSelect={setActiveTab}
            labels={{
              reviews: 'Reviews',
              editions: 'Editions',
              history: 'My History',
            }}
          />

          {activeTab === 'reviews' && (
            <View style={{ gap: space[3] }}>
              {/* Reviews Header with Write CTA */}
              <View style={[sheet.row, { justifyContent: 'space-between', alignItems: 'center' }]}>
                <Txt variant="body" style={{ fontWeight: '600' }}>
                  {reviewsTotal > 0 ? `${reviewsTotal} ${reviewsTotal === 1 ? 'Review' : 'Reviews'}` : 'Reviews'}
                </Txt>
                <Button
                  label="Write a review"
                  variant="secondary"
                  onPress={() => {
                    if (!user) {
                      promptAuth({
                        title: 'Sign up to write a review',
                        subtitle: 'Share your thoughts and ratings with other readers.',
                      });
                      return;
                    }
                    const targetId = work.your_read?.id ?? work.id;
                    router.push(`/review/compose/${targetId}` as any);
                  }}
                />
              </View>

              {/* Sort Selector (PRD §6.25, §10.7) */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
                {(
                  [
                    { key: 'friends', label: 'Friends first' },
                    { key: 'likes', label: 'Most liked' },
                    { key: 'newest', label: 'Newest' },
                    { key: 'highest', label: 'Highest rated' },
                    { key: 'lowest', label: 'Lowest rated' },
                  ] as const
                ).map((s) => (
                  <Pressable
                    key={s.key}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setReviewSort(s.key);
                    }}
                    style={{
                      paddingHorizontal: space[3],
                      paddingVertical: space[2],
                      borderRadius: radius.pill,
                      backgroundColor: reviewSort === s.key ? c.accent : c.surface2,
                    }}
                  >
                    <Txt
                      variant="caption"
                      style={{
                        fontWeight: reviewSort === s.key ? '600' : '400',
                        color: reviewSort === s.key ? c.ground : c.ink,
                      }}
                    >
                      {s.label}
                    </Txt>
                  </Pressable>
                ))}
              </ScrollView>

              {/* Rating Filter Chips */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
                {[null, 5, 4, 3, 2, 1].map((rVal) => (
                  <Pressable
                    key={rVal === null ? 'all' : String(rVal)}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setRatingFilter(rVal);
                    }}
                    style={{
                      paddingHorizontal: space[3],
                      paddingVertical: 4,
                      borderRadius: radius.pill,
                      borderWidth: 1,
                      borderColor: ratingFilter === rVal ? c.accent : c.line,
                      backgroundColor: ratingFilter === rVal ? c.surface2 : c.surface,
                    }}
                  >
                    <Txt
                      variant="micro"
                      style={{
                        fontWeight: ratingFilter === rVal ? '600' : '400',
                        color: ratingFilter === rVal ? c.accent : c.muted,
                      }}
                    >
                      {rVal === null ? 'All stars' : `${rVal}★`}
                    </Txt>
                  </Pressable>
                ))}
              </ScrollView>

              {/* Reviews List */}
              {reviewsLoading ? (
                <Card style={{ paddingVertical: space[6], alignItems: 'center' }}>
                  <Txt color="muted">Loading reviews…</Txt>
                </Card>
              ) : reviewsList.length === 0 ? (
                <EmptyState
                  title="No reviews yet"
                  subtitle="Be the first to share your thoughts on this book."
                  action={
                    <Button
                      label="Write a review"
                      variant="secondary"
                      onPress={() => {
                        if (!user) {
                          promptAuth({
                            title: 'Sign up to write a review',
                            subtitle: 'Share your thoughts and ratings with other readers.',
                          });
                          return;
                        }
                        const targetId = work.your_read?.id ?? work.id;
                        router.push(`/review/compose/${targetId}` as any);
                      }}
                    />
                  }
                />
              ) : (
                reviewsList.map((rev) => {
                  const isHiddenBySpoiler = rev.has_spoilers && !revealedSpoilers.has(rev.id);
                  return (
                    <Card
                      key={rev.id}
                      onPress={() => router.push(`/review/${rev.id}` as any)}
                      style={{ gap: space[2] }}
                    >
                      <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                        <View style={[sheet.row, { gap: space[2] }]}>
                          <View
                            style={{
                              width: 30,
                              height: 30,
                              borderRadius: 15,
                              backgroundColor: c.surface2,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Txt variant="caption" style={{ fontWeight: '600' }}>
                              {rev.author.username.charAt(0).toUpperCase()}
                            </Txt>
                          </View>
                          <View>
                            <Txt variant="caption" style={{ fontWeight: '600' }}>
                              {rev.author.display_name || rev.author.username}
                            </Txt>
                            <Txt variant="micro" color="muted">
                              {new Date(rev.published_at).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                              })}
                            </Txt>
                          </View>
                        </View>
                        <View style={[sheet.row, { gap: space[2] }]}>
                          <Stars value={rev.rating ?? null} size={14} />
                          {rev.hearted && (
                            <Txt variant="caption" style={{ color: c.heart }}>
                              ♥
                            </Txt>
                          )}
                        </View>
                      </View>

                      {/* Spoiler Gate */}
                      {isHiddenBySpoiler ? (
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation();
                            void Haptics.selectionAsync();
                            setRevealedSpoilers((prev) => new Set([...prev, rev.id]));
                          }}
                          style={{
                            paddingVertical: space[3],
                            paddingHorizontal: space[3],
                            backgroundColor: c.surface2,
                            borderRadius: radius.sm,
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <Txt variant="caption" style={{ fontWeight: '600', color: c.accent }}>
                            ⚠️ Contains spoilers
                          </Txt>
                          {rev.spoiler_after_page ? (
                            <Txt variant="micro" color="muted">
                              (after page {rev.spoiler_after_page})
                            </Txt>
                          ) : null}
                          <Txt variant="micro" color="muted">
                            Tap to reveal
                          </Txt>
                        </Pressable>
                      ) : (
                        <Txt variant="body" color="ink" style={{ lineHeight: 22 }}>
                          {rev.body}
                        </Txt>
                      )}

                      {/* Social bar */}
                      <View
                        style={[
                          sheet.row,
                          { justifyContent: 'space-between', marginTop: space[1], paddingTop: space[1] },
                        ]}
                      >
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation();
                            void toggleReviewLike(rev);
                          }}
                          style={[sheet.row, { gap: 4 }]}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Txt variant="body" style={{ color: rev.viewer_has_liked ? c.heart : c.muted }}>
                            {rev.viewer_has_liked ? '♥' : '♡'}
                          </Txt>
                          <Txt variant="micro" color="muted" tabular>
                            {rev.like_count > 0 ? rev.like_count : 'Like'}
                          </Txt>
                        </Pressable>
                        {rev.has_spoilers && !isHiddenBySpoiler && (
                          <Txt variant="micro" color="muted">
                            Spoilers revealed
                          </Txt>
                        )}
                      </View>
                    </Card>
                  );
                })
              )}
            </View>
          )}

          {activeTab === 'editions' && (
            <View style={{ gap: space[3] }}>
              <Card style={{ gap: space[3] }}>
                <Txt variant="title">Editions of {work.title}</Txt>
                <Txt variant="caption" color="muted">
                  {work.editions?.length ?? 4} editions available in catalog.
                </Txt>
                <Button
                  label="Choose your edition (The copy I own)"
                  variant="primary"
                  onPress={() => router.push(`/work/${work.id}/editions` as any)}
                />
              </Card>
            </View>
          )}

          {activeTab === 'history' && (
            <View style={{ gap: space[3] }}>
              {work.your_read ? (
                <Card style={{ gap: space[2] }}>
                  <Txt variant="title">Attempt #1</Txt>
                  <Txt variant="caption" color="muted">
                    Status: {work.your_read.status.toUpperCase()}
                  </Txt>
                  {work.your_read.rating && (
                    <Txt variant="caption" color="accent">
                      Your rating: {work.your_read.rating} ★
                    </Txt>
                  )}
                </Card>
              ) : (
                <EmptyState
                  title="No reading history yet"
                  subtitle="When you log this book, your reading sessions, progress notes, and finish dates will appear here."
                />
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
