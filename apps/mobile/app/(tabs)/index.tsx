// Tab 1 — Home / Feed (PRD §5.2, §6.13, §12, SO-15; wired to the API in audit 14).
//
// GET /v1/feed, Friends / Popular. A signed-in reader opens Friends; the
// server switches one with no follows to Popular and says why
// (is_cold_start / cold_start_reason), and the banner says so. Guests see
// Popular; Friends asks them to sign in. Cursor paging (the cursor is opaque),
// pull to refresh, and a visible end after ~100 items (§12.6). A failed page
// is an inline retry row, never a full-screen error; a failed refresh keeps
// what is on screen under an offline banner (§6.13).
//
// Swipe right → Want to read: a read with status `want`, only when the reader
// has none (D-11-1), through the offline queue, with a toast that says what
// happened and an Undo that deletes only the read the swipe created. Swipe
// left → Rate & Review: the review composer for that book.
//
// The newest running import shows its progress banner here (PRD §6.8,
// A-12-023), dismissible per import.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, FlatList, Pressable, RefreshControl, ActivityIndicator, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { api, type ImportResponse } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useOfflineSync } from '@/offline/sync';
import { useActionGate } from '@/ui/ActionGate';
import { FeedCard } from '@/ui/FeedCard';
import { ImportProgressBanner } from '@/ui/ImportProgressBanner';
import { type FeedActivityItem } from '@/lib/feedCard';
import { badgeLabel } from '@/lib/notifications';
import {
  EMPTY_FEED,
  FEED_PAGE_SIZE,
  activeImportForBanner,
  applyFeedPage,
  canShowTab,
  defaultFeedTab,
  isCaughtUp,
  shouldLoadMore,
  wantToReadToast,
  type FeedPage,
  type FeedState,
  type FeedTab,
  type WantToReadOutcome,
} from '@/lib/homeFeed';
import { Button, Card, EmptyState, Screen, SegmentedControl, Txt, sheet, Skeleton } from '@/ui/components';
import { cover, radius, space, useTheme } from '@/ui/tokens';

const DISMISSED_IMPORTS_KEY = 'home_dismissed_imports';

type LoadState = 'idle' | 'loading' | 'refreshing' | 'more';

interface Toast {
  message: string;
  tone: 'ok' | 'info' | 'error';
  undoReadId?: string;
}

export default function HomeScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  // The bell's unread badge (SO-33), refreshed whenever Home is shown.
  const [unread, setUnread] = useState(0);
  useFocusEffect(
    useCallback(() => {
      if (!user) {
        setUnread(0);
        return;
      }
      let live = true;
      api
        .getUnreadNotificationCount()
        .then((r) => live && setUnread(r.unread_count))
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [user]),
  );
  const badge = badgeLabel(unread);
  const signedIn = Boolean(user);
  const { promptAuth } = useActionGate();
  const { repository } = useOfflineSync();
  const { migrationMessage, dismissMigrationMessage } = useGuestShelf();

  const [tab, setTab] = useState<FeedTab>(defaultFeedTab(signedIn));
  const [feeds, setFeeds] = useState<Record<FeedTab, FeedState>>({ friends: EMPTY_FEED, popular: EMPTY_FEED });
  const [load, setLoad] = useState<LoadState>('idle');
  // Which request failed: the first page (nothing to show), a refresh (keep the old cards), or a later page.
  const [failure, setFailure] = useState<'first' | 'refresh' | 'more' | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeImport, setActiveImport] = useState<ImportResponse | null>(null);
  const [dismissedImports, setDismissedImports] = useState<Set<string>>(new Set());
  // A response for the tab (and account) that is no longer showing is dropped.
  const generation = useRef(0);

  // Signing in or out resets the feeds: they are per account.
  useEffect(() => {
    generation.current++;
    // A request already in flight is now stale and will not clear these itself
    // (its result is dropped), so they are cleared here, as selectTab does.
    // Without this a session restored mid-request left the skeleton up forever.
    setLoad('idle');
    setFailure(null);
    setTab(defaultFeedTab(signedIn));
    setFeeds({ friends: EMPTY_FEED, popular: EMPTY_FEED });
  }, [signedIn, user?.id]);

  const feed = feeds[tab];

  const fetchPage = useCallback(
    async (which: FeedTab, mode: 'replace' | 'append', cursor: string | null) => {
      const gen = generation.current;
      setLoad(mode === 'append' ? 'more' : feeds[which].items.length > 0 ? 'refreshing' : 'loading');
      setFailure(null);
      try {
        const page = (await api.client.getFeed({
          tab: which,
          limit: FEED_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        })) as unknown as FeedPage;
        if (gen !== generation.current) return;
        setFeeds((prev) => ({ ...prev, [which]: applyFeedPage(prev[which], page, mode) }));
      } catch {
        if (gen !== generation.current) return;
        setFailure(mode === 'append' ? 'more' : feeds[which].items.length > 0 ? 'refresh' : 'first');
      } finally {
        if (gen === generation.current) setLoad('idle');
      }
    },
    [feeds],
  );

  // First load of a tab (and after the account changes).
  useEffect(() => {
    if (!canShowTab(tab, signedIn)) return;
    if (feeds[tab].servedTab === null && load === 'idle' && failure === null) {
      void fetchPage(tab, 'replace', null);
    }
  }, [tab, signedIn, feeds, load, failure, fetchPage]);

  const onRefresh = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void fetchPage(tab, 'replace', null);
  };

  const onEndReached = () => {
    if (failure === 'more') return; // the retry row asks first
    if (shouldLoadMore(feed, load !== 'idle')) void fetchPage(tab, 'append', feed.cursor);
  };

  const selectTab = (next: FeedTab) => {
    generation.current++;
    setLoad('idle');
    setFailure(null);
    setTab(next);
  };

  // ------------------------------------------------------------ import banner
  useEffect(() => {
    if (!signedIn) {
      setActiveImport(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let dismissed = new Set<string>();
      try {
        const raw = await SecureStore.getItemAsync(DISMISSED_IMPORTS_KEY);
        if (raw) dismissed = new Set(JSON.parse(raw) as string[]);
      } catch {
        // A lost dismissal shows the banner again; nothing worse.
      }
      try {
        const { imports } = await api.listImports();
        if (cancelled) return;
        setDismissedImports(dismissed);
        setActiveImport(activeImportForBanner(imports, dismissed));
      } catch {
        // No banner when the list cannot be read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.id]);

  const dismissImport = (id: string) => {
    const next = new Set(dismissedImports).add(id);
    setDismissedImports(next);
    setActiveImport(null);
    // The newest few are enough to remember.
    void SecureStore.setItemAsync(DISMISSED_IMPORTS_KEY, JSON.stringify([...next].slice(-20))).catch(() => {});
  };

  // ------------------------------------------------------------ swipe actions
  const showToast = (next: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), next.undoReadId ? 5000 : 3000);
  };
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const handleWantToRead = async (workId: string) => {
    if (!user) {
      promptAuth({ title: 'Sign in to save books to Want to read' });
      return;
    }
    const item = feed.items.find((i) => i.work_id === workId);
    let outcome: WantToReadOutcome;
    try {
      outcome = repository
        ? await repository.wantToRead(workId, {
            title: item?.work?.title,
            author_name: item?.work?.author_name ?? null,
            cover_id: item?.work?.cover_id ?? null,
          })
        : { kind: 'failed' };
    } catch {
      outcome = { kind: 'failed' };
    }
    const t = wantToReadToast(outcome);
    showToast({
      message: t.message,
      tone: t.tone,
      undoReadId: t.undo && 'readId' in outcome ? outcome.readId : undefined,
    });
  };

  const undoWantToRead = async (readId: string) => {
    setToast(null);
    try {
      // Only the read the swipe created (D-11-1).
      await repository?.deleteRead(readId);
      showToast({ message: 'Removed from Want to read', tone: 'info' });
    } catch {
      showToast({ message: 'Could not undo that. Try again.', tone: 'error' });
    }
  };

  const handleRateAndReview = (workId: string) => {
    if (!user) {
      promptAuth({ title: 'Sign in to rate and review books' });
      return;
    }
    // The composer takes a work id and finds or starts the read (review/compose/[id]).
    router.push(`/review/compose/${workId}` as any);
  };

  // ------------------------------------------------------------ render
  const banner = feed.coldStart;
  const gated = !canShowTab(tab, signedIn);

  const hasHeader = Boolean(activeImport) || failure === 'refresh' || Boolean(banner);
  const header = (
    <View style={{ gap: space[3], paddingHorizontal: space[4], paddingTop: space[4] }}>
      {activeImport && (
        <ImportProgressBanner
          importId={activeImport.id}
          initialData={activeImport}
          onDismiss={() => dismissImport(activeImport.id)}
          onComplete={() => {}}
        />
      )}
      {failure === 'refresh' && (
        <View style={[styles.notice, { backgroundColor: c.surface2 }]} accessibilityRole="alert">
          <Ionicons name="cloud-offline-outline" size={18} color={c.ink2} />
          <Txt variant="caption" color="ink2" style={{ flex: 1 }}>
            You are offline. Showing what was loaded before.
          </Txt>
        </View>
      )}
      {banner && (
        <Card>
          <Txt variant="body" style={{ fontWeight: '500' }}>
            {banner.title}
          </Txt>
          <Txt variant="caption" color="ink2" style={{ marginTop: space[1] }}>
            {banner.subtitle}
          </Txt>
          {banner.reason !== 'sparse_follows' && (
            <Pressable
              onPress={() => router.push('/discover' as any)}
              accessibilityRole="button"
              accessibilityLabel="Find readers to follow"
              style={styles.link}
            >
              <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                Find readers to follow
              </Txt>
            </Pressable>
          )}
        </Card>
      )}
    </View>
  );

  const footer = (() => {
    if (load === 'more') {
      return <ActivityIndicator style={{ marginVertical: space[4] }} color={c.muted} />;
    }
    if (failure === 'more') {
      return (
        <View style={[styles.retryRow, { borderTopColor: c.line }]} accessibilityRole="alert">
          <Txt variant="caption" color="ink2" style={{ flex: 1 }}>
            Could not load more.
          </Txt>
          <Button label="Try again" variant="secondary" size="sm" onPress={() => void fetchPage(tab, 'append', feed.cursor)} />
        </View>
      );
    }
    if (isCaughtUp(feed)) {
      return (
        <View style={styles.end} accessibilityRole="text">
          <Ionicons name="checkmark-circle-outline" size={20} color={c.muted} />
          <Txt variant="caption" color="muted">
            You're all caught up
          </Txt>
        </View>
      );
    }
    return null;
  })();

  const empty = (() => {
    if (load === 'loading') {
      // Skeleton entries on first load (§6.13), shaped like the entries that replace them.
      return (
        <View accessible accessibilityLabel="Loading your feed" accessibilityState={{ busy: true }}>
          {[0, 1, 2].map((k) => (
            <View key={k} style={[styles.skeletonEntry, { borderBottomColor: c.line }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                <Skeleton width={32} height={32} borderRadius={radius.pill} />
                <Skeleton width="45%" height={12} />
              </View>
              <View style={{ flexDirection: 'row', gap: space[4] }}>
                <Skeleton width={cover.m.width} height={cover.m.height} borderRadius={radius.xs} />
                <View style={{ flex: 1, gap: space[2] }}>
                  <Skeleton width="75%" height={24} />
                  <Skeleton width="50%" height={12} />
                  <Skeleton width="90%" height={16} style={{ marginTop: space[2] }} />
                  <Skeleton width="70%" height={16} />
                </View>
              </View>
            </View>
          ))}
        </View>
      );
    }
    if (failure === 'first') {
      return (
        <EmptyState
          title="We couldn't load the feed"
          subtitle="Check your connection and try again."
          action={<Button label="Try again" variant="secondary" onPress={() => void fetchPage(tab, 'replace', null)} />}
        />
      );
    }
    // Nobody to show yet: offer readers to follow (SO-52).
    if (tab === 'friends' && user) {
      return (
        <EmptyState
          title="Your feed is quiet"
          subtitle="Follow a few readers and their finishes and reviews show up here."
          action={
            <Button label="Find readers to follow" variant="secondary" onPress={() => router.push('/onboarding/follow' as any)} />
          }
        />
      );
    }
    return null;
  })();

  return (
    <Screen>
      {/* Toast for swipe actions: what actually happened, with Undo when the swipe wrote something. */}
      {toast && (
        <View
          accessibilityLiveRegion="polite"
          style={[
            styles.toast,
            {
              top: insets.top + space[2],
              // Inverted neutral; the icon carries the tone, critical keeps its colour
              backgroundColor: toast.tone === 'error' ? c.critical : c.ink,
            },
          ]}
        >
          <Ionicons
            name={toast.tone === 'error' ? 'alert-circle' : toast.tone === 'info' ? 'information-circle' : 'checkmark-circle'}
            size={20}
            color={c.surface}
          />
          <Txt variant="body" color="surface" style={{ fontWeight: '500', flex: 1 }}>
            {toast.message}
          </Txt>
          {toast.undoReadId && (
            <Pressable
              onPress={() => void undoWantToRead(toast.undoReadId!)}
              accessibilityRole="button"
              accessibilityLabel="Undo"
              style={styles.toastButton}
            >
              <Txt variant="body" color="surface" style={{ fontWeight: '500' }}>
                Undo
              </Txt>
            </Pressable>
          )}
        </View>
      )}

      {/* Migration Confirmation Banner (PRD §4.2, SL-33) */}
      {migrationMessage && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: c.surface2,
            paddingHorizontal: space[4],
            paddingVertical: space[3],
            gap: space[3],
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          }}
        >
          <Ionicons name="bookmark-outline" size={18} color={c.ink2} />
          <Txt variant="body" style={{ flex: 1 }}>
            {migrationMessage}
          </Txt>
          <Pressable
            onPress={dismissMigrationMessage}
            accessibilityRole="button"
            accessibilityLabel="Dismiss confirmation"
            hitSlop={12}
          >
            <Ionicons name="close" size={20} color={c.muted} />
          </Pressable>
        </View>
      )}

      {/* Header with Title and Notifications Bell */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          backgroundColor: c.ground,
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayL">Flyleaf</Txt>
          <View style={sheet.row}>
            {user ? (
              <Pressable
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push('/notifications');
                }}
                accessibilityRole="button"
                accessibilityLabel={badge ? `Notifications, ${badge} unread` : 'Notifications'}
                style={styles.headerIconButton}
              >
                <Ionicons name="notifications-outline" size={20} color={c.ink2} />
                {badge ? (
                  <View style={[styles.badge, { backgroundColor: c.accent, borderColor: c.ground }]}>
                    <Txt variant="micro" tabular style={{ color: c.onAccent, lineHeight: 16 }}>
                      {badge}
                    </Txt>
                  </View>
                ) : null}
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push('/auth')}
                accessibilityRole="button"
                accessibilityLabel="Sign in"
                style={styles.headerIconButton}
              >
                <Txt variant="body" color="accent" style={{ fontWeight: '500' }}>
                  Sign in
                </Txt>
              </Pressable>
            )}
          </View>
        </View>

        {/* Segmented feed switcher */}
        <View style={{ marginTop: space[2] }}>
          <SegmentedControl
            values={['friends', 'popular'] as const}
            selected={tab}
            onSelect={selectTab}
            labels={{
              friends: 'Following',
              popular: 'Popular',
            }}
          />
        </View>
      </View>

      {gated ? (
        <EmptyState
          title="Follow readers to see their activity"
          subtitle="Sign in to follow friends and see what they finish and review."
          action={
            <Button label="Sign in" variant="primary" onPress={() => router.push('/auth')} />
          }
        />
      ) : (
        <FlatList<FeedActivityItem>
          data={feed.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FeedCard
              item={item}
              onWantToRead={(workId) => void handleWantToRead(workId)}
              onRateAndReview={handleRateAndReview}
            />
          )}
          ListHeaderComponent={hasHeader ? header : null}
          ListFooterComponent={footer}
          ListEmptyComponent={empty}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl refreshing={load === 'refreshing'} onRefresh={onRefresh} tintColor={c.accent} />
          }
          contentContainerStyle={{ paddingBottom: space[12] }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerIconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: space[2],
    right: 4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toast: {
    position: 'absolute',
    left: space[4],
    right: space[4],
    zIndex: 999,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  toastButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.md,
  },
  link: {
    minHeight: 44,
    justifyContent: 'center',
  },
  retryRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    borderTopWidth: 1,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  skeletonEntry: {
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: space[4],
    borderBottomWidth: 1,
  },
  end: {
    alignItems: 'center',
    gap: space[1],
    paddingVertical: space[6],
  },
});
