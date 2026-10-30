// Tab 4 — Shelves (PRD §4.2, §5.2, §6.33, §15, design.md §10, SH-06).
//
// Lists and collections: Mine / Saved / Discover.
// Features:
// 1. My Shelves 2-column responsive grid with 4-cover mosaic cards.
// 2. Sorting options: Recently updated, Alphabetical (A–Z), and Book count.
// 3. Grid vs List display toggle.
// 4. Empty state with three 1-tap starter suggestions (Favourites of 2026, Comfort reads, Recommended to me).
// 5. Guest device shelf with 20-book cap and contextual signup prompts.
// 6. Pull-to-refresh and auto-refresh on screen focus.

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
  StyleSheet,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import { api, type ShelfWithWorkState, type Shelf } from '@/lib/api';
import {
  STARTER_SHELVES,
  type StarterShelfSuggestion,
  sortShelves,
  type ShelfSortOption,
} from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Card, Cover, EmptyState, Screen, SegmentedControl, Txt, sheet, Skeleton } from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

/** Saved shelves per page (the API allows up to 100). */
const SAVED_PAGE = 50;

export default function ShelvesScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { books: guestBooks, count: guestCount, maxCap, removeBook } = useGuestShelf();

  // Tab filter
  const [shelfFilter, setShelfFilter] = useState<'mine' | 'saved' | 'discover'>('mine');

  // Shelves state
  const [shelves, setShelves] = useState<ShelfWithWorkState[]>([]);
  const [loading, setLoading] = useState(false);
  const [savedShelves, setSavedShelves] = useState<Shelf[]>([]);
  // Saved shelves are paged by the API (audit 11).
  const [savedTotal, setSavedTotal] = useState(0);
  const [savedLoadingMore, setSavedLoadingMore] = useState(false);
  const [savedLoading, setSavedLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sortBy, setSortBy] = useState<ShelfSortOption>('updated');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [creatingStarterId, setCreatingStarterId] = useState<string | null>(null);

  // Curated (Public browse - SH-08) state
  const [browseShelvesList, setBrowseShelvesList] = useState<Shelf[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseQuery, setBrowseQuery] = useState('');
  const [browseSort, setBrowseSort] = useState<'ranked' | 'popular' | 'recent'>('ranked');
  const [browseTotal, setBrowseTotal] = useState(0);

  // Load authenticated user shelves
  const loadShelves = useCallback(async () => {
    if (!user) return;
    try {
      setLoading(true);
      const res = await api.getMyShelves();
      setShelves(res.shelves || []);
      track('shelves_viewed', { tab: 'mine', count: res.shelves?.length ?? 0 });
    } catch {
      // Fallback silently if network offline
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  // Load saved shelves
  const loadSavedShelves = useCallback(async () => {
    if (!user) return;
    try {
      setSavedLoading(true);
      const res = await api.getSavedShelves({ limit: SAVED_PAGE });
      setSavedShelves(res.shelves || []);
      setSavedTotal(res.total ?? res.shelves?.length ?? 0);
      track('shelves_viewed', { tab: 'saved', count: res.total ?? res.shelves?.length ?? 0 });
    } catch {
      // Fallback silently if network offline
    } finally {
      setSavedLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  const loadMoreSavedShelves = useCallback(async () => {
    if (!user || savedLoadingMore) return;
    try {
      setSavedLoadingMore(true);
      const res = await api.getSavedShelves({ limit: SAVED_PAGE, offset: savedShelves.length });
      setSavedShelves((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res.shelves || []).filter((x) => !seen.has(x.id))];
      });
      setSavedTotal(res.total ?? 0);
    } catch {
      // Keep what is shown; the button stays for a retry.
    } finally {
      setSavedLoadingMore(false);
    }
  }, [user, savedLoadingMore, savedShelves.length]);

  // Load curated public shelves (SH-08)
  const loadBrowseShelves = useCallback(
    async (queryOverride?: string, sortOverride?: 'ranked' | 'popular' | 'recent') => {
      try {
        setBrowseLoading(true);
        const q = queryOverride !== undefined ? queryOverride : browseQuery;
        const s = sortOverride !== undefined ? sortOverride : browseSort;
        const res = await api.browseShelves({
          query: q.trim().length > 0 ? q.trim() : undefined,
          sort: s,
          limit: 30,
        });
        setBrowseShelvesList(res.shelves || []);
        setBrowseTotal(res.total ?? 0);
        track('shelves_viewed', { tab: 'discover', count: res.shelves?.length ?? 0 });
      } catch {
        // Fallback silently if network offline
      } finally {
        setBrowseLoading(false);
        setRefreshing(false);
      }
    },
    [browseQuery, browseSort],
  );

  // Debounced search / filter for Curated tab
  useEffect(() => {
    if (shelfFilter !== 'discover') return;
    const timer = setTimeout(() => {
      void loadBrowseShelves(browseQuery, browseSort);
    }, 250);
    return () => clearTimeout(timer);
  }, [browseQuery, browseSort, shelfFilter, loadBrowseShelves]);

  // Reload data on screen focus
  useFocusEffect(
    useCallback(() => {
      if (shelfFilter === 'mine' && user) {
        void loadShelves();
      } else if (shelfFilter === 'saved' && user) {
        void loadSavedShelves();
      } else if (shelfFilter === 'discover') {
        void loadBrowseShelves();
      }
    }, [user, shelfFilter, loadShelves, loadSavedShelves, loadBrowseShelves]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    if (shelfFilter === 'mine') {
      void loadShelves();
    } else if (shelfFilter === 'saved') {
      void loadSavedShelves();
    } else if (shelfFilter === 'discover') {
      void loadBrowseShelves();
    } else {
      setRefreshing(false);
    }
  };

  const handleNewList = () => {
    if (!user) {
      promptAuth({
        title: 'Sign up to create custom shelves',
        subtitle:
          'Organize your personal reading into custom shelves, series lists, and reading challenges.',
      });
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/shelf/create' as any);
  };

  const handleCreateStarter = async (starter: StarterShelfSuggestion) => {
    if (!user) {
      promptAuth({
        title: 'Sign up to create custom shelves',
        subtitle: 'Start your personal library with curated shelf templates.',
      });
      return;
    }
    try {
      setCreatingStarterId(starter.id);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await api.createShelf({
        name: starter.name,
        description: starter.description,
        is_ranked: starter.is_ranked,
        privacy: starter.privacy,
      });
      track('shelf_created', {
        name: starter.name,
        is_ranked: starter.is_ranked,
        privacy: starter.privacy,
        starter: true,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(`/shelf/${res.shelf.id}` as any);
    } catch (err: any) {
      Alert.alert('Shelf not created', err?.message || 'Try again in a moment.');
    } finally {
      setCreatingStarterId(null);
    }
  };

  // Sort shelves
  const displayedShelves = useMemo(() => {
    return sortShelves(shelves, sortBy);
  }, [shelves, sortBy]);

  // Responsive Grid Calculations
  const gridGap = space[3];
  const containerPadding = space[4] * 2;
  const cardWidth = Math.floor((width - containerPadding - gridGap) / 2);

  return (
    <Screen>
      {/* Header */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[3],
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayL">Shelves</Txt>
          <Button
            label="New shelf"
            variant="secondary"
            onPress={handleNewList}
            style={{ minHeight: 36, paddingHorizontal: space[3] }}
          />
        </View>

        <SegmentedControl
          values={['mine', 'saved', 'discover'] as const}
          selected={shelfFilter}
          onSelect={(val) => {
            setShelfFilter(val);
            if (val === 'saved' && user && savedShelves.length === 0) {
              void loadSavedShelves();
            } else if (val === 'mine' && user && shelves.length === 0) {
              void loadShelves();
            } else if (val === 'discover' && browseShelvesList.length === 0) {
              void loadBrowseShelves();
            }
            track('shelves_viewed', {
              tab: val,
              count:
                val === 'mine'
                  ? shelves.length
                  : val === 'saved'
                    ? savedShelves.length
                    : browseShelvesList.length,
            });
          }}
          labels={{
            mine: 'My shelves',
            saved: 'Saved',
            discover: 'Curated',
          }}
        />
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[12],
          gap: space[4],
        }}
        refreshControl={
          user || shelfFilter === 'discover' ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
          ) : undefined
        }
      >
        {shelfFilter === 'mine' && (
          <>
            {!user ? (
              // Guest Device Shelf
              <View style={{ gap: space[4] }}>
                <Card style={{ backgroundColor: c.surface }}>
                  <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                    <Txt variant="title">Want to read (on this device)</Txt>
                    <View
                      style={{
                        paddingVertical: 2,
                      }}
                    >
                      <Txt variant="micro" color="muted" tabular>
                        {guestCount} / {maxCap} saved
                      </Txt>
                    </View>
                  </View>
                  <Txt variant="caption" color="muted" style={{ marginTop: space[1] }}>
                    Books you save while browsing. Sign up to sync them and make your own shelves.
                  </Txt>
                </Card>

                {guestCount > 0 ? (
                  <View style={{ gap: space[3] }}>
                    {guestBooks.map((b) => (
                      <Card
                        key={b.id}
                        onPress={() => router.push(`/work/${b.id}`)}
                        style={{ padding: space[3] }}
                      >
                        <View style={sheet.rowTop}>
                          <Cover coverId={b.cover_id} title={b.title} size="m" />
                          <View
                            style={{
                              flex: 1,
                              marginLeft: space[3],
                              justifyContent: 'space-between',
                            }}
                          >
                            <View style={{ gap: 2 }}>
                              <Txt variant="title" numberOfLines={1}>
                                {b.title}
                              </Txt>
                              <Txt variant="caption" color="muted">
                                {b.author_name}
                              </Txt>
                            </View>

                            <View
                              style={[
                                sheet.row,
                                { justifyContent: 'space-between', marginTop: space[2] },
                              ]}
                            >
                              <Txt variant="micro" color="muted">
                                Saved {new Date(b.added_at).toLocaleDateString()}
                              </Txt>
                              <Pressable
                                onPress={async (e) => {
                                  e.stopPropagation();
                                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  await removeBook(b.id);
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove ${b.title} from device shelf`}
                                hitSlop={8}
                              >
                                <Txt variant="caption" color="muted">
                                  Remove
                                </Txt>
                              </Pressable>
                            </View>
                          </View>
                        </View>
                      </Card>
                    ))}
                  </View>
                ) : (
                  <EmptyState
                    title="Your local shelf is empty"
                    subtitle="Tap Want to read on any book in Discover to keep up to 20 on this device."
                    action={
                      <Button
                        label="Discover books"
                        variant="primary"
                        onPress={() => router.push('/discover')}
                      />
                    }
                  />
                )}
              </View>
            ) : loading && !refreshing && shelves.length === 0 ? (
              // Loading State
              <View style={styles.gridContainer} accessible accessibilityLabel="Loading your shelves" accessibilityState={{ busy: true }}>
                {[0, 1, 2, 3].map((k) => (
                  <View key={k} style={[styles.gridCard, { width: cardWidth, backgroundColor: c.surface, borderColor: c.line }]}>
                    <Skeleton width="100%" height={112} borderRadius={0} />
                    <View style={[styles.gridDetails, { gap: space[2] }]}>
                      <Skeleton width="70%" height={14} />
                      <Skeleton width="40%" height={12} />
                    </View>
                  </View>
                ))}
              </View>
            ) : shelves.length === 0 ? (
              // Empty State with 3 Start with one of these (PRD §6.33)
              <View style={{ gap: space[4] }}>
                <View style={[styles.welcomeBanner, { backgroundColor: c.surface, borderColor: c.line }]}>
                  <Ionicons name="library-outline" size={24} color={c.ink2} />
                  <View style={{ flex: 1, marginLeft: space[3] }}>
                    <Txt style={[styles.welcomeTitle, { color: c.ink }]}>
                      Your personal shelves
                    </Txt>
                    <Txt style={{ color: c.muted, fontSize: 13, marginTop: 2 }}>
                      Make lists, rank your favourites or plan a reading challenge
                    </Txt>
                  </View>
                </View>

                {/* Section title */}
                <View style={[sheet.row, { justifyContent: 'space-between', alignItems: 'baseline' }]}>
                  <Txt style={[styles.sectionTitle, { color: c.ink }]}>
                    Start with one of these
                  </Txt>
                  <Txt style={{ color: c.muted, fontSize: 12 }}>One tap each</Txt>
                </View>

                {/* Three Starter Shelf Cards */}
                <View style={{ gap: space[3] }}>
                  {STARTER_SHELVES.map((starter) => {
                    const isCreating = creatingStarterId === starter.id;
                    return (
                      <Pressable
                        key={starter.id}
                        onPress={() => handleCreateStarter(starter)}
                        disabled={creatingStarterId !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`Create ${starter.name} shelf`}
                        style={({ pressed }) => [
                          styles.starterCard,
                          {
                            backgroundColor: c.surface,
                            borderColor: c.line,
                            opacity: pressed ? 0.85 : 1,
                          },
                        ]}
                      >
                        <View style={styles.starterCardHeader}>
                          <View
                            style={[
                              styles.starterIconBubble,
                              { backgroundColor: c.surface2 },
                            ]}
                          >
                            <Ionicons name={starter.icon as any} size={18} color={c.ink2} />
                          </View>
                          <View style={{ flex: 1, marginLeft: space[3] }}>
                            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                              <Txt style={[styles.starterName, { color: c.ink }]}>
                                {starter.name}
                              </Txt>
                              <View
                                style={[
                                  styles.starterBadge,
                                  {
                                    backgroundColor: c.surface2,
                                  },
                                ]}
                              >
                                <Txt
                                  style={{
                                    fontSize: 12,
                                    fontWeight: '500',
                                    color: c.ink2,
                                  }}
                                >
                                  {starter.badge}
                                </Txt>
                              </View>
                            </View>
                            <Txt style={{ color: c.muted, fontSize: 13, marginTop: 4 }}>
                              {starter.tagline}
                            </Txt>
                          </View>
                        </View>

                        <View style={[styles.starterCardFooter, { borderTopColor: c.line }]}>
                          <Txt style={{ color: c.muted, fontSize: 12 }}>
                            {starter.privacy === 'public' ? 'Public shelf' : 'Private'}
                          </Txt>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            {isCreating ? (
                              <ActivityIndicator size="small" color={c.muted} />
                            ) : (
                              <Txt style={{ color: c.accent, fontWeight: '500', fontSize: 13 }}>
                                Create
                              </Txt>
                            )}
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Custom creation alternative */}
                <View style={{ alignItems: 'center', marginTop: space[2] }}>
                  <Button
                    label="Start a blank shelf"
                    variant="outline"
                    onPress={handleNewList}
                    style={{ width: '100%' }}
                  />
                </View>
              </View>
            ) : (
              // Non-Empty: Shelves Grid / List
              <View style={{ gap: space[3] }}>
                {/* Controls Bar: Count, Sort, View Mode */}
                <View style={styles.controlsBar}>
                  <Txt style={{ color: c.muted, fontSize: 13, fontWeight: '500' }}>
                    {shelves.length} {shelves.length === 1 ? 'shelf' : 'shelves'}
                  </Txt>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                    {/* Sort Pills */}
                    <View style={[styles.sortPillGroup, { backgroundColor: c.surface2 }]}>
                      <Pressable
                        onPress={() => {
                          void Haptics.selectionAsync();
                          setSortBy('updated');
                        }}
                        style={[
                          styles.sortPill,
                          sortBy === 'updated' && { backgroundColor: c.surface, borderColor: c.line },
                        ]}
                      >
                        <Txt
                          style={{
                            fontSize: 12,
                            fontWeight: '500',
                            color: sortBy === 'updated' ? c.ink : c.muted,
                          }}
                        >
                          Recent
                        </Txt>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          void Haptics.selectionAsync();
                          setSortBy('alpha');
                        }}
                        style={[
                          styles.sortPill,
                          sortBy === 'alpha' && { backgroundColor: c.surface, borderColor: c.line },
                        ]}
                      >
                        <Txt
                          style={{
                            fontSize: 12,
                            fontWeight: '500',
                            color: sortBy === 'alpha' ? c.ink : c.muted,
                          }}
                        >
                          A–Z
                        </Txt>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          void Haptics.selectionAsync();
                          setSortBy('books');
                        }}
                        style={[
                          styles.sortPill,
                          sortBy === 'books' && { backgroundColor: c.surface, borderColor: c.line },
                        ]}
                      >
                        <Txt
                          style={{
                            fontSize: 12,
                            fontWeight: '500',
                            color: sortBy === 'books' ? c.ink : c.muted,
                          }}
                        >
                          Books
                        </Txt>
                      </Pressable>
                    </View>

                    {/* View Mode Toggle */}
                    <Pressable
                      onPress={() => {
                        void Haptics.selectionAsync();
                        setViewMode((prev) => (prev === 'grid' ? 'list' : 'grid'));
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}
                      hitSlop={8}
                      style={[
                        styles.viewModeButton,
                        { backgroundColor: c.surface2, borderColor: c.line },
                      ]}
                    >
                      <Ionicons
                        name={viewMode === 'grid' ? 'list-outline' : 'grid-outline'}
                        size={16}
                        color={c.ink}
                      />
                    </Pressable>
                  </View>
                </View>

                {/* Grid View */}
                {viewMode === 'grid' ? (
                  <View style={styles.gridContainer}>
                    {displayedShelves.map((shelf) => {
                      const coverIds = (shelf.cover_ids || []).filter(
                        (cid): cid is number => cid !== null,
                      );
                      return (
                        <Pressable
                          key={shelf.id}
                          onPress={() => {
                            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            router.push(`/shelf/${shelf.id}` as any);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`Shelf ${shelf.name}, ${shelf.item_count} books`}
                          style={({ pressed }) => [
                            styles.gridCard,
                            {
                              width: cardWidth,
                              backgroundColor: c.surface,
                              borderColor: c.line,
                              opacity: pressed ? 0.85 : 1,
                            },
                          ]}
                        >
                          {/* Mosaic Card Top */}
                          <View
                            style={[
                              styles.gridMosaicContainer,
                              { backgroundColor: c.surface2, borderColor: c.line },
                            ]}
                          >
                            {coverIds.length >= 4 ? (
                              <View style={styles.mosaic2x2}>
                                {coverIds.slice(0, 4).map((cid, i) => (
                                  <View key={i} style={styles.mosaic2x2Cell}>
                                    <Cover coverId={cid} size="xs" />
                                  </View>
                                ))}
                              </View>
                            ) : coverIds.length > 0 ? (
                              <View style={styles.mosaicSingleOrStack}>
                                {coverIds.map((cid, i) => (
                                  <View
                                    key={i}
                                    style={{
                                      marginRight: -space[2],
                                      zIndex: 10 - i,
                                      // Stacked covers separate with a ground-coloured edge, not a shadow
                                      borderWidth: 1,
                                      borderColor: c.ground,
                                      borderRadius: radius.xs,
                                      overflow: 'hidden',
                                    }}
                                  >
                                    <Cover coverId={cid} size="s" />
                                  </View>
                                ))}
                              </View>
                            ) : (
                              <View style={styles.mosaicEmptyCell}>
                                <Ionicons name="albums-outline" size={28} color={c.muted} />
                              </View>
                            )}
                          </View>

                          {/* Shelf Details */}
                          <View style={styles.gridDetails}>
                            <Txt numberOfLines={2} style={[styles.gridTitle, { color: c.ink }]}>
                              {shelf.name}
                            </Txt>

                            <View style={styles.gridMetaRow}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <Ionicons
                                  name={
                                    shelf.privacy === 'public'
                                      ? 'globe-outline'
                                      : shelf.privacy === 'followers'
                                      ? 'people-outline'
                                      : 'lock-closed-outline'
                                  }
                                  size={11}
                                  color={c.muted}
                                />
                                <Txt style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                                </Txt>
                              </View>

                              {shelf.is_ranked && (
                                <View style={[styles.rankTag, { backgroundColor: c.surface2 }]}>
                                  <Txt
                                    style={{ color: c.ink2, fontSize: 12, fontWeight: '500' }}
                                  >
                                    #
                                  </Txt>
                                </View>
                              )}
                            </View>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  // List View
                  <View style={{ gap: space[3] }}>
                    {displayedShelves.map((shelf) => {
                      const coverIds = (shelf.cover_ids || []).filter(
                        (cid): cid is number => cid !== null,
                      );
                      return (
                        <Card
                          key={shelf.id}
                          onPress={() => {
                            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            router.push(`/shelf/${shelf.id}` as any);
                          }}
                          style={{ padding: space[3] }}
                        >
                          <View style={sheet.rowTop}>
                            {/* Mosaic Mini-stack */}
                            <View
                              style={[
                                styles.listMosaic,
                                { backgroundColor: c.surface2, borderColor: c.line },
                              ]}
                            >
                              {coverIds.length >= 4 ? (
                                <View style={styles.listMosaicGrid}>
                                  {coverIds.slice(0, 4).map((cid, i) => (
                                    <View key={i} style={styles.listMosaicCell}>
                                      <Cover coverId={cid} size="xs" />
                                    </View>
                                  ))}
                                </View>
                              ) : coverIds.length > 0 ? (
                                <Cover coverId={coverIds[0]!} size="xs" />
                              ) : (
                                <Ionicons name="albums-outline" size={24} color={c.muted} />
                              )}
                            </View>

                            {/* Details */}
                            <View style={{ flex: 1, marginLeft: space[3], gap: 4 }}>
                              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                                <Txt
                                  numberOfLines={1}
                                  style={[styles.listTitle, { color: c.ink }]}
                                >
                                  {shelf.name}
                                </Txt>
                                {shelf.is_ranked && (
                                  <View
                                    style={[styles.rankPill, { backgroundColor: c.surface2 }]}
                                  >
                                    <Txt
                                      style={{ color: c.ink2, fontSize: 12, fontWeight: '500' }}
                                    >
                                      Ranked
                                    </Txt>
                                  </View>
                                )}
                              </View>

                              {shelf.description ? (
                                <Txt numberOfLines={2} style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.description}
                                </Txt>
                              ) : null}

                              <View style={[sheet.row, { gap: space[3], marginTop: 2 }]}>
                                <View
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                                >
                                  <Ionicons
                                    name={
                                      shelf.privacy === 'public'
                                        ? 'globe-outline'
                                        : shelf.privacy === 'followers'
                                        ? 'people-outline'
                                        : 'lock-closed-outline'
                                    }
                                    size={12}
                                    color={c.muted}
                                  />
                                  <Txt style={{ color: c.muted, fontSize: 12 }}>
                                    {shelf.privacy === 'public'
                                      ? 'Public'
                                      : shelf.privacy === 'followers'
                                      ? 'Followers'
                                      : 'Private'}
                                  </Txt>
                                </View>
                                <Txt style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                                </Txt>
                                {shelf.save_count > 0 && (
                                  <Txt style={{ color: c.muted, fontSize: 12 }}>
                                    {shelf.save_count} saves
                                  </Txt>
                                )}
                              </View>
                            </View>
                          </View>
                        </Card>
                      );
                    })}
                  </View>
                )}
              </View>
            )}
            {user && (
              // Deleted shelves can be restored for 30 days (PRD §15.6, audit 11).
              <Pressable
                accessibilityRole="link"
                onPress={() => router.push('/shelf/deleted' as any)}
                style={{ alignSelf: 'center', paddingVertical: space[3] }}
              >
                <Txt variant="caption" color="muted">Recently deleted shelves</Txt>
              </Pressable>
            )}
          </>
        )}

        {shelfFilter === 'saved' && (
          <>
            {!user ? (
              <Card
                style={{
                  backgroundColor: c.surface,
                  padding: space[4],
                  gap: space[3],
                  alignItems: 'center',
                }}
              >
                <View
                  style={[
                    styles.starterIconBubble,
                    { backgroundColor: c.surface2, width: 48, height: 48, borderRadius: 24 },
                  ]}
                >
                  <Ionicons name="bookmark-outline" size={24} color={c.ink2} />
                </View>
                <Txt variant="title" style={{ textAlign: 'center', fontSize: 17 }}>
                  Save shelves you love
                </Txt>
                <Txt
                  variant="caption"
                  color="muted"
                  style={{ textAlign: 'center', lineHeight: 20 }}
                >
                  Sign in to save lists other readers make. A saved shelf stays in sync as its curator updates it.
                </Txt>
                <Button
                  label="Sign in or sign up"
                  variant="primary"
                  onPress={() =>
                    promptAuth({
                      title: 'Sign in to save shelves',
                      subtitle:
                        'Keep curated reading lists from other readers bookmarked in your library.',
                    })
                  }
                  style={{ width: '100%', marginTop: space[2] }}
                />
              </Card>
            ) : savedLoading && savedShelves.length === 0 ? (
              <View style={styles.gridContainer} accessible accessibilityLabel="Loading saved shelves" accessibilityState={{ busy: true }}>
                {[0, 1, 2, 3].map((k) => (
                  <View key={k} style={[styles.gridCard, { width: cardWidth, backgroundColor: c.surface, borderColor: c.line }]}>
                    <Skeleton width="100%" height={112} borderRadius={0} />
                    <View style={[styles.gridDetails, { gap: space[2] }]}>
                      <Skeleton width="70%" height={14} />
                      <Skeleton width="40%" height={12} />
                    </View>
                  </View>
                ))}
              </View>
            ) : savedShelves.length === 0 ? (
              <EmptyState
                title="No saved shelves yet"
                subtitle="Tap Save shelf on any list in Curated to keep it here. It stays in sync with its curator."
              />
            ) : (
              <View style={{ gap: space[3] }}>
                {/* Controls Bar: Count and View Mode */}
                <View style={styles.controlsBar}>
                  <Txt style={{ color: c.muted, fontSize: 13, fontWeight: '500' }}>
                    {savedTotal} {savedTotal === 1 ? 'saved shelf' : 'saved shelves'}
                  </Txt>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}
                      onPress={() => {
                        void Haptics.selectionAsync();
                        setViewMode((m) => (m === 'grid' ? 'list' : 'grid'));
                      }}
                      style={[
                        styles.viewModeButton,
                        { backgroundColor: c.surface, borderColor: c.line },
                      ]}
                    >
                      <Ionicons
                        name={viewMode === 'grid' ? 'list' : 'grid-outline'}
                        size={15}
                        color={c.ink}
                      />
                    </Pressable>
                  </View>
                </View>

                {/* Saved Shelves Grid / List */}
                {viewMode === 'grid' ? (
                  <View style={styles.gridContainer}>
                    {savedShelves.map((shelf) => {
                      const coverIds = (shelf.cover_ids || []).filter(
                        (cid): cid is number => cid !== null,
                      );
                      const curatorName =
                        shelf.owner.displayName || shelf.owner.username || 'Curator';
                      return (
                        <Pressable
                          key={shelf.id}
                          onPress={() => {
                            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            router.push(`/shelf/${shelf.id}` as any);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`Saved shelf ${shelf.name} by ${curatorName}, ${shelf.item_count} books`}
                          style={({ pressed }) => [
                            styles.gridCard,
                            {
                              width: cardWidth,
                              backgroundColor: c.surface,
                              borderColor: c.line,
                              opacity: pressed ? 0.85 : 1,
                            },
                          ]}
                        >
                          {/* Mosaic Top */}
                          <View
                            style={[
                              styles.gridMosaicContainer,
                              { backgroundColor: c.surface2, borderColor: c.line },
                            ]}
                          >
                            {coverIds.length >= 4 ? (
                              <View style={styles.mosaic2x2}>
                                {coverIds.slice(0, 4).map((cid, i) => (
                                  <View key={i} style={styles.mosaic2x2Cell}>
                                    <Cover coverId={cid} size="xs" />
                                  </View>
                                ))}
                              </View>
                            ) : coverIds.length > 0 ? (
                              <View style={styles.mosaicSingleOrStack}>
                                {coverIds.map((cid, i) => (
                                  <View
                                    key={i}
                                    style={{
                                      marginRight: -space[2],
                                      zIndex: 10 - i,
                                      // Stacked covers separate with a ground-coloured edge, not a shadow
                                      borderWidth: 1,
                                      borderColor: c.ground,
                                      borderRadius: radius.xs,
                                      overflow: 'hidden',
                                    }}
                                  >
                                    <Cover coverId={cid} size="s" />
                                  </View>
                                ))}
                              </View>
                            ) : (
                              <View style={styles.mosaicEmptyCell}>
                                <Ionicons name="albums-outline" size={28} color={c.muted} />
                              </View>
                            )}
                          </View>

                          {/* Shelf Details */}
                          <View style={styles.gridDetails}>
                            <Txt numberOfLines={2} style={[styles.gridTitle, { color: c.ink }]}>
                              {shelf.name}
                            </Txt>

                            {/* Curator attribution */}
                            <View style={styles.curatorRow}>
                              <View
                                style={[
                                  styles.curatorAvatar,
                                  { backgroundColor: c.surface2 },
                                ]}
                              >
                                <Txt
                                  style={{
                                    color: c.ink2,
                                    fontSize: 12,
                                    fontWeight: '500',
                                  }}
                                >
                                  {curatorName.charAt(0).toUpperCase()}
                                </Txt>
                              </View>
                              <Txt
                                numberOfLines={1}
                                style={[styles.curatorText, { color: c.muted }]}
                              >
                                by <Txt style={{ color: c.ink, fontWeight: '500' }}>{curatorName}</Txt>
                              </Txt>
                            </View>

                            <View style={styles.gridMetaRow}>
                              <Txt style={{ color: c.muted, fontSize: 12 }}>
                                {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                              </Txt>
                              {shelf.is_ranked && (
                                <View style={[styles.rankTag, { backgroundColor: c.surface2 }]}>
                                  <Txt
                                    style={{
                                      color: c.ink2,
                                      fontSize: 12,
                                      fontWeight: '500',
                                    }}
                                  >
                                    Ranked
                                  </Txt>
                                </View>
                              )}
                            </View>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <View style={{ gap: space[3] }}>
                    {savedShelves.map((shelf) => {
                      const coverIds = (shelf.cover_ids || []).filter(
                        (cid): cid is number => cid !== null,
                      );
                      const curatorName =
                        shelf.owner.displayName || shelf.owner.username || 'Curator';
                      return (
                        <Card
                          key={shelf.id}
                          onPress={() => {
                            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            router.push(`/shelf/${shelf.id}` as any);
                          }}
                          style={{ padding: space[3] }}
                        >
                          <View style={sheet.rowTop}>
                            {/* Mosaic preview */}
                            <View
                              style={[
                                styles.listMosaic,
                                { backgroundColor: c.surface2, borderColor: c.line },
                              ]}
                            >
                              {coverIds.length >= 4 ? (
                                <View style={styles.listMosaicGrid}>
                                  {coverIds.slice(0, 4).map((cid, i) => (
                                    <View key={i} style={styles.listMosaicCell}>
                                      <Cover coverId={cid} size="xs" />
                                    </View>
                                  ))}
                                </View>
                              ) : coverIds.length > 0 ? (
                                <Cover coverId={coverIds[0]} size="s" />
                              ) : (
                                <Ionicons name="albums-outline" size={24} color={c.muted} />
                              )}
                            </View>

                            {/* Details */}
                            <View style={{ flex: 1, marginLeft: space[3], gap: 4 }}>
                              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                                <Txt
                                  numberOfLines={1}
                                  style={[styles.listTitle, { color: c.ink }]}
                                >
                                  {shelf.name}
                                </Txt>
                                {shelf.is_ranked && (
                                  <View
                                    style={[styles.rankPill, { backgroundColor: c.surface2 }]}
                                  >
                                    <Txt
                                      style={{ color: c.ink2, fontSize: 12, fontWeight: '500' }}
                                    >
                                      Ranked
                                    </Txt>
                                  </View>
                                )}
                              </View>

                              {/* Curator attribution */}
                              <View style={styles.curatorRow}>
                                <View
                                  style={[
                                    styles.curatorAvatar,
                                    { backgroundColor: c.surface2 },
                                  ]}
                                >
                                  <Txt
                                    style={{
                                      color: c.ink2,
                                      fontSize: 12,
                                      fontWeight: '500',
                                    }}
                                  >
                                    {curatorName.charAt(0).toUpperCase()}
                                  </Txt>
                                </View>
                                <Txt
                                  numberOfLines={1}
                                  style={[styles.curatorText, { color: c.muted }]}
                                >
                                  by <Txt style={{ color: c.ink, fontWeight: '500' }}>{curatorName}</Txt>
                                </Txt>
                              </View>

                              {shelf.description ? (
                                <Txt numberOfLines={2} style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.description}
                                </Txt>
                              ) : null}

                              <View style={[sheet.row, { gap: space[3], marginTop: 2 }]}>
                                <Txt style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                                </Txt>
                                <Txt style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.save_count} {shelf.save_count === 1 ? 'save' : 'saves'}
                                </Txt>
                              </View>
                            </View>
                          </View>
                        </Card>
                      );
                    })}
                  </View>
                )}
                {savedShelves.length < savedTotal && (
                  <Button
                    label={savedLoadingMore ? 'Loading…' : 'Show more saved shelves'}
                    onPress={() => void loadMoreSavedShelves()}
                    disabled={savedLoadingMore}
                    variant="secondary"
                  />
                )}
              </View>
            )}
          </>
        )}

        {shelfFilter === 'discover' && (
          <View style={{ gap: space[3] }}>
            {/* Search Bar */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: c.surface,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                paddingHorizontal: space[3],
                height: 44,
              }}
            >
              <Ionicons
                name="search-outline"
                size={18}
                color={browseLoading ? c.accent : c.muted}
                style={{ marginRight: space[2] }}
              />
              <TextInput
                value={browseQuery}
                onChangeText={setBrowseQuery}
                placeholder="Search shelves"
                placeholderTextColor={c.muted}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                accessibilityLabel="Search curated shelves"
                style={{
                  flex: 1,
                  color: c.ink,
                  fontSize: 13,
                  paddingVertical: 0,
                }}
              />
              {browseQuery.length > 0 && (
                <Pressable
                  onPress={() => setBrowseQuery('')}
                  accessibilityRole="button"
                  accessibilityLabel="Clear shelf search"
                  hitSlop={8}
                >
                  <Ionicons name="close-circle" size={16} color={c.muted} />
                </Pressable>
              )}
            </View>

            {/* Controls Bar: Sort Pills & View Mode */}
            <View style={styles.controlsBar}>
              {/* Sort Pills */}
              <View style={[styles.sortPillGroup, { backgroundColor: c.surface2 }]}>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setBrowseSort('ranked');
                  }}
                  style={[
                    styles.sortPill,
                    browseSort === 'ranked' && { backgroundColor: c.surface, borderColor: c.line },
                  ]}
                >
                  <Txt
                    style={{
                      fontSize: 12,
                      fontWeight: browseSort === 'ranked' ? '500' : '500',
                      color: browseSort === 'ranked' ? c.ink : c.muted,
                    }}
                  >
                    Featured
                  </Txt>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setBrowseSort('popular');
                  }}
                  style={[
                    styles.sortPill,
                    browseSort === 'popular' && { backgroundColor: c.surface, borderColor: c.line },
                  ]}
                >
                  <Txt
                    style={{
                      fontSize: 12,
                      fontWeight: browseSort === 'popular' ? '500' : '500',
                      color: browseSort === 'popular' ? c.ink : c.muted,
                    }}
                  >
                    Popular
                  </Txt>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setBrowseSort('recent');
                  }}
                  style={[
                    styles.sortPill,
                    browseSort === 'recent' && { backgroundColor: c.surface, borderColor: c.line },
                  ]}
                >
                  <Txt
                    style={{
                      fontSize: 12,
                      fontWeight: browseSort === 'recent' ? '500' : '500',
                      color: browseSort === 'recent' ? c.ink : c.muted,
                    }}
                  >
                    Recent
                  </Txt>
                </Pressable>
              </View>

              {/* View Mode Toggle */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setViewMode((m) => (m === 'grid' ? 'list' : 'grid'));
                }}
                style={[
                  styles.viewModeButton,
                  { backgroundColor: c.surface, borderColor: c.line },
                ]}
              >
                <Ionicons
                  name={viewMode === 'grid' ? 'list' : 'grid-outline'}
                  size={15}
                  color={c.ink}
                />
              </Pressable>
            </View>

            {browseLoading && browseShelvesList.length === 0 ? (
              <View style={styles.gridContainer} accessible accessibilityLabel="Loading curated shelves" accessibilityState={{ busy: true }}>
                {[0, 1, 2, 3].map((k) => (
                  <View key={k} style={[styles.gridCard, { width: cardWidth, backgroundColor: c.surface, borderColor: c.line }]}>
                    <Skeleton width="100%" height={112} borderRadius={0} />
                    <View style={[styles.gridDetails, { gap: space[2] }]}>
                      <Skeleton width="70%" height={14} />
                      <Skeleton width="40%" height={12} />
                    </View>
                  </View>
                ))}
              </View>
            ) : browseShelvesList.length === 0 ? (
              <EmptyState
                title={browseQuery ? `No shelves found for "${browseQuery}"` : 'No curated shelves yet'}
                subtitle={
                  browseQuery
                    ? 'Try checking for typos or searching with different keywords.'
                    : 'Explore book club selections, award winners, and themed reading lists curated by fellow readers.'
                }
              />
            ) : viewMode === 'grid' ? (
              <View style={styles.gridContainer}>
                {browseShelvesList.map((shelf) => {
                  const coverIds = (shelf.cover_ids || []).filter(
                    (cid): cid is number => cid !== null,
                  );
                  const curatorName =
                    shelf.owner.displayName || shelf.owner.username || 'Curator';

                  return (
                    <Pressable
                      key={shelf.id}
                      onPress={() => {
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        router.push(`/shelf/${shelf.id}` as any);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Curated shelf ${shelf.name} by ${curatorName}, ${shelf.item_count} books`}
                      style={({ pressed }) => [
                        styles.gridCard,
                        {
                          width: cardWidth,
                          backgroundColor: c.surface,
                          borderColor: c.line,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      {/* Mosaic Card Top */}
                      <View
                        style={[
                          styles.gridMosaicContainer,
                          { backgroundColor: c.surface2, borderColor: c.line },
                        ]}
                      >
                        {coverIds.length >= 4 ? (
                          <View style={styles.mosaic2x2}>
                            {coverIds.slice(0, 4).map((cid, i) => (
                              <View key={i} style={styles.mosaic2x2Cell}>
                                <Cover coverId={cid} size="xs" />
                              </View>
                            ))}
                          </View>
                        ) : coverIds.length > 0 ? (
                          <View style={styles.mosaicSingleOrStack}>
                            {coverIds.map((cid, i) => (
                              <View
                                key={i}
                                style={{
                                  marginRight: -space[2],
                                  zIndex: 10 - i,
                                  // Stacked covers separate with a ground-coloured edge, not a shadow
                                  borderWidth: 1,
                                  borderColor: c.ground,
                                  borderRadius: radius.xs,
                                  overflow: 'hidden',
                                }}
                              >
                                <Cover coverId={cid} size="s" />
                              </View>
                            ))}
                          </View>
                        ) : (
                          <View style={styles.mosaicEmptyCell}>
                            <Ionicons name="albums-outline" size={28} color={c.muted} />
                          </View>
                        )}
                      </View>

                      {/* Shelf Details */}
                      <View style={styles.gridDetails}>
                        <Txt numberOfLines={2} style={[styles.gridTitle, { color: c.ink }]}>
                          {shelf.name}
                        </Txt>

                        {/* Curator attribution */}
                        <View style={styles.curatorRow}>
                          <View
                            style={[
                              styles.curatorAvatar,
                              { backgroundColor: c.surface2 },
                            ]}
                          >
                            <Txt
                              style={{
                                color: c.ink2,
                                fontSize: 12,
                                fontWeight: '500',
                              }}
                            >
                              {curatorName.charAt(0).toUpperCase()}
                            </Txt>
                          </View>
                          <Txt
                            numberOfLines={1}
                            style={[styles.curatorText, { color: c.muted }]}
                          >
                            by <Txt style={{ color: c.ink, fontWeight: '500' }}>{curatorName}</Txt>
                          </Txt>
                        </View>

                        <View style={styles.gridMetaRow}>
                          <Txt style={{ color: c.muted, fontSize: 12 }}>
                            {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                          </Txt>
                          {shelf.is_ranked ? (
                            <View style={[styles.rankTag, { backgroundColor: c.surface2 }]}>
                              <Txt
                                style={{
                                  color: c.ink2,
                                  fontSize: 12,
                                  fontWeight: '500',
                                }}
                              >
                                Ranked
                              </Txt>
                            </View>
                          ) : shelf.save_count > 0 ? (
                            <Txt style={{ color: c.muted, fontSize: 12 }}>
                              {shelf.save_count} {shelf.save_count === 1 ? 'save' : 'saves'}
                            </Txt>
                          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <View style={{ gap: space[3] }}>
                {browseShelvesList.map((shelf) => {
                  const coverIds = (shelf.cover_ids || []).filter(
                    (cid): cid is number => cid !== null,
                  );
                  const curatorName =
                    shelf.owner.displayName || shelf.owner.username || 'Curator';

                  return (
                    <Card
                      key={shelf.id}
                      onPress={() => {
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        router.push(`/shelf/${shelf.id}` as any);
                      }}
                      style={{ padding: space[3] }}
                    >
                      <View style={sheet.rowTop}>
                        {/* Left mosaic thumbnail */}
                        <View
                          style={[
                            styles.listMosaic,
                            { backgroundColor: c.surface2, borderColor: c.line },
                          ]}
                        >
                          {coverIds.length >= 4 ? (
                            <View style={styles.listMosaicGrid}>
                              {coverIds.slice(0, 4).map((cid, i) => (
                                <View key={i} style={styles.listMosaicCell}>
                                  <Cover coverId={cid} size="xs" />
                                </View>
                              ))}
                            </View>
                          ) : coverIds.length > 0 ? (
                            <Cover coverId={coverIds[0]} size="s" />
                          ) : (
                            <Ionicons name="albums-outline" size={24} color={c.muted} />
                          )}
                        </View>

                        {/* Right details */}
                        <View
                          style={{
                            flex: 1,
                            marginLeft: space[3],
                            justifyContent: 'space-between',
                          }}
                        >
                          <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                            <Txt
                              numberOfLines={1}
                              style={[styles.listTitle, { color: c.ink }]}
                            >
                              {shelf.name}
                            </Txt>
                            {shelf.is_ranked && (
                              <View
                                style={[styles.rankPill, { backgroundColor: c.surface2 }]}
                              >
                                <Txt
                                  style={{ color: c.ink2, fontSize: 12, fontWeight: '500' }}
                                >
                                  Ranked
                                </Txt>
                              </View>
                            )}
                          </View>

                          {/* Curator attribution */}
                          <View style={styles.curatorRow}>
                            <View
                              style={[
                                styles.curatorAvatar,
                                { backgroundColor: c.surface2 },
                              ]}
                            >
                              <Txt
                                style={{
                                  color: c.ink2,
                                  fontSize: 12,
                                  fontWeight: '500',
                                }}
                              >
                                {curatorName.charAt(0).toUpperCase()}
                              </Txt>
                            </View>
                            <Txt
                              numberOfLines={1}
                              style={[styles.curatorText, { color: c.muted }]}
                            >
                              by <Txt style={{ color: c.ink, fontWeight: '500' }}>{curatorName}</Txt>
                            </Txt>
                          </View>

                          {shelf.description ? (
                            <Txt numberOfLines={2} style={{ color: c.muted, fontSize: 12 }}>
                              {shelf.description}
                            </Txt>
                          ) : null}

                          <View style={[sheet.row, { gap: space[3], marginTop: 2 }]}>
                            <Txt style={{ color: c.muted, fontSize: 12 }}>
                              {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                            </Txt>
                            <Txt style={{ color: c.muted, fontSize: 12 }}>
                              {shelf.save_count} {shelf.save_count === 1 ? 'save' : 'saves'}
                            </Txt>
                          </View>
                        </View>
                      </View>
                    </Card>
                  );
                })}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  welcomeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space[4],
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  welcomeTitle: {
    fontSize: 15,
    fontWeight: '500',
  },
  sectionTitle: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '500',
  },
  starterCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space[4],
    gap: space[3],
  },
  starterCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  starterIconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starterName: {
    fontSize: 15,
    fontWeight: '500',
  },
  starterBadge: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.xs,
  },
  starterCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: space[2],
    borderTopWidth: 1,
  },
  controlsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space[1],
  },
  // Segmented: surface2 track, surface thumb with a hairline
  sortPillGroup: {
    flexDirection: 'row',
    borderRadius: radius.md,
    padding: 2,
  },
  sortPill: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  viewModeButton: {
    padding: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3],
  },
  gridCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  gridMosaicContainer: {
    height: 112,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 1,
    overflow: 'hidden',
  },
  mosaic2x2: {
    width: 68,
    height: 100,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  mosaic2x2Cell: {
    width: 33,
    height: 49,
    overflow: 'hidden',
  },
  mosaicSingleOrStack: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mosaicEmptyCell: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridDetails: {
    padding: space[3],
    gap: space[1],
  },
  gridTitle: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  gridMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space[1],
  },
  rankTag: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: radius.xs,
  },
  listMosaic: {
    width: 56,
    height: 80,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  listMosaicGrid: {
    width: 50,
    height: 74,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 1,
    overflow: 'hidden',
  },
  listMosaicCell: {
    width: 24,
    height: 36,
    overflow: 'hidden',
  },
  listTitle: {
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
    marginRight: space[2],
  },
  rankPill: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.xs,
  },
  curatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginVertical: 2,
  },
  curatorAvatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  curatorText: {
    fontSize: 12,
    flex: 1,
  },
});
