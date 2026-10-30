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
import { ReportSheet, type ReportTarget } from '@/ui/ReportSheet';
import { useActionGate } from '@/ui/ActionGate';
import { track } from '@/lib/events';
import { Button, Card, Cover, Screen, Stars, Txt, Skeleton, SkeletonHeader, SkeletonList } from '@/ui/components';
import { ShareShelfModal } from '@/ui/ShareShelfModal';
import { SHELF_ITEMS_PAGE } from '@/lib/shelfValidation';
import { fontFamilies, radius, space, useTheme } from '@/ui/tokens';

export default function ShelfDetailScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const { promptAuth } = useActionGate();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [items, setItems] = useState<ShelfItem[]>([]);
  // Items come a page of 100 at a time (the API's maximum); a 1,000-book
  // shelf used to stop at the first 100 (audit 11).
  const [itemsTotal, setItemsTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [shareModalVisible, setShareModalVisible] = useState(false);

  const isOwner = Boolean(user?.id && shelf?.user_id === user.id);

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      const [shelfRes, itemsRes] = await Promise.all([
        api.getShelf(id),
        api.getShelfItems(id, { limit: SHELF_ITEMS_PAGE }),
      ]);
      setShelf(shelfRes.shelf);
      setItems(itemsRes.data);
      setItemsTotal(itemsRes.total);
      setIsSaved(Boolean(shelfRes.shelf.is_saved));
      setSaveCount(shelfRes.shelf.save_count || 0);

      track('shelf_viewed', {
        shelf_id: id,
        is_ranked: shelfRes.shelf.is_ranked,
        item_count: shelfRes.shelf.item_count,
        is_owner: Boolean(user?.id && shelfRes.shelf.user_id === user.id),
      });
    } catch (err: any) {
      Alert.alert('Shelf unavailable', err?.message || 'This shelf could not be found or is private.');
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

  const loadMoreItems = async () => {
    if (!id || loadingMore) return;
    try {
      setLoadingMore(true);
      const page = await api.getShelfItems(id, { limit: SHELF_ITEMS_PAGE, offset: items.length });
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.work_id));
        return [...prev, ...page.data.filter((i) => !seen.has(i.work_id))];
      });
      setItemsTotal(page.total);
    } catch (err: any) {
      Alert.alert('Could not load more books', err?.message || 'Please try again.');
    } finally {
      setLoadingMore(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    void loadData();
  };

  const handleShare = () => {
    if (!shelf) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShareModalVisible(true);
  };

  const handleToggleSave = async () => {
    if (!shelf || !id || saving) return;
    if (!user) {
      promptAuth({ title: `Sign up to save ${shelf.name}`, subtitle: 'Saved shelves stay in your library.' });
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
      Alert.alert('Unable to update shelf', err?.message || 'Failed to save or unsave shelf.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Screen style={{ backgroundColor: c.ground, paddingTop: Math.max(insets.top, space[3]) }}>
        {/* Loading shelf: the shape of the screen, not a spinner (design.md §5) */}
        <View style={{ height: 44, paddingHorizontal: space[4], justifyContent: 'center' }}>
          <Skeleton width={24} height={24} borderRadius={radius.sm} />
        </View>
        <SkeletonHeader lead="cover" />
        <SkeletonList rows={5} lead="cover" />
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
              <Ionicons name="pencil-outline" size={22} color={c.ink} />
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
                <View style={[styles.ownerAvatar, { backgroundColor: c.surface2 }]}>
                  <Txt style={{ color: c.ink2, fontWeight: '500', fontSize: 12 }}>
                    {(shelf.owner.displayName || shelf.owner.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>
                <Txt style={[styles.ownerName, { color: c.muted }]}>
                  by <Txt style={{ color: c.ink, fontWeight: '500' }}>{shelf.owner.displayName || shelf.owner.username}</Txt>
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
            <View style={styles.badge}>
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
              <View style={styles.badge}>
                <Ionicons name="list" size={13} color={c.muted} />
                <Txt style={[styles.badgeText, { color: c.muted }]}>
                  Ranked
                </Txt>
              </View>
            )}

            {/* Item Count */}
            <View style={styles.badge}>
              <Ionicons name="book-outline" size={13} color={c.muted} />
              <Txt tabular style={[styles.badgeText, { color: c.muted }]}>
                {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
              </Txt>
            </View>

            {/* Save Count */}
            <View style={styles.badge}>
              <Ionicons name="bookmark-outline" size={13} color={c.muted} />
              <Txt tabular style={[styles.badgeText, { color: c.muted }]}>
                {saveCount} {saveCount === 1 ? 'save' : 'saves'}
              </Txt>
            </View>
          </View>

          {/* Primary Action Button (Save for visitor / Edit for owner) */}
          <View style={styles.actionButtonRow}>
            {!isOwner ? (
              <Button
                variant={isSaved ? 'secondary' : 'primary'}
                label={isSaved ? 'Saved' : 'Save shelf'}
                onPress={handleToggleSave}
                style={{ flex: 1 }}
              />
            ) : (
              <View style={{ flex: 1, flexDirection: 'row', gap: space[2] }}>
                <Button
                  variant="secondary"
                  label="Edit shelf"
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
            {user && !isOwner && (
              <Button
                variant="tertiary"
                label="Report"
                onPress={() => setReportTarget({ type: 'shelf', id: shelf.id })}
              />
            )}
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
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}
                >
                  <Ionicons name="swap-vertical" size={16} color={c.ink2} />
                  <Txt variant="caption" color="ink2" style={{ fontWeight: '500' }}>Reorder</Txt>
                </Pressable>
              )}
              <Txt variant="caption" color="muted" tabular>
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
                  ? 'Add books, and a note on why each one belongs here'
                  : 'Nothing has been added to this shelf yet'}
              </Txt>
              {isOwner && (
                <Button
                  label="Find books to add"
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
                        <View style={styles.rankPill}>
                          <Txt tabular style={[styles.rankNumber, { color: c.muted }]}>
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
                              <Txt tabular style={[styles.ratingText, { color: c.ink }]}>
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
                      <View style={[styles.noteCallout, { borderLeftColor: c.lineStrong }]}>
                        <Txt style={[styles.noteText, { color: c.ink2 }]}>
                          {item.note}
                        </Txt>
                      </View>
                    ) : null}
                  </View>
                );
              })}
              {items.length < itemsTotal && (
                <Button
                  label={loadingMore ? 'Loading…' : `Show ${itemsTotal - items.length} more`}
                  variant="secondary"
                  onPress={() => void loadMoreItems()}
                  disabled={loadingMore}
                  style={{ marginTop: space[3] }}
                />
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {shelf && (
        <ShareShelfModal
          visible={shareModalVisible}
          onClose={() => setShareModalVisible(false)}
          shelf={shelf}
        />
      )}
      <ReportSheet target={reportTarget} onClose={() => setReportTarget(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[3],
    paddingBottom: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
  },
  navTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    marginHorizontal: space[2],
  },
  navActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
    fontFamily: fontFamilies.displayMedium,
    fontSize: 24,
    lineHeight: 30,
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space[2],
  },
  ownerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space[2],
  },
  ownerName: {
    fontSize: 13,
  },
  description: {
    fontFamily: fontFamilies.displayRegular,
    fontSize: 16,
    lineHeight: 24,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space[4],
    rowGap: space[1],
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  badgeText: {
    fontSize: 13,
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
    fontWeight: '500',
  },
  emptyCard: {
    padding: space[8],
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '500',
    marginTop: space[2],
  },
  emptyDesc: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 260,
  },
  itemsList: {
    gap: space[3],
  },
  itemCard: {
    borderRadius: radius.lg,
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
    width: 28,
    alignItems: 'flex-end',
  },
  rankNumber: {
    fontSize: 15,
    fontWeight: '500',
  },
  bookInfo: {
    flex: 1,
    gap: space[1],
  },
  bookTitle: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 16,
    lineHeight: 22,
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
    gap: space[1],
  },
  ratingText: {
    fontSize: 12,
    fontWeight: '500',
  },
  metaDot: {
    fontSize: 12,
  },
  noteCallout: {
    paddingLeft: space[3],
    borderLeftWidth: 2,
    marginTop: space[1],
  },
  noteText: {
    fontFamily: fontFamilies.displayRegular,
    fontSize: 15,
    lineHeight: 22,
  },
});
