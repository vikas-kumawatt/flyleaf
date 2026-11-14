// Tab 4 — Shelves (PRD §4.2, §5.2, §6.33, §15, design.md §10, SH-06).
//
// Lists and collections: Mine / Saved / Discover.
// Features:
// 1. My Shelves as ruled rows (or a two-column grid) with a strip of covers and a serif title.
// 2. Sorting options: Recently updated, Alphabetical (A–Z), and Book count.
// 3. List vs Grid display toggle.
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
import {
  Button,
  Chip,
  Cover,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
  Skeleton,
} from '@/ui/components';
import { cover, familyFor, radius, space, useTheme } from '@/ui/tokens';

/** Saved shelves per page (the API allows up to 100). */
const SAVED_PAGE = 50;

/** Starter badges come from the library in title case; the interface is sentence case. */
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** One shelf as a list or grid entry. `label` is its accessibility label. */
interface ShelfEntry {
  shelf: Shelf;
  label: string;
  curator?: string;
  showPrivacy?: boolean;
}

/** A strip of the first few covers, side by side. Nothing when the shelf has none. */
function CoverStrip({ ids, max }: { ids: Shelf['cover_ids']; max: number }) {
  const shown = (ids || []).filter((cid): cid is number => cid !== null).slice(0, max);
  if (shown.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', gap: space[1] }}>
      {shown.map((cid, i) => (
        <Cover key={i} coverId={cid} size="xs" />
      ))}
    </View>
  );
}

/** Privacy, book count, ranked and save count on one wrapping line of meta. */
function ShelfMeta({ shelf, showPrivacy }: { shelf: Shelf; showPrivacy?: boolean }) {
  const c = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: space[3],
        rowGap: space[1],
      }}
    >
      {showPrivacy ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
          <Ionicons
            name={
              shelf.privacy === 'public'
                ? 'globe-outline'
                : shelf.privacy === 'followers'
                ? 'people-outline'
                : 'lock-closed-outline'
            }
            size={14}
            color={c.muted}
          />
          <Txt variant="caption" color="muted">
            {shelf.privacy === 'public'
              ? 'Public'
              : shelf.privacy === 'followers'
              ? 'Followers'
              : 'Private'}
          </Txt>
        </View>
      ) : null}
      <Txt variant="caption" color="muted" tabular>
        {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
      </Txt>
      {shelf.is_ranked ? (
        <Txt variant="caption" color="muted">
          Ranked
        </Txt>
      ) : null}
      {shelf.save_count > 0 ? (
        <Txt variant="caption" color="muted" tabular>
          {shelf.save_count} {shelf.save_count === 1 ? 'save' : 'saves'}
        </Txt>
      ) : null}
    </View>
  );
}

/** A ruled row: serif title, who curated it, a line of meta, then the cover strip. */
function ShelfListRow({
  entry,
  index,
  onPress,
}: {
  entry: ShelfEntry;
  index: number;
  onPress: () => void;
}) {
  const c = useTheme();
  const { shelf, curator } = entry;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      style={({ pressed }) => ({
        gap: space[2],
        paddingVertical: space[4],
        borderTopWidth: index ? 1 : 0,
        borderTopColor: c.line,
        backgroundColor: pressed ? c.surface2 : 'transparent',
      })}
    >
      <Txt variant="title" numberOfLines={2}>
        {shelf.name}
      </Txt>
      {curator ? (
        <Txt variant="caption" color="ink2" numberOfLines={1}>
          by {curator}
        </Txt>
      ) : null}
      {shelf.description ? (
        <Txt variant="caption" color="muted" numberOfLines={2}>
          {shelf.description}
        </Txt>
      ) : null}
      <ShelfMeta shelf={shelf} showPrivacy={entry.showPrivacy} />
      <CoverStrip ids={shelf.cover_ids} max={6} />
    </Pressable>
  );
}

/** A grid tile: no card, a rule above it, a short cover strip and the serif title. */
function ShelfGridTile({
  entry,
  width,
  onPress,
}: {
  entry: ShelfEntry;
  width: number;
  onPress: () => void;
}) {
  const c = useTheme();
  const { shelf, curator } = entry;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      style={({ pressed }) => ({
        width,
        gap: space[2],
        paddingVertical: space[3],
        borderTopWidth: 1,
        borderTopColor: c.line,
        backgroundColor: pressed ? c.surface2 : 'transparent',
      })}
    >
      <CoverStrip ids={shelf.cover_ids} max={3} />
      <Txt variant="title" numberOfLines={2}>
        {shelf.name}
      </Txt>
      {curator ? (
        <Txt variant="caption" color="ink2" numberOfLines={1}>
          by {curator}
        </Txt>
      ) : null}
      <ShelfMeta shelf={shelf} />
    </Pressable>
  );
}

/** Loading rows shaped like the entries: title, meta, then a strip of covers. */
function ShelfSkeletons({
  label,
  grid,
  tileWidth,
}: {
  label: string;
  grid: boolean;
  tileWidth: number;
}) {
  const c = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={grid ? { flexDirection: 'row', flexWrap: 'wrap', columnGap: space[4] } : undefined}
    >
      {[0, 1, 2, 3].map((k) => (
        <View
          key={k}
          style={{
            width: grid ? tileWidth : undefined,
            gap: space[2],
            paddingVertical: grid ? space[3] : space[4],
            borderTopWidth: grid || k ? 1 : 0,
            borderTopColor: c.line,
          }}
        >
          <Skeleton width={k % 2 ? '55%' : '70%'} height={20} />
          <Skeleton width="35%" height={12} />
          <View style={{ flexDirection: 'row', gap: space[1] }}>
            {[0, 1, 2].map((j) => (
              <Skeleton
                key={j}
                width={cover.xs.width}
                height={cover.xs.height}
                borderRadius={radius.xs}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

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
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
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

  // Two-column grid width (the list is full width)
  const gridGap = space[4];
  const tileWidth = Math.floor((width - space[4] * 2 - gridGap) / 2);

  const openShelf = (id: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/shelf/${id}` as any);
  };

  const curatorOf = (shelf: Shelf) => shelf.owner.displayName || shelf.owner.username || 'Curator';

  // The same entries as ruled rows or as a grid, whichever the viewer picked
  const renderEntries = (entries: ShelfEntry[]) =>
    viewMode === 'grid' ? (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gridGap }}>
        {entries.map((entry) => (
          <ShelfGridTile
            key={entry.shelf.id}
            entry={entry}
            width={tileWidth}
            onPress={() => openShelf(entry.shelf.id)}
          />
        ))}
      </View>
    ) : (
      <View>
        {entries.map((entry, index) => (
          <ShelfListRow
            key={entry.shelf.id}
            entry={entry}
            index={index}
            onPress={() => openShelf(entry.shelf.id)}
          />
        ))}
      </View>
    );

  const viewToggle = (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        setViewMode((prev) => (prev === 'grid' ? 'list' : 'grid'));
      }}
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}
      style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Ionicons name={viewMode === 'grid' ? 'list-outline' : 'grid-outline'} size={20} color={c.ink2} />
    </Pressable>
  );

  return (
    <Screen>
      {/* Header: the segmented control draws the rule, so no border of its own */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          backgroundColor: c.ground,
          gap: space[2],
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayL">Shelves</Txt>
          <Button label="New shelf" variant="secondary" size="sm" onPress={handleNewList} />
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
              // Guest device shelf
              <View style={{ gap: space[4] }}>
                <View style={{ gap: space[2] }}>
                  <View style={[sheet.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
                    <View style={{ flex: 1 }}>
                      <Txt variant="displayM">Want to read (on this device)</Txt>
                    </View>
                    <Txt variant="micro" color="muted" tabular>
                      {guestCount} / {maxCap} saved
                    </Txt>
                  </View>
                  <Txt variant="caption" color="muted">
                    Books you save while browsing. Sign up to sync them and make your own shelves.
                  </Txt>
                </View>

                {guestCount > 0 ? (
                  <View>
                    {guestBooks.map((b, index) => (
                      <View
                        key={b.id}
                        style={[
                          sheet.row,
                          {
                            paddingVertical: space[3],
                            borderTopWidth: index ? 1 : 0,
                            borderTopColor: c.line,
                          },
                        ]}
                      >
                        <Pressable
                          onPress={() => router.push(`/work/${b.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${b.title}`}
                          style={[sheet.rowTop, { flex: 1 }]}
                        >
                          <Cover coverId={b.cover_id} title={b.title} size="s" />
                          <View style={{ flex: 1, gap: space[1] }}>
                            <Txt variant="title" numberOfLines={2}>
                              {b.title}
                            </Txt>
                            <Txt variant="caption" color="muted" numberOfLines={1}>
                              {b.author_name}
                            </Txt>
                            <Txt variant="micro" color="muted">
                              Saved {new Date(b.added_at).toLocaleDateString()}
                            </Txt>
                          </View>
                        </Pressable>
                        <Button
                          label="Remove"
                          variant="tertiary"
                          size="sm"
                          accessibilityLabel={`Remove ${b.title} from device shelf`}
                          onPress={() => void removeBook(b.id)}
                        />
                      </View>
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
              <ShelfSkeletons
                label="Loading your shelves"
                grid={viewMode === 'grid'}
                tileWidth={tileWidth}
              />
            ) : shelves.length === 0 ? (
              // Empty state with 3 Start with one of these (PRD §6.33)
              <View style={{ gap: space[6] }}>
                <View style={{ gap: space[1] }}>
                  <Txt variant="displayM">Your personal shelves</Txt>
                  <Txt variant="body" color="ink2">
                    Make lists, rank your favourites or plan a reading challenge
                  </Txt>
                </View>

                {/* Three starter shelves, ruled rows */}
                <View>
                  <View
                    style={[
                      sheet.row,
                      { justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: space[2] },
                    ]}
                  >
                    <Txt variant="title">Start with one of these</Txt>
                    <Txt variant="micro" color="muted">
                      One tap each
                    </Txt>
                  </View>
                  {STARTER_SHELVES.map((starter, index) => {
                    const isCreating = creatingStarterId === starter.id;
                    return (
                      <Pressable
                        key={starter.id}
                        onPress={() => handleCreateStarter(starter)}
                        disabled={creatingStarterId !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`Create ${starter.name} shelf`}
                        style={({ pressed }) => [
                          sheet.row,
                          {
                            gap: space[3],
                            minHeight: 64,
                            paddingVertical: space[3],
                            borderTopWidth: 1,
                            borderTopColor: c.line,
                            borderBottomWidth: index === STARTER_SHELVES.length - 1 ? 1 : 0,
                            borderBottomColor: c.line,
                            backgroundColor: pressed ? c.surface2 : 'transparent',
                          },
                        ]}
                      >
                        <Ionicons name={starter.icon as any} size={22} color={c.ink2} />
                        <View style={{ flex: 1, gap: space[1] }}>
                          <Txt variant="title" numberOfLines={2}>
                            {starter.name}
                          </Txt>
                          <Txt variant="caption" color="muted">
                            {starter.tagline}
                          </Txt>
                          <Txt variant="micro" color="muted">
                            {sentenceCase(starter.badge)} ·{' '}
                            {starter.privacy === 'public' ? 'Public shelf' : 'Private'}
                          </Txt>
                        </View>
                        {isCreating ? (
                          <ActivityIndicator size="small" color={c.muted} />
                        ) : (
                          <Txt variant="body" color="accent" style={{ fontWeight: '500' }}>
                            Create
                          </Txt>
                        )}
                      </Pressable>
                    );
                  })}
                </View>

                {/* Custom creation alternative: the one primary on this screen */}
                <Button label="Start a blank shelf" variant="primary" onPress={handleNewList} />
              </View>
            ) : (
              // Non-empty: count, sort and view toggle, then the shelves
              <View style={{ gap: space[2] }}>
                <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                  <Txt variant="caption" color="muted" tabular>
                    {shelves.length} {shelves.length === 1 ? 'shelf' : 'shelves'}
                  </Txt>
                  {viewToggle}
                </View>

                <View style={[sheet.row, { flexWrap: 'wrap', gap: space[2] }]}>
                  <Chip label="Recent" selected={sortBy === 'updated'} onPress={() => setSortBy('updated')} />
                  <Chip label="A–Z" selected={sortBy === 'alpha'} onPress={() => setSortBy('alpha')} />
                  <Chip label="Books" selected={sortBy === 'books'} onPress={() => setSortBy('books')} />
                </View>

                {renderEntries(
                  displayedShelves.map((shelf) => ({
                    shelf,
                    label: `Shelf ${shelf.name}, ${shelf.item_count} books`,
                    showPrivacy: true,
                  })),
                )}
              </View>
            )}
            {user && (
              // Deleted shelves can be restored for 30 days (PRD §15.6, audit 11).
              <Pressable
                accessibilityRole="link"
                onPress={() => router.push('/shelf/deleted' as any)}
                style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: space[3] }}
              >
                <Txt variant="caption" color="muted">Recently deleted shelves</Txt>
              </Pressable>
            )}
          </>
        )}

        {shelfFilter === 'saved' && (
          <>
            {!user ? (
              <EmptyState
                title="Save shelves you love"
                subtitle="Sign in to save lists other readers make. A saved shelf stays in sync as its curator updates it."
                action={
                  <Button
                    label="Sign in"
                    variant="primary"
                    onPress={() =>
                      promptAuth({
                        title: 'Sign in to save shelves',
                        subtitle:
                          'Keep curated reading lists from other readers bookmarked in your library.',
                      })
                    }
                  />
                }
              />
            ) : savedLoading && savedShelves.length === 0 ? (
              <ShelfSkeletons
                label="Loading saved shelves"
                grid={viewMode === 'grid'}
                tileWidth={tileWidth}
              />
            ) : savedShelves.length === 0 ? (
              <EmptyState
                title="No saved shelves yet"
                subtitle="Tap Save shelf on any list in Curated to keep it here. It stays in sync with its curator."
              />
            ) : (
              <View style={{ gap: space[2] }}>
                <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                  <Txt variant="caption" color="muted" tabular>
                    {savedTotal} {savedTotal === 1 ? 'saved shelf' : 'saved shelves'}
                  </Txt>
                  {viewToggle}
                </View>

                {renderEntries(
                  savedShelves.map((shelf) => ({
                    shelf,
                    curator: curatorOf(shelf),
                    label: `Saved shelf ${shelf.name} by ${curatorOf(shelf)}, ${shelf.item_count} books`,
                  })),
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
            {/* Search field */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: c.surface,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.lineStrong,
                paddingLeft: space[3],
                minHeight: 48,
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
                  fontFamily: familyFor(false, '400'),
                  fontSize: 15,
                  paddingVertical: 0,
                }}
              />
              {browseQuery.length > 0 && (
                <Pressable
                  onPress={() => setBrowseQuery('')}
                  accessibilityRole="button"
                  accessibilityLabel="Clear shelf search"
                  style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="close-circle" size={18} color={c.muted} />
                </Pressable>
              )}
            </View>

            {/* Sort chips and view toggle */}
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <View style={[sheet.row, { flex: 1, flexWrap: 'wrap', gap: space[2] }]}>
                <Chip label="Featured" selected={browseSort === 'ranked'} onPress={() => setBrowseSort('ranked')} />
                <Chip label="Popular" selected={browseSort === 'popular'} onPress={() => setBrowseSort('popular')} />
                <Chip label="Recent" selected={browseSort === 'recent'} onPress={() => setBrowseSort('recent')} />
              </View>
              {viewToggle}
            </View>

            {browseLoading && browseShelvesList.length === 0 ? (
              <ShelfSkeletons
                label="Loading curated shelves"
                grid={viewMode === 'grid'}
                tileWidth={tileWidth}
              />
            ) : browseShelvesList.length === 0 ? (
              <EmptyState
                title={browseQuery ? `No shelves found for "${browseQuery}"` : 'No curated shelves yet'}
                subtitle={
                  browseQuery
                    ? 'Try checking for typos or searching with different keywords.'
                    : 'Explore book club selections, award winners, and themed reading lists curated by fellow readers.'
                }
              />
            ) : (
              renderEntries(
                browseShelvesList.map((shelf) => ({
                  shelf,
                  curator: curatorOf(shelf),
                  label: `Curated shelf ${shelf.name} by ${curatorOf(shelf)}, ${shelf.item_count} books`,
                })),
              )
            )}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
