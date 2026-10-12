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
import {
  Card,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

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

  const header = (
    <View style={{ gap: space[3] }}>
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
        <Card style={{ backgroundColor: c.accentSoft, borderColor: c.accentSoft }}>
          <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
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
              <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
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
      return <ActivityIndicator style={{ marginVertical: space[4] }} color={c.accent} />;
    }
    if (failure === 'more') {
      return (
        <Pressable
          onPress={() => void fetchPage(tab, 'append', feed.cursor)}
          accessibilityRole="button"
          accessibilityLabel="Could not load more. Try again"
          style={[styles.retryRow, { borderColor: c.line }]}
        >
          <Ionicons name="refresh" size={18} color={c.accent} />
          <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
            Could not load more. Tap to try again.
          </Txt>
        </Pressable>
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
      // Skeleton cards on first load (§6.13).
      return (
        <View style={{ gap: space[4] }} accessibilityLabel="Loading your feed">
          {[0, 1, 2].map((k) => (
            <Card key={k}>
              <View style={[styles.skeletonLine, { width: '40%', backgroundColor: c.surface2 }]} />
              <View style={[styles.skeletonBlock, { backgroundColor: c.surface2 }]} />
            </Card>
          ))}
        </View>
      );
    }
    if (failure === 'first') {
      return (
        <Pressable
          onPress={() => void fetchPage(tab, 'replace', null)}
          accessibilityRole="button"
          accessibilityLabel="Could not load the feed. Try again"
          style={[styles.retryRow, { borderColor: c.line }]}
        >
          <Ionicons name="refresh" size={18} color={c.accent} />
          <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
            Could not load the feed. Tap to try again.
          </Txt>
        </Pressable>
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
              backgroundColor: toast.tone === 'error' ? c.critical : toast.tone === 'info' ? c.ink2 : c.accent,
              shadowColor: c.ink,
            },
          ]}
        >
          <Ionicons
            name={toast.tone === 'error' ? 'alert-circle' : toast.tone === 'info' ? 'information-circle' : 'checkmark-circle'}
            size={20}
            color={c.surface}
          />
          <Txt variant="body" color="surface" style={{ fontWeight: '600', flex: 1 }}>
            {toast.message}
          </Txt>
          {toast.undoReadId && (
            <Pressable
              onPress={() => void undoWantToRead(toast.undoReadId!)}
              accessibilityRole="button"
              accessibilityLabel="Undo"
              style={styles.toastButton}
            >
              <Txt variant="body" color="surface" style={{ fontWeight: '700' }}>
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
            backgroundColor: c.accentSoft,
            paddingHorizontal: space[4],
            paddingVertical: space[3],
            gap: space[3],
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          }}
        >
          <Ionicons name="bookmark" size={20} color={c.accent} />
          <Txt variant="body" color="accent" style={{ flex: 1, fontWeight: '500' }}>
            {migrationMessage}
          </Txt>
          <Pressable
            onPress={dismissMigrationMessage}
            accessibilityRole="button"
            accessibilityLabel="Dismiss confirmation"
            hitSlop={8}
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
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM">Flyleaf</Txt>
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
                <Ionicons name="notifications-outline" size={22} color={c.ink} />
                {badge ? (
                  <View style={[styles.badge, { backgroundColor: c.accent, borderColor: c.ground }]}>
                    <Txt variant="micro" style={{ color: c.ground, fontSize: 10, lineHeight: 12, fontWeight: '700' }}>
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
                <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                  Sign in
                </Txt>
              </Pressable>
            )}
          </View>
        </View>

        {/* Segmented feed switcher */}
        <View style={{ marginTop: space[3] }}>
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
          subtitle="Sign in to follow friends, discover book recommendations, and see reviews in your personal feed."
          action={
            <Pressable onPress={() => router.push('/auth')} accessibilityRole="button" style={styles.link}>
              <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                Sign in to Flyleaf
              </Txt>
            </Pressable>
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
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={empty}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl refreshing={load === 'refreshing'} onRefresh={onRefresh} tintColor={c.accent} />
          }
          contentContainerStyle={{
            padding: space[4],
            paddingBottom: space[12],
            gap: space[4],
          }}
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
    top: 6,
    right: 4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: radius.pill,
    borderWidth: 1.5,
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
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
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
    justifyContent: 'center',
    gap: space[2],
    borderWidth: 1,
    borderRadius: radius.md,
    marginVertical: space[2],
  },
  end: {
    alignItems: 'center',
    gap: space[1],
    paddingVertical: space[6],
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    marginBottom: space[3],
  },
  skeletonBlock: {
    height: 72,
    borderRadius: 8,
  },
});
