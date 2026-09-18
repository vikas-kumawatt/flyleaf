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

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  ScrollView,
  Pressable,
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
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

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
  const [savedLoading, setSavedLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sortBy, setSortBy] = useState<ShelfSortOption>('updated');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [creatingStarterId, setCreatingStarterId] = useState<string | null>(null);

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
      const res = await api.getSavedShelves();
      setSavedShelves(res.shelves || []);
      track('shelves_viewed', { tab: 'saved', count: res.shelves?.length ?? 0 });
    } catch {
      // Fallback silently if network offline
    } finally {
      setSavedLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  // Reload data on screen focus
  useFocusEffect(
    useCallback(() => {
      if (user) {
        if (shelfFilter === 'mine') {
          void loadShelves();
        } else if (shelfFilter === 'saved') {
          void loadSavedShelves();
        }
      }
    }, [user, shelfFilter, loadShelves, loadSavedShelves]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    if (shelfFilter === 'mine') {
      void loadShelves();
    } else if (shelfFilter === 'saved') {
      void loadSavedShelves();
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
      Alert.alert('Could Not Create Shelf', err?.message || 'Please try again.');
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
          <Txt variant="displayM">Shelves</Txt>
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
            }
            track('shelves_viewed', {
              tab: val,
              count: val === 'mine' ? shelves.length : val === 'saved' ? savedShelves.length : 0,
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
          user ? (
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
                        backgroundColor: c.accentSoft,
                        paddingHorizontal: space[2],
                        paddingVertical: 2,
                        borderRadius: 4,
                      }}
                    >
                      <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                        {guestCount} / {maxCap} saved
                      </Txt>
                    </View>
                  </View>
                  <Txt variant="caption" color="muted" style={{ marginTop: space[1] }}>
                    Books you save while browsing. Sign up anytime to sync them across devices and
                    create custom shelves.
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
                    subtitle="Browse books in Discover or Search and tap 'Want to read' to save up to 20 books on this device."
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
              <View style={styles.centerContainer}>
                <ActivityIndicator size="large" color={c.accent} />
                <Txt style={{ color: c.muted, marginTop: space[3] }}>Loading your shelves...</Txt>
              </View>
            ) : shelves.length === 0 ? (
              // Empty State with 3 Starter Suggestions (PRD §6.33)
              <View style={{ gap: space[4] }}>
                <View style={[styles.welcomeBanner, { backgroundColor: c.surface, borderColor: c.line }]}>
                  <Ionicons name="library-outline" size={32} color={c.accent} />
                  <View style={{ flex: 1, marginLeft: space[3] }}>
                    <Txt style={[styles.welcomeTitle, { color: c.ink }]}>
                      Your personal shelves
                    </Txt>
                    <Txt style={{ color: c.muted, fontSize: 13, marginTop: 2 }}>
                      Curate custom lists, declare your all-time favorites, or organize reading challenges.
                    </Txt>
                  </View>
                </View>

                {/* Section title */}
                <View style={[sheet.row, { justifyContent: 'space-between', alignItems: 'baseline' }]}>
                  <Txt style={[styles.sectionTitle, { color: c.ink }]}>
                    Starter Suggestions
                  </Txt>
                  <Txt style={{ color: c.muted, fontSize: 12 }}>Create in 1 tap</Txt>
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
                              { backgroundColor: c.accentSoft },
                            ]}
                          >
                            <Ionicons name={starter.icon as any} size={20} color={c.accent} />
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
                                    backgroundColor: starter.is_ranked
                                      ? c.accentSoft
                                      : c.surface2,
                                  },
                                ]}
                              >
                                <Txt
                                  style={{
                                    fontSize: 11,
                                    fontWeight: '600',
                                    color: starter.is_ranked ? c.accent : c.muted,
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
                              <ActivityIndicator size="small" color={c.accent} />
                            ) : (
                              <Txt style={{ color: c.accent, fontWeight: '700', fontSize: 13 }}>
                                Tap to create →
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
                    label="Create custom shelf from scratch"
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
                  <Txt style={{ color: c.muted, fontSize: 13, fontWeight: '600' }}>
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
                          sortBy === 'updated' && { backgroundColor: c.surface },
                        ]}
                      >
                        <Txt
                          style={{
                            fontSize: 11,
                            fontWeight: sortBy === 'updated' ? '700' : '500',
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
                          sortBy === 'alpha' && { backgroundColor: c.surface },
                        ]}
                      >
                        <Txt
                          style={{
                            fontSize: 11,
                            fontWeight: sortBy === 'alpha' ? '700' : '500',
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
                          sortBy === 'books' && { backgroundColor: c.surface },
                        ]}
                      >
                        <Txt
                          style={{
                            fontSize: 11,
                            fontWeight: sortBy === 'books' ? '700' : '500',
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
                                      shadowColor: '#000',
                                      shadowOffset: { width: 0, height: 1 },
                                      shadowOpacity: 0.15,
                                      shadowRadius: 2,
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
                                <Txt style={{ color: c.muted, fontSize: 11 }}>
                                  {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                                </Txt>
                              </View>

                              {shelf.is_ranked && (
                                <View style={[styles.rankTag, { backgroundColor: c.accentSoft }]}>
                                  <Txt
                                    style={{ color: c.accent, fontSize: 10, fontWeight: '700' }}
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
                                    style={[styles.rankPill, { backgroundColor: c.accentSoft }]}
                                  >
                                    <Txt
                                      style={{ color: c.accent, fontSize: 11, fontWeight: '700' }}
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
                                  <Txt style={{ color: c.muted, fontSize: 11 }}>
                                    {shelf.privacy === 'public'
                                      ? 'Public'
                                      : shelf.privacy === 'followers'
                                      ? 'Followers'
                                      : 'Private'}
                                  </Txt>
                                </View>
                                <Txt style={{ color: c.muted, fontSize: 11 }}>
                                  {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                                </Txt>
                                {shelf.save_count > 0 && (
                                  <Txt style={{ color: c.muted, fontSize: 11 }}>
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
                    { backgroundColor: c.accentSoft, width: 48, height: 48, borderRadius: 24 },
                  ]}
                >
                  <Ionicons name="bookmark" size={24} color={c.accent} />
                </View>
                <Txt variant="title" style={{ textAlign: 'center', fontSize: 17 }}>
                  Save shelves you love
                </Txt>
                <Txt
                  variant="caption"
                  color="muted"
                  style={{ textAlign: 'center', lineHeight: 20 }}
                >
                  Sign in to bookmark curated reading lists and collections from fellow readers. Saved
                  shelves stay dynamically in sync as curators update them.
                </Txt>
                <Button
                  label="Sign in / Sign up"
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
              <View style={styles.centerContainer}>
                <ActivityIndicator size="large" color={c.accent} />
                <Txt style={{ color: c.muted, marginTop: space[3], fontSize: 13 }}>
                  Loading saved shelves...
                </Txt>
              </View>
            ) : savedShelves.length === 0 ? (
              <EmptyState
                title="No saved shelves yet"
                subtitle="Discover reading lists curated by fellow readers and tap &quot;Save Shelf&quot; to keep them in your library. They'll stay automatically in sync."
              />
            ) : (
              <View style={{ gap: space[3] }}>
                {/* Controls Bar: Count and View Mode */}
                <View style={styles.controlsBar}>
                  <Txt style={{ color: c.muted, fontSize: 13, fontWeight: '600' }}>
                    {savedShelves.length} {savedShelves.length === 1 ? 'saved shelf' : 'saved shelves'}
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
                                      shadowColor: '#000',
                                      shadowOffset: { width: 0, height: 1 },
                                      shadowOpacity: 0.15,
                                      shadowRadius: 2,
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
                                  { backgroundColor: c.accentSoft },
                                ]}
                              >
                                <Txt
                                  style={{
                                    color: c.accent,
                                    fontSize: 9,
                                    fontWeight: '700',
                                  }}
                                >
                                  {curatorName.charAt(0).toUpperCase()}
                                </Txt>
                              </View>
                              <Txt
                                numberOfLines={1}
                                style={[styles.curatorText, { color: c.muted }]}
                              >
                                by <Txt style={{ color: c.ink, fontWeight: '600' }}>{curatorName}</Txt>
                              </Txt>
                            </View>

                            <View style={styles.gridMetaRow}>
                              <Txt style={{ color: c.muted, fontSize: 11 }}>
                                {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                              </Txt>
                              {shelf.is_ranked && (
                                <View style={[styles.rankTag, { backgroundColor: c.accentSoft }]}>
                                  <Txt
                                    style={{
                                      color: c.accent,
                                      fontSize: 10,
                                      fontWeight: '700',
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
                                    style={[styles.rankPill, { backgroundColor: c.accentSoft }]}
                                  >
                                    <Txt
                                      style={{ color: c.accent, fontSize: 11, fontWeight: '700' }}
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
                                    { backgroundColor: c.accentSoft },
                                  ]}
                                >
                                  <Txt
                                    style={{
                                      color: c.accent,
                                      fontSize: 9,
                                      fontWeight: '700',
                                    }}
                                  >
                                    {curatorName.charAt(0).toUpperCase()}
                                  </Txt>
                                </View>
                                <Txt
                                  numberOfLines={1}
                                  style={[styles.curatorText, { color: c.muted }]}
                                >
                                  by <Txt style={{ color: c.ink, fontWeight: '600' }}>{curatorName}</Txt>
                                </Txt>
                              </View>

                              {shelf.description ? (
                                <Txt numberOfLines={2} style={{ color: c.muted, fontSize: 12 }}>
                                  {shelf.description}
                                </Txt>
                              ) : null}

                              <View style={[sheet.row, { gap: space[3], marginTop: 2 }]}>
                                <Txt style={{ color: c.muted, fontSize: 11 }}>
                                  {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                                </Txt>
                                <Txt style={{ color: c.muted, fontSize: 11 }}>
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
          </>
        )}

        {shelfFilter === 'discover' && (
          <EmptyState
            title="Curated reading lists"
            subtitle="Explore book club selections, award winners, and themed reading lists curated by the community."
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    paddingVertical: space[12],
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space[4],
    borderRadius: radius.md,
    borderWidth: 1,
  },
  welcomeTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  starterCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space[4],
    gap: space[3],
  },
  starterCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  starterIconBubble: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starterName: {
    fontSize: 15,
    fontWeight: '700',
  },
  starterBadge: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
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
  sortPillGroup: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    padding: 2,
  },
  sortPill: {
    paddingHorizontal: space[2],
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  viewModeButton: {
    padding: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3],
  },
  gridCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  gridMosaicContainer: {
    height: 110,
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
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 18,
  },
  gridMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space[1],
  },
  rankTag: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.sm,
  },
  listMosaic: {
    width: 54,
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
    fontWeight: '700',
    flex: 1,
    marginRight: space[2],
  },
  rankPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
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
    fontSize: 11,
    flex: 1,
  },
});
