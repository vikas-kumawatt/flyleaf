// Shelf Detail Screen (SH-03, PRD §6.34, §15.2, §15.5).
//
// Features:
// - Header: title, description, owner row, privacy & ranked badges, save count
// - 4-Cover mosaic preview card (cover_ids / cover_work_ids)
// - Action row: Edit shelf (if owner), Save/Bookmark toggle (if reader), Share
// - Ranked numbering (#1, #2, #3...) when is_ranked === true
// - Book rows with covers, authors, ratings, and log counts
// - Per-entry notes displayed in styled annotation callouts with quote styling (PRD §15.2)
// - Empty states with contextual prompts for owner vs visitor

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Share,
  StyleSheet,
  Alert,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Shelf, type ShelfItem } from '@/lib/api';
import { useSession } from '@/lib/session';
import { track } from '@/lib/events';
import { Button, Card, Cover, Screen, Stars, Txt } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function ShelfDetailScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  const [saving, setSaving] = useState(false);

  const isOwner = Boolean(user?.id && shelf?.user_id === user.id);

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      const [shelfRes, itemsRes] = await Promise.all([
        api.getShelf(id),
        api.getShelfItems(id, { limit: 100 }),
      ]);
      setShelf(shelfRes.shelf);
      setItems(itemsRes.data);
      setIsSaved(Boolean(shelfRes.shelf.is_saved));
      setSaveCount(shelfRes.shelf.save_count || 0);

      track('shelf_viewed', {
        shelf_id: id,
        is_ranked: shelfRes.shelf.is_ranked,
        item_count: shelfRes.shelf.item_count,
        is_owner: Boolean(user?.id && shelfRes.shelf.user_id === user.id),
      });
    } catch (err: any) {
      Alert.alert('Shelf Unavailable', err?.message || 'This shelf could not be found or is private.');
      router.back();
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, user?.id, router]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    void loadData();
  };

  const handleShare = async () => {
    if (!shelf) return;
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      track('shelf_shared', { shelf_id: shelf.id });
      await Share.share({
        title: shelf.name,
        message: `Check out "${shelf.name}" on Flyleaf: A curated reading list by ${shelf.owner.displayName || shelf.owner.username}.`,
      });
    } catch {
      // Ignored or dismissed
    }
  };

  const handleToggleSave = async () => {
    if (!shelf || !id || saving) return;
    if (!user) {
      Alert.alert('Sign In Required', 'Please sign in to save shelves to your library.');
      return;
    }
    const prevSaved = isSaved;
    const prevCount = saveCount;
    const nextSaved = !prevSaved;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsSaved(nextSaved);
    setSaveCount((prev) => (nextSaved ? prev + 1 : Math.max(0, prev - 1)));
    setSaving(true);

    try {
      if (nextSaved) {
        const res = await api.saveShelf(shelf.id);
        setSaveCount(res.save_count);
        track('shelf_saved', { shelf_id: shelf.id });
      } else {
        const res = await api.unsaveShelf(shelf.id);
        setSaveCount(res.save_count);
        track('shelf_unsaved', { shelf_id: shelf.id });
      }
    } catch (err: any) {
      setIsSaved(prevSaved);
      setSaveCount(prevCount);
      Alert.alert('Unable to Update Shelf', err?.message || 'Failed to save or unsave shelf.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Screen style={[styles.center, { backgroundColor: c.ground }]}>
        <ActivityIndicator size="large" color={c.accent} />
        <Txt style={{ color: c.muted, marginTop: space[3] }}>Loading shelf...</Txt>
      </Screen>
    );
  }

  if (!shelf) {
    return null;
  }

  // Covers for the mosaic preview
  const coverIds = (shelf.cover_ids || []).filter((id): id is number => id !== null);

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Navigation Top Bar */}
      <View
        style={[
          styles.navBar,
          {
            paddingTop: Math.max(insets.top, space[3]),
            borderBottomColor: c.line,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={12}
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </Pressable>

        <Txt numberOfLines={1} style={[styles.navTitle, { color: c.ink }]}>
          {shelf.name}
        </Txt>

        <View style={styles.navActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share shelf"
            hitSlop={12}
            onPress={handleShare}
            style={styles.iconButton}
          >
            <Ionicons name="share-outline" size={22} color={c.ink} />
          </Pressable>
          {isOwner && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit shelf"
              hitSlop={12}
              onPress={() => router.push(`/shelf/${shelf.id}/edit` as any)}
              style={styles.iconButton}
            >
              <Ionicons name="pencil-outline" size={22} color={c.accent} />
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + space[6] }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
        }
      >
        {/* Shelf Header Banner */}
        <View style={[styles.headerCard, { backgroundColor: c.surface, borderColor: c.line }]}>
          {/* Mosaic Cover / Visual Hero */}
          <View style={styles.mosaicRow}>
            {coverIds.length >= 4 ? (
              <View style={styles.mosaicGrid}>
                {coverIds.slice(0, 4).map((cid, i) => (
                  <View key={i} style={styles.mosaicCell}>
                    <Cover coverId={cid} size="xs" />
                  </View>
                ))}
              </View>
            ) : coverIds.length > 0 ? (
              <View style={styles.mosaicSimple}>
                {coverIds.map((cid, i) => (
                  <View key={i} style={{ marginRight: -space[2], zIndex: 10 - i }}>
                    <Cover coverId={cid} size="s" />
                  </View>
                ))}
              </View>
            ) : (
              <View style={[styles.mosaicEmpty, { backgroundColor: c.surface2, borderColor: c.line }]}>
                <Ionicons name="albums-outline" size={32} color={c.muted} />
              </View>
            )}

            <View style={{ flex: 1, marginLeft: space[3], justifyContent: 'center' }}>
              <Txt style={[styles.title, { color: c.ink }]}>{shelf.name}</Txt>

              {/* Owner Row */}
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`View ${shelf.owner.displayName || shelf.owner.username}'s profile`}
                onPress={() => {
                  if (isOwner) {
                    router.push('/profile' as any);
                  } else {
                    router.push(`/user/${shelf.user_id}` as any);
                  }
                }}
                style={styles.ownerRow}
              >
                <View style={[styles.ownerAvatar, { backgroundColor: c.accentSoft }]}>
                  <Txt style={{ color: c.accent, fontWeight: '700', fontSize: 12 }}>
                    {(shelf.owner.displayName || shelf.owner.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>
                <Txt style={[styles.ownerName, { color: c.muted }]}>
                  by <Txt style={{ color: c.ink, fontWeight: '600' }}>{shelf.owner.displayName || shelf.owner.username}</Txt>
                </Txt>
              </Pressable>
            </View>
          </View>

          {/* Shelf Description */}
          {shelf.description ? (
            <Txt style={[styles.description, { color: c.ink }]}>{shelf.description}</Txt>
          ) : null}

          {/* Badges / Metadata Strip */}
          <View style={styles.badgesRow}>
            {/* Privacy Badge */}
            <View style={[styles.badge, { backgroundColor: c.surface2 }]}>
              <Ionicons
                name={
                  shelf.privacy === 'public'
                    ? 'globe-outline'
                    : shelf.privacy === 'followers'
                    ? 'people-outline'
                    : 'lock-closed-outline'
                }
                size={13}
                color={c.muted}
              />
              <Txt style={[styles.badgeText, { color: c.muted }]}>
                {shelf.privacy === 'public'
                  ? 'Public'
                  : shelf.privacy === 'followers'
                  ? 'Followers only'
                  : 'Private'}
              </Txt>
            </View>

            {/* Ranked Badge */}
            {shelf.is_ranked && (
              <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
                <Ionicons name="list" size={13} color={c.accent} />
                <Txt style={[styles.badgeText, { color: c.accent, fontWeight: '600' }]}>
                  Ranked
                </Txt>
              </View>
            )}

            {/* Item Count */}
            <View style={[styles.badge, { backgroundColor: c.surface2 }]}>
              <Ionicons name="book-outline" size={13} color={c.muted} />
              <Txt style={[styles.badgeText, { color: c.muted }]}>
                {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
              </Txt>
            </View>

            {/* Save Count */}
            <View style={[styles.badge, { backgroundColor: c.surface2 }]}>
              <Ionicons name="bookmark-outline" size={13} color={c.muted} />
              <Txt style={[styles.badgeText, { color: c.muted }]}>
                {saveCount} {saveCount === 1 ? 'save' : 'saves'}
              </Txt>
            </View>
          </View>

          {/* Primary Action Button (Save for visitor / Edit for owner) */}
          <View style={styles.actionButtonRow}>
            {!isOwner ? (
              <Button
                variant={isSaved ? 'secondary' : 'primary'}
                label={isSaved ? 'Saved to Library' : 'Save Shelf'}
                onPress={handleToggleSave}
                style={{ flex: 1 }}
              />
            ) : (
              <View style={{ flex: 1, flexDirection: 'row', gap: space[2] }}>
                <Button
                  variant="secondary"
                  label="Edit Shelf"
                  onPress={() => router.push(`/shelf/${shelf.id}/edit` as any)}
                  style={{ flex: 1 }}
                />
                {items.length >= 2 && (
                  <Button
                    variant="outline"
                    label="Reorder"
                    onPress={() => router.push(`/shelf/${shelf.id}/reorder` as any)}
                    style={{ paddingHorizontal: space[3] }}
                  />
                )}
              </View>
            )}
            <Button
              variant="outline"
              label="Share"
              onPress={handleShare}
              style={{ paddingHorizontal: space[4] }}
            />
          </View>
        </View>

        {/* Shelf Books Section */}
        <View style={styles.itemsSection}>
          <View style={styles.sectionHeader}>
            <Txt style={[styles.sectionTitle, { color: c.ink }]}>Books on this shelf</Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
              {isOwner && items.length >= 2 && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Reorder books"
                  hitSlop={8}
                  onPress={() => router.push(`/shelf/${shelf.id}/reorder` as any)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                >
                  <Ionicons name="swap-vertical" size={14} color={c.accent} />
                  <Txt style={{ color: c.accent, fontSize: 13, fontWeight: '600' }}>Reorder</Txt>
                </Pressable>
              )}
              <Txt style={{ color: c.muted, fontSize: 13 }}>
                {items.length} of {shelf.item_count}
              </Txt>
            </View>
          </View>

          {items.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: c.surface, borderColor: c.line }]}>
              <Ionicons name="book-outline" size={40} color={c.muted} />
              <Txt style={[styles.emptyTitle, { color: c.ink }]}>This shelf is empty</Txt>
              <Txt style={[styles.emptyDesc, { color: c.muted }]}>
                {isOwner
                  ? 'Add your favourite books and personal notes to curate this list.'
                  : 'The curator has not added any books to this shelf yet.'}
              </Txt>
              {isOwner && (
                <Button
                  label="Search Books to Add"
                  onPress={() => router.push('/(tabs)/discover' as any)}
                  style={{ marginTop: space[3] }}
                />
              )}
            </View>
          ) : (
            <View style={styles.itemsList}>
              {items.map((item, index) => {
                const rankNumber = shelf.is_ranked ? item.position || index + 1 : null;
                return (
                  <View
                    key={item.work_id}
                    style={[
                      styles.itemCard,
                      { backgroundColor: c.surface, borderColor: c.line },
                    ]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`View book ${item.work.title}`}
                      onPress={() => router.push(`/work/${item.work.id}` as any)}
                      style={styles.bookRow}
                    >
                      {/* Rank Number if Ranked Shelf */}
                      {rankNumber !== null && (
                        <View style={[styles.rankPill, { backgroundColor: c.surface2 }]}>
                          <Txt style={[styles.rankNumber, { color: c.ink }]}>
                            #{rankNumber}
                          </Txt>
                        </View>
                      )}

                      {/* Book Cover */}
                      <Cover coverId={item.work.cover_id} size="s" />

                      {/* Book Details */}
                      <View style={styles.bookInfo}>
                        <Txt numberOfLines={2} style={[styles.bookTitle, { color: c.ink }]}>
                          {item.work.title}
                        </Txt>
                        <Txt numberOfLines={1} style={[styles.bookAuthor, { color: c.muted }]}>
                          {item.work.author_name}
                        </Txt>

                        <View style={styles.bookMetaRow}>
                          {item.work.rating ? (
                            <View style={styles.ratingRow}>
                              <Ionicons name="star" size={13} color={c.star} />
                              <Txt style={[styles.ratingText, { color: c.ink }]}>
                                {item.work.rating.toFixed(1)}
                              </Txt>
                            </View>
                          ) : null}
                          {item.work.first_publish_year ? (
                            <Txt style={[styles.metaDot, { color: c.muted }]}>
                              {item.work.first_publish_year}
                            </Txt>
                          ) : null}
                          <Txt style={[styles.metaDot, { color: c.muted }]}>
                            {item.work.log_count} logs
                          </Txt>
                        </View>
                      </View>
                    </Pressable>

                    {/* Per-Entry Note (PRD §15.2: "The feature that turns a list into content") */}
                    {item.note ? (
                      <View style={[styles.noteCallout, { backgroundColor: c.surface2, borderColor: c.line }]}>
                        <Ionicons
                          name="chatbox-ellipses-outline"
                          size={14}
                          color={c.accent}
                          style={{ marginTop: 2, marginRight: space[2] }}
                        />
                        <Txt style={[styles.noteText, { color: c.ink }]}>
                          “{item.note}”
                        </Txt>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[3],
    paddingBottom: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    padding: space[1],
  },
  navTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginHorizontal: space[2],
  },
  navActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  iconButton: {
    padding: space[1],
  },
  scrollContent: {
    padding: space[4],
    gap: space[4],
  },
  headerCard: {
    padding: space[4],
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: space[3],
  },
  mosaicRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  mosaicGrid: {
    width: 68,
    height: 100,
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: radius.sm,
    overflow: 'hidden',
    gap: 2,
  },
  mosaicCell: {
    width: 33,
    height: 49,
    overflow: 'hidden',
  },
  mosaicSimple: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  mosaicEmpty: {
    width: 68,
    height: 100,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 26,
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space[2],
  },
  ownerAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space[2],
  },
  ownerName: {
    fontSize: 13,
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[2],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    gap: space[1],
  },
  badgeText: {
    fontSize: 12,
  },
  actionButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginTop: space[1],
  },
  itemsSection: {
    gap: space[3],
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: space[1],
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  emptyCard: {
    padding: space[8],
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: space[2],
  },
  emptyDesc: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 260,
  },
  itemsList: {
    gap: space[3],
  },
  itemCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space[3],
    gap: space[2],
  },
  bookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  rankPill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankNumber: {
    fontSize: 14,
    fontWeight: '800',
  },
  bookInfo: {
    flex: 1,
    gap: space[1],
  },
  bookTitle: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  bookAuthor: {
    fontSize: 13,
  },
  bookMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginTop: space[1],
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  ratingText: {
    fontSize: 12,
    fontWeight: '700',
  },
  metaDot: {
    fontSize: 12,
  },
  noteCallout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: space[3],
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: space[1],
  },
  noteText: {
    flex: 1,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
