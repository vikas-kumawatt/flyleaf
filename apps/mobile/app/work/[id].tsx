// Book Detail Screen (PRD §6.24, design.md §10, SL-41).
//
// Features:
// - Hero: cover, title, tappable author, series indicator, publication year
// - Status control: Want to read / Reading / Finished / Stopped (with guest mode & Action Gate)
// - Rating & 5-bar distribution histogram
// - Expandable description
// - Edition metadata strip
// - Tabs: Reviews / Editions / Reading History
//
// Audit 08: the description, series, histogram and metadata fallbacks were
// fixed values shown for every book; they now come from GET /works/:id and
// are hidden when absent. Status, rating and progress go through the offline
// queue like every other reading write (A-07-019/020), with visible errors
// (A-07-024). A merged id shows the survivor, and writes use its id (D3).

import React, { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import {
  ScrollView,
  View,
  TextInput,
  Pressable,
  Share,
  StyleSheet,
  Alert,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Work, type Review } from '@/lib/api';
import { starBars } from '@/lib/ratingBars';
import { useSession } from '@/lib/session';
import { ReportSheet, type ReportTarget } from '@/ui/ReportSheet';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import { useOfflineSync } from '@/offline/sync';
import { AddToShelfSheet } from '@/ui/AddToShelfSheet';
import { budgetTracker } from '@/lib/budgetTracker';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import { useRemote } from '@/lib/useRemote';
import { RemoteStatus } from '@/ui/RemoteStatus';
import {
  Button,
  Card,
  Chip,
  Cover,
  EmptyState,
  Heart,
  HeartMark,
  ProgressBar,
  RatingMark,
  Screen,
  SegmentedControl,
  SkeletonList,
  Stars,
  Txt,
  sheet,
} from '@/ui/components';
import { fontFamilies, space, radius, useTheme } from '@/ui/tokens';
import { ScreenHeader } from '@/ui/ScreenHeader';

const STATUSES: { key: string; label: string }[] = [
  { key: 'want', label: 'Want to read' },
  { key: 'reading', label: 'Reading' },
  { key: 'finished', label: 'Finished' },
  { key: 'dnf', label: 'Stopped' },
];

// An edition with no known format says nothing, not "Unknown".
const formatLabel = (f?: string | null) =>
  f && f !== 'unknown' ? f.charAt(0).toUpperCase() + f.slice(1) : null;

const pagesLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'page' : 'pages'}`;

/**
 * Catalogue descriptions arrive as light Markdown (bold, italics, links). The
 * page shows them as plain prose, so the markers are dropped and the words kept.
 */
const plainDescription = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\r\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '');

/** PRD §9.4: the heart count sits next to the rating count ("2,847 ratings · 1,203 hearts"). */
const heartsLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'heart' : 'hearts'}`;

/** A section of the page: a hairline rule above, a serif heading, no box (design.md §5). */
function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: space[3], paddingTop: space[6], borderTopWidth: 1, borderTopColor: c.line }}>
      <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Txt variant="title">{title}</Txt>
        {aside}
      </View>
      {children}
    </View>
  );
}

export default function WorkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const { promptAuth } = useActionGate();
  const { setLiked: setQueuedLike } = useOfflineSync();
  const { isSaved, addBook, removeBook } = useGuestShelf();
  const router = useRouter();
  const c = useTheme();

  const db = useDatabase();
  const remote = useRemote(id ? () => api.work(id) : null, [id, user?.id]);
  const work: Work | null = remote.state === 'ready' ? remote.data : null;
  const setWork = (w: Work) => remote.set(w);
  const [busy, setBusy] = useState(false);
  // PRD §7.8: a direct link to an explicit work resolves, behind a one-time
  // interstitial for a viewer search would hide it from. Remembered per work.
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const [descExpanded, setDescExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'reviews' | 'editions' | 'history'>('reviews');
  const [shelfSheetVisible, setShelfSheetVisible] = useState(false);

  const handleMuteBook = async () => {
    if (!work) return;
    if (!user) {
      promptAuth({ title: `Sign up to mute ${work.title}`, subtitle: 'Muted books stay out of your feed.' });
      return;
    }
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (isMuted) {
        await api.unmuteWork(work.id);
        setIsMuted(false);
        Alert.alert('Unmuted', `"${work.title}" has been unmuted.`);
      } else {
        await api.muteWork(work.id);
        setIsMuted(true);
        Alert.alert('Muted', `"${work.title}" will no longer appear in your feed.`);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Not saved', 'That change could not be saved. Try again.');
    }
  };

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

  // §4.4 taps to shelve (D-10-2): this page offers the shelve action for the
  // work, so its impression runs while the page is in focus.
  useFocusEffect(
    useCallback(() => {
      if (!id) return undefined;
      budgetTracker.bookPageShown(id);
      return () => budgetTracker.bookPageLeft(id);
    }, [id]),
  );

  // On focus as well as on a change of tab, sort or filter: coming back from
  // the composer has to show the review that was just posted.
  useFocusEffect(
    useCallback(() => {
      if (activeTab === 'reviews' && id) {
        loadReviews().catch(() => {});
      }
    }, [id, activeTab, reviewSort, ratingFilter]),
  );

  const toggleReviewLike = async (review: Review) => {
    if (!user) {
      promptAuth({
        title: 'Sign up to like reviews',
        subtitle: 'Join Flyleaf to like reviews and follow readers.',
      });
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const liked = !review.viewer_has_liked;
    const apply = (to: boolean) =>
      setReviewsList((prev) =>
        prev.map((r) =>
          r.id === review.id
            ? { ...r, viewer_has_liked: to, like_count: Math.max(0, r.like_count + (to ? 1 : -1)) }
            : r,
        ),
      );
    // Optimistic, then queued (D-07-2); reverted only if it could not be queued.
    apply(liked);
    try {
      await setQueuedLike(review.read_id, liked);
    } catch {
      apply(!liked);
    }
  };

  const handleOpenShelfSheet = () => {
    if (!user) {
      promptAuth({
        title: 'Sign up to create shelves',
        subtitle: 'Organize your reading with custom shelves, ranked lists, and notes.',
      });
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShelfSheetVisible(true);
  };

  const ackKey = work ? `explicit_ack_${work.id}` : null;
  useEffect(() => {
    if (!ackKey || !work?.content_warning) return;
    SecureStore.getItemAsync(ackKey)
      .then((v) => setAcknowledged(v === '1'))
      .catch(() => setAcknowledged(false));
  }, [ackKey, work?.content_warning]);

  if (remote.state !== 'ready' || !work) {
    return <RemoteStatus remote={remote} noun="book" onRetry={() => void remote.reload()} />;
  }

  if (work.content_warning && acknowledged !== true) {
    return (
      <Screen>
        <ScreenHeader title="" />
        <EmptyState
          title="This book is marked explicit"
          subtitle="It is hidden from your search results. You can still open it, log it and rate it."
          action={
            <Button
              label="Show the book"
              onPress={() => {
                setAcknowledged(true);
                if (ackKey) void SecureStore.setItemAsync(ackKey, '1').catch(() => {});
              }}
            />
          }
        />
      </Screen>
    );
  }

  const edition = work.editions?.[0];
  const author = work.authors?.[0];
  const series = work.series?.[0];
  const ratingsDistribution = starBars(work.rating_distribution);
  const ratedTotal = ratingsDistribution.reduce((a, b) => a + b.count, 0);

  /** Local read state shown at once; the write itself is queued and syncs when it can. */
  const optimistic = (patch: Partial<NonNullable<Work['your_read']>>) =>
    setWork({
      ...work,
      your_read: {
        id: work.your_read?.id ?? '',
        status: work.your_read?.status ?? 'want',
        rating: work.your_read?.rating ?? null,
        hearted: work.your_read?.hearted ?? false,
        page: work.your_read?.page ?? null,
        percent: work.your_read?.percent ?? null,
        ...patch,
      },
    });
  const failed = () =>
    Alert.alert('Not saved', 'That change could not be saved on this phone. Please try again.');
  const meta = {
    title: work.title,
    author_name: work.author_name,
    cover_id: work.cover_id,
    page_count: edition?.page_count ?? null,
  };
  const total = edition?.page_count ?? null;
  const page = work.your_read?.page ?? null;
  const percent =
    total && page
      ? Math.round((page / total) * 100)
      : work.your_read?.percent ?? null;
  const savedInGuestShelf = !user && isSaved(work.id);

  // Status control handler (SL-31, SL-32, SL-41)
  const setStatus = async (status: string) => {
    // §4.4 "+ tapped -> anything saved": the FAB's search lands here.
    budgetTracker.recordLogSheetCompleted({ targetStatus: status });
    // §4.4 taps to shelve (D-10-2): book_logged goes at local success below.
    budgetTracker.shelveTapped(work.id);

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
            budgetTracker.bookShelvedLocally(work.id, { targetStatus: status });
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

    if (!db) return;
    setBusy(true);
    try {
      await new OfflineRepository(db, user.id).saveReadStatus(work.id, status, null, null, meta);
      budgetTracker.bookShelvedLocally(work.id, { targetStatus: status });
      optimistic({ status });
    } catch {
      failed();
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: number | null) => {
    if (!user) {
      promptAuth({
        title: `Sign up to rate ${work.title}`,
        subtitle: 'Share your ratings with half-star precision and build your personal taste profile.',
      });
      return;
    }
    if (!db) return;
    setBusy(true);
    try {
      const repo = new OfflineRepository(db, user.id);
      if (rating === null) {
        // Clearing needs a rating to clear; with no read there is nothing to do.
        if (!work.your_read) return;
        await repo.clearRating(work.id);
        optimistic({ rating: null });
        return;
      }
      const status = work.your_read?.status ?? 'finished';
      await repo.saveReadStatus(work.id, status, rating, null, meta);
      optimistic({ status, rating });
    } catch {
      failed();
    } finally {
      setBusy(false);
    }
  };

  const submitProgress = async () => {
    const n = parseInt(pageInput, 10);
    if (!work.your_read || Number.isNaN(n) || n < 0 || !db || !user) return;
    setBusy(true);
    try {
      const pct = total ? Math.min(100, (n / total) * 100) : null;
      await new OfflineRepository(db, user.id).saveProgress(work.your_read.id, n, pct);
      optimistic({ page: n, percent: pct });
      setPageInput('');
    } catch {
      failed();
    } finally {
      setBusy(false);
    }
  };

  // The status control carries the page's one filled action: the current
  // status when there is one, otherwise the first step (Want to read).
  const currentStatus = user ? work.your_read?.status : savedInGuestShelf ? 'want' : undefined;
  const suggestedStatus = currentStatus === 'paused' ? 'reading' : 'want';
  const statusLine = currentStatus
    ? STATUSES.find((s) => s.key === currentStatus)?.label ?? formatLabel(currentStatus)
    : 'Not in your library yet';

  const openReviewComposer = () => {
    if (!user) {
      promptAuth({
        title: 'Sign up to write a review',
        subtitle: 'Share your thoughts and ratings with other readers.',
      });
      return;
    }
    const targetId = work.your_read?.id ?? work.id;
    router.push(`/review/compose/${targetId}` as any);
  };

  const iconButton = (active = false) =>
    ({ pressed }: { pressed: boolean }) => ({
      minWidth: 44,
      minHeight: 44,
      borderRadius: radius.pill,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: pressed || active ? c.surface2 : 'transparent',
    });

  return (
    <Screen>
      <ScreenHeader title="" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: space[16], gap: space[6] }}>
        {/* 1. Hero: the cover is the moment (design.md §10) */}
        <View style={{ alignItems: 'center', gap: space[4], paddingTop: space[2] }}>
          <Cover coverId={work.cover_id} title={work.title} author={work.author_name} size="xl" />
          <View style={{ alignItems: 'center', gap: space[1] }}>
            <Txt variant="displayM" style={{ textAlign: 'center' }}>
              {work.title}
            </Txt>

            {/* Author Link */}
            <Pressable
              onPress={() => { if (author) router.push(`/author/${author.id}` as any); }}
              disabled={!author}
              accessibilityRole="link"
              accessibilityLabel={`Author ${work.author_name}`}
              hitSlop={{ top: 11, bottom: 11, left: 8, right: 8 }}
            >
              <Txt variant="body" color="ink2" style={{ textAlign: 'center' }}>
                {work.author_name}
              </Txt>
            </Pressable>

            {/* Series Link */}
            {series ? (
              <Pressable
                onPress={() => router.push(`/series/${series.id}` as any)}
                accessibilityRole="link"
                accessibilityLabel={`Series ${series.name}${series.position != null ? `, book ${series.position}` : ''}`}
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              >
                <Txt variant="caption" color="muted" style={{ textAlign: 'center' }}>
                  {series.name}{series.position != null ? ` · Book ${series.position}` : ''}
                </Txt>
              </Pressable>
            ) : null}

            {/* Metadata line */}
            <Txt variant="caption" color="muted" tabular style={{ textAlign: 'center' }}>
              {[work.first_publish_year, formatLabel(edition?.format), total ? pagesLabel(total) : null]
                .filter(Boolean)
                .join(' · ')}
            </Txt>
          </View>
        </View>

        {/* 2. Status control: the largest element after the cover, one filled action */}
        <View style={{ gap: space[2] }}>
          <Txt variant="micro" color="muted">
            {statusLine}
          </Txt>
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
                  ? 'Saved to Want to read'
                  : s.label;
              const filled = currentStatus ? active : s.key === suggestedStatus;
              return (
                <Button
                  key={s.key}
                  label={label}
                  variant={filled ? 'primary' : 'secondary'}
                  disabled={busy}
                  onPress={() => setStatus(s.key)}
                  style={{ flex: 1, minWidth: 140 }}
                />
              );
            })}
          </View>

          {/* Secondary actions (PRD §6.31, §6.34: Add to shelf & Share) */}
          <View style={[sheet.row, { gap: space[1] }]}>
            <Button
              label="Add to shelf"
              variant="tertiary"
              onPress={handleOpenShelfSheet}
              accessibilityLabel="Add to shelf"
              style={{ marginLeft: -space[2] }}
            />
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                void Share.share({
                  title: work.title,
                  message: `${work.title} by ${work.author_name}, on Flyleaf`,
                });
              }}
              accessibilityRole="button"
              accessibilityLabel="Share book"
              style={iconButton()}
            >
              <Ionicons name="share-outline" size={18} color={c.muted} />
            </Pressable>

            {user && (
              <Pressable
                onPress={handleMuteBook}
                accessibilityRole="button"
                accessibilityLabel={isMuted ? "Unmute book" : "Mute book"}
                accessibilityState={{ selected: isMuted }}
                style={iconButton(isMuted)}
              >
                <Ionicons name={isMuted ? "volume-mute" : "volume-mute-outline"} size={18} color={isMuted ? c.ink : c.muted} />
              </Pressable>
            )}
            {user && (
              <Pressable
                onPress={() => setReportTarget({ type: 'work', id: work.id })}
                accessibilityRole="button"
                accessibilityLabel="Report book"
                style={iconButton()}
              >
                <Ionicons name="flag-outline" size={18} color={c.muted} />
              </Pressable>
            )}
          </View>
        </View>

        {/* 3. Progress (when reading) */}
        {work.your_read?.status === 'reading' && (
          <Section title="Your progress">
            <View style={{ gap: space[2] }}>
              <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
                <Txt variant="caption" color="ink2" tabular>
                  {page && total
                    ? `Page ${page} of ${total}`
                    : percent
                    ? `${percent}% complete`
                    : 'Reading started'}
                </Txt>
                {page && total ? (
                  <Txt variant="caption" color="muted" tabular>
                    {percent}%
                  </Txt>
                ) : null}
              </View>
              <ProgressBar percent={percent ?? 0} />
            </View>
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
                  borderColor: c.lineStrong,
                  backgroundColor: c.surface,
                  color: c.ink,
                  fontFamily: fontFamilies.uiRegular,
                  fontSize: 15,
                }}
              />
              <Button
                label="Save"
                variant="secondary"
                onPress={submitProgress}
                disabled={busy || !pageInput}
              />
            </View>
          </Section>
        )}

        {/* 4. Your rating */}
        <Section
          title="Your rating"
          aside={
            <Txt variant="caption" color="muted">
              Optional
            </Txt>
          }
        >
          <Stars value={work.your_read?.rating ?? null} onChange={rate} />
        </Section>

        {/* 5. Everyone's ratings: average and the 5-bar histogram, labelled directly.
            The API has no friends' ratings for a work yet; friends come first in Reviews. */}
        <Section title="Ratings">
          {work.rating_count && work.rating_count >= 5 ? (
            <View style={[sheet.row, { gap: space[3], flexWrap: 'wrap' }]}>
              <Txt variant="displayM" tabular>
                {work.avg_rating ? Number(work.avg_rating).toFixed(1) : '—'}
              </Txt>
              <View style={{ flexShrink: 1 }}>
                <Stars value={work.avg_rating ? Number(work.avg_rating) : null} size={14} />
                <Txt variant="caption" color="muted" tabular>
                  {work.rating_count.toLocaleString()} ratings{work.heart_count ? ` · ${heartsLabel(work.heart_count)}` : ''}
                </Txt>
              </View>
            </View>
          ) : work.rating_count && work.rating_count > 0 ? (
            // PRD §9.5: below 5 ratings, the count instead of an average
            // (the stars drew the average here; audit 09).
            <View>
              <Txt variant="body" tabular style={{ fontWeight: '500' }}>
                {work.rating_count} {work.rating_count === 1 ? 'rating' : 'ratings'}
              </Txt>
              {work.heart_count ? (
                <Txt variant="caption" color="muted" tabular>{heartsLabel(work.heart_count)}</Txt>
              ) : null}
            </View>
          ) : (
            <View>
              <Txt variant="body" color="ink2">
                No ratings yet
              </Txt>
              <Txt variant="caption" color="muted">
                Be the first to rate
              </Txt>
            </View>
          )}

          {/* 5-Bar Distribution (work's real ratings; hidden when there are none) */}
          {ratedTotal > 0 && (
            <View style={{ gap: space[2] }}>
              {ratingsDistribution.map((item) => (
                <View
                  key={item.stars}
                  style={[sheet.row, { gap: space[3] }]}
                  accessible
                  accessibilityLabel={`${item.stars} stars, ${item.pct}%`}
                >
                  <View style={[sheet.row, { minWidth: 28, gap: 2 }]}>
                    <Txt variant="caption" color="ink2" tabular>
                      {item.stars}
                    </Txt>
                    <Ionicons name="star-outline" size={12} color={c.muted} />
                  </View>
                  <View
                    style={{
                      flex: 1,
                      height: 8,
                      borderRadius: radius.xs,
                      backgroundColor: c.line,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        height: '100%',
                        width: `${item.pct}%`,
                        backgroundColor: c.ink2,
                        borderRadius: radius.xs,
                      }}
                    />
                  </View>
                  <Txt variant="caption" color="ink2" tabular style={{ minWidth: 40, textAlign: 'right' }}>
                    {item.pct}%
                  </Txt>
                </View>
              ))}
            </View>
          )}
        </Section>

        {/* 6. Description (Expandable), only when the catalog has one */}
        {work.description ? (
          <Section title="About this book">
            <Txt
              variant="body"
              color="ink"
              numberOfLines={descExpanded ? undefined : 4}
            >
              {plainDescription(work.description)}
            </Txt>
            <Button
              label={descExpanded ? 'Show less' : 'Read more'}
              variant="tertiary"
              size="sm"
              onPress={() => setDescExpanded(!descExpanded)}
              accessibilityLabel={descExpanded ? 'Show less description' : 'Read full description'}
              style={{ alignSelf: 'flex-start', marginLeft: -space[2] }}
            />
          </Section>
        ) : null}

        {/* 7. Edition details: ruled label and value rows */}
        <Section title="Edition">
          <View>
            {(
              [
                ['Format', formatLabel(edition?.format) ?? '—'],
                ['Pages', total ? pagesLabel(total) : '—'],
                ['First published', work.first_publish_year ?? '—'],
                ['ISBN-13', edition?.isbn13 ?? '—'],
              ] as const
            ).map(([label, value], i) => (
              <View
                key={label}
                style={[
                  sheet.row,
                  {
                    justifyContent: 'space-between',
                    gap: space[4],
                    paddingVertical: space[2],
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: c.line,
                  },
                ]}
              >
                <Txt variant="caption" color="muted">
                  {label}
                </Txt>
                <Txt variant="caption" color="ink" tabular style={{ flexShrink: 1, textAlign: 'right' }}>
                  {value}
                </Txt>
              </View>
            ))}
          </View>
        </Section>

        {/* 8. Tabs: Reviews / Editions / History */}
        <View style={{ gap: space[4] }}>
          <SegmentedControl
            values={['reviews', 'editions', 'history'] as const}
            selected={activeTab}
            onSelect={setActiveTab}
            labels={{
              reviews: 'Reviews',
              editions: 'Editions',
              history: 'Your history',
            }}
          />

          {activeTab === 'reviews' && (
            <View style={{ gap: space[3] }}>
              {/* Reviews Header with Write CTA */}
              <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap', rowGap: space[2] }]}>
                <Txt variant="body" tabular style={{ fontWeight: '500' }}>
                  {reviewsTotal > 0 ? `${reviewsTotal.toLocaleString()} ${reviewsTotal === 1 ? 'review' : 'reviews'}` : 'Reviews'}
                </Txt>
                <Button
                  label="Write a review"
                  variant="secondary"
                  size="sm"
                  onPress={openReviewComposer}
                />
              </View>

              {/* Sort Selector (PRD §6.25, §10.7): friends first by default */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2], paddingVertical: space[1] }}>
                {(
                  [
                    { key: 'friends', label: 'Friends first' },
                    { key: 'likes', label: 'Most liked' },
                    { key: 'newest', label: 'Newest' },
                    { key: 'highest', label: 'Highest rated' },
                    { key: 'lowest', label: 'Lowest rated' },
                  ] as const
                ).map((s) => (
                  <Chip
                    key={s.key}
                    label={s.label}
                    selected={reviewSort === s.key}
                    onPress={() => setReviewSort(s.key)}
                  />
                ))}
              </ScrollView>

              {/* Rating Filter Chips */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2], paddingVertical: space[1] }}>
                {[null, 5, 4, 3, 2, 1].map((rVal) => (
                  <Chip
                    key={rVal === null ? 'all' : String(rVal)}
                    label={rVal === null ? 'All ratings' : String(rVal)}
                    icon={rVal === null ? undefined : 'star-outline'}
                    selected={ratingFilter === rVal}
                    onPress={() => setRatingFilter(rVal)}
                    accessibilityLabel={rVal === null ? 'All ratings' : `${rVal} stars`}
                  />
                ))}
              </ScrollView>

              {/* Reviews List: ruled rows */}
              {reviewsLoading ? (
                <SkeletonList rows={3} lead="avatar" style={{ paddingHorizontal: 0 }} />
              ) : reviewsList.length === 0 ? (
                <EmptyState
                  title="No reviews yet"
                  subtitle="Be the first to share your thoughts on this book."
                  action={
                    <Button
                      label="Write a review"
                      variant="secondary"
                      onPress={openReviewComposer}
                    />
                  }
                />
              ) : (
                <View>
                  {reviewsList.map((rev, index) => {
                    const isHiddenBySpoiler = rev.has_spoilers && !revealedSpoilers.has(rev.id);
                    return (
                      <Pressable
                        key={rev.id}
                        onPress={() => {
                          void Haptics.selectionAsync();
                          router.push(`/review/${rev.id}` as any);
                        }}
                        accessibilityRole="button"
                        style={({ pressed }) => ({
                          gap: space[2],
                          paddingVertical: space[4],
                          borderTopWidth: index ? 1 : 0,
                          borderTopColor: c.line,
                          backgroundColor: pressed ? c.surface2 : 'transparent',
                        })}
                      >
                        <View style={[sheet.row, { justifyContent: 'space-between', gap: space[3] }]}>
                          <View style={[sheet.row, { gap: space[2], flex: 1 }]}>
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
                              <Txt variant="caption" style={{ fontWeight: '500' }}>
                                {rev.author.username.charAt(0).toUpperCase()}
                              </Txt>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Txt variant="caption" numberOfLines={1} style={{ fontWeight: '500' }}>
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
                            {rev.rating ? <RatingMark value={rev.rating} /> : null}
                            {rev.hearted ? <HeartMark /> : null}
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
                            accessibilityRole="button"
                            style={{
                              minHeight: 44,
                              paddingVertical: space[3],
                              paddingHorizontal: space[3],
                              backgroundColor: c.surface2,
                              borderRadius: radius.md,
                              borderCurve: 'continuous',
                              alignItems: 'center',
                              gap: space[1],
                            }}
                          >
                            <View style={[sheet.row, { gap: space[1] }]}>
                              <Ionicons name="alert-circle-outline" size={16} color={c.ink2} />
                              <Txt variant="caption" color="ink2" style={{ fontWeight: '500' }}>
                                Contains spoilers
                              </Txt>
                            </View>
                            {rev.spoiler_after_page ? (
                              <Txt variant="micro" color="muted" tabular>
                                After page {rev.spoiler_after_page}
                              </Txt>
                            ) : null}
                            <Txt variant="micro" color="muted">
                              Tap to reveal
                            </Txt>
                          </Pressable>
                        ) : (
                          <Txt variant="bodyL" color="ink" numberOfLines={6}>
                            {rev.body}
                          </Txt>
                        )}

                        {/* Social bar */}
                        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                          <Pressable
                            onPress={(e) => {
                              e.stopPropagation();
                              void toggleReviewLike(rev);
                            }}
                            style={[sheet.row, { gap: space[1], minHeight: 44, minWidth: 44 }]}
                            accessibilityRole="button"
                            accessibilityLabel={rev.viewer_has_liked ? 'Unlike review' : 'Like review'}
                          >
                            <Ionicons
                              name={rev.viewer_has_liked ? 'heart' : 'heart-outline'}
                              size={16}
                              color={rev.viewer_has_liked ? c.heart : c.muted}
                            />
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
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          )}

          {activeTab === 'editions' && (
            <View style={{ gap: space[3] }}>
              <Txt variant="title">Editions of {work.title}</Txt>
              <Txt variant="caption" color="muted" tabular>
                {(work.editions?.length ?? 0).toLocaleString()} {work.editions?.length === 1 ? 'edition' : 'editions'} in the catalog
              </Txt>
              <Button
                label="Choose the copy you own"
                variant="secondary"
                onPress={() => router.push(`/work/${work.id}/editions` as any)}
                style={{ alignSelf: 'flex-start' }}
              />
            </View>
          )}

          {activeTab === 'history' && (
            <View style={{ gap: space[3] }}>
              {work.your_read ? (
                <Card style={{ gap: space[2] }}>
                  <Txt variant="title">Latest attempt</Txt>
                  <Txt variant="caption" color="ink2">
                    {STATUSES.find((s) => s.key === work.your_read?.status)?.label ?? work.your_read.status}
                  </Txt>
                  {work.your_read.rating ? <RatingMark value={work.your_read.rating} /> : null}
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

      {/* Add-to-Shelf Sheet (SH-04) */}
      <AddToShelfSheet
        visible={shelfSheetVisible}
        onClose={() => setShelfSheetVisible(false)}
        work={work}
      />
      <ReportSheet target={reportTarget} onClose={() => setReportTarget(null)} />
    </Screen>
  );
}
