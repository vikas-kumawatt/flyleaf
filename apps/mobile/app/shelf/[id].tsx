// Shelf Detail Screen (SH-03, PRD §6.34, §15.2, §15.5).
//
// Features:
// - Header: title, description, owner row, privacy & ranked badges, save count
// - A strip of up to four covers (cover_ids)
// - Action row: Edit shelf (if owner), Save/Bookmark toggle (if reader), Share
// - Ranked numbering (#1, #2, #3...) when is_ranked === true
// - A ruled list of book rows with covers, authors, ratings, and log counts
// - Per-entry notes set in the serif under a rule (PRD §15.2)
// - Empty states with contextual prompts for owner vs visitor

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
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
import { Button, Cover, EmptyState, RatingMark, Screen, Txt, Skeleton, SkeletonHeader, SkeletonList } from '@/ui/components';
import { ShareShelfModal } from '@/ui/ShareShelfModal';
import { SHELF_ITEMS_PAGE } from '@/lib/shelfValidation';
import { radius, space, useTheme } from '@/ui/tokens';

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

  // Covers for the strip under the title
  const coverIds = (shelf.cover_ids || []).filter((id): id is number => id !== null);
  const ownerName = shelf.owner.displayName || shelf.owner.username;

  return (
    <Screen>
      {/* Navigation top bar: back on the left, share and edit on the right */}
      <View style={[styles.navBar, { paddingTop: Math.max(insets.top, space[3]) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={12}
          onPress={() => router.back()}
          style={styles.iconButton}
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </Pressable>

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
        {/* Shelf header: a title page, not a card */}
        <View style={styles.header}>
          <Txt variant="displayL">{shelf.name}</Txt>

          {/* A strip of covers */}
          {coverIds.length > 0 ? (
            <View style={styles.coverStrip}>
              {coverIds.slice(0, 4).map((cid, i) => (
                <Cover key={i} coverId={cid} size="s" />
              ))}
            </View>
          ) : null}

          {/* Owner row */}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`View ${ownerName}'s profile`}
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
              <Txt variant="micro" color="ink2">
                {ownerName.charAt(0).toUpperCase()}
              </Txt>
            </View>
            <Txt variant="caption" color="muted" numberOfLines={1} style={{ flex: 1 }}>
              by <Txt variant="caption" color="ink">{ownerName}</Txt>
            </Txt>
          </Pressable>

          {/* Shelf description */}
          {shelf.description ? <Txt variant="bodyL">{shelf.description}</Txt> : null}

          {/* Metadata */}
          <View style={styles.badgesRow}>
            <View style={styles.badge}>
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
                  ? 'Followers only'
                  : 'Private'}
              </Txt>
            </View>

            {shelf.is_ranked && (
              <View style={styles.badge}>
                <Ionicons name="list-outline" size={14} color={c.muted} />
                <Txt variant="caption" color="muted">
                  Ranked
                </Txt>
              </View>
            )}

            <View style={styles.badge}>
              <Ionicons name="book-outline" size={14} color={c.muted} />
              <Txt variant="caption" color="muted" tabular>
                {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
              </Txt>
            </View>

            <View style={styles.badge}>
              <Ionicons name="bookmark-outline" size={14} color={c.muted} />
              <Txt variant="caption" color="muted" tabular>
                {saveCount} {saveCount === 1 ? 'save' : 'saves'}
              </Txt>
            </View>
          </View>

          {/* One primary action: save for a visitor, edit for the owner */}
          <View style={styles.actionButtonRow}>
            {!isOwner ? (
              <Button
                variant={isSaved ? 'secondary' : 'primary'}
                label={isSaved ? 'Saved' : 'Save shelf'}
                onPress={handleToggleSave}
                style={{ flex: 1 }}
              />
            ) : (
              <>
                <Button
                  variant="primary"
                  label="Edit shelf"
                  onPress={() => router.push(`/shelf/${shelf.id}/edit` as any)}
                  style={{ flex: 1 }}
                />
                {items.length >= 2 && (
                  <Button
                    variant="secondary"
                    label="Reorder"
                    onPress={() => router.push(`/shelf/${shelf.id}/reorder` as any)}
                  />
                )}
              </>
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

        {/* Shelf books: a ruled list */}
        <View style={styles.itemsSection}>
          <View style={styles.sectionHeader}>
            <Txt variant="displayM">Books on this shelf</Txt>
            <Txt variant="caption" color="muted" tabular>
              {items.length} of {shelf.item_count}
            </Txt>
          </View>

          {items.length === 0 ? (
            <EmptyState
              title="This shelf is empty"
              subtitle={
                isOwner
                  ? 'Add books, and a note on why each one belongs here'
                  : 'Nothing has been added to this shelf yet'
              }
              action={
                isOwner ? (
                  <Button
                    label="Find books to add"
                    variant="secondary"
                    onPress={() => router.push('/(tabs)/discover' as any)}
                  />
                ) : undefined
              }
            />
          ) : (
            <View>
              {items.map((item, index) => {
                const rankNumber = shelf.is_ranked ? item.position || index + 1 : null;
                return (
                  <View
                    key={item.work_id}
                    style={[
                      styles.itemRow,
                      { borderTopWidth: index ? 1 : 0, borderTopColor: c.line },
                    ]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`View book ${item.work.title}`}
                      onPress={() => router.push(`/work/${item.work.id}` as any)}
                      style={styles.bookRow}
                    >
                      {/* Rank number if ranked shelf */}
                      {rankNumber !== null && (
                        <View style={styles.rankPill}>
                          <Txt variant="caption" color="muted" tabular>
                            #{rankNumber}
                          </Txt>
                        </View>
                      )}

                      {/* Book cover */}
                      <Cover
                        coverId={item.work.cover_id}
                        title={item.work.title}
                        author={item.work.author_name}
                        size="s"
                      />

                      {/* Book details */}
                      <View style={styles.bookInfo}>
                        <Txt variant="title" numberOfLines={2}>
                          {item.work.title}
                        </Txt>
                        <Txt variant="caption" color="muted" numberOfLines={1}>
                          {item.work.author_name}
                        </Txt>

                        <View style={styles.bookMetaRow}>
                          {item.work.rating ? <RatingMark value={item.work.rating} /> : null}
                          {item.work.first_publish_year ? (
                            <Txt variant="caption" color="muted" tabular>
                              {item.work.first_publish_year}
                            </Txt>
                          ) : null}
                          <Txt variant="caption" color="muted" tabular>
                            {item.work.log_count} {item.work.log_count === 1 ? 'log' : 'logs'}
                          </Txt>
                        </View>
                      </View>
                    </Pressable>

                    {/* Per-entry note (PRD §15.2: "The feature that turns a list into content") */}
                    {item.note ? (
                      <View style={[styles.noteCallout, { borderLeftColor: c.lineStrong }]}>
                        <Txt variant="bodyL" color="ink2">
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
                  style={{ marginTop: space[4] }}
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
    gap: space[8],
  },
  header: {
    gap: space[3],
  },
  coverStrip: {
    flexDirection: 'row',
    gap: space[2],
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 44,
  },
  ownerAvatar: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
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
    gap: space[3],
  },
  itemRow: {
    paddingVertical: space[3],
    gap: space[2],
  },
  bookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  rankPill: {
    width: 32,
    alignItems: 'flex-end',
  },
  bookInfo: {
    flex: 1,
    gap: space[1],
  },
  bookMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[1],
  },
  noteCallout: {
    paddingLeft: space[3],
    borderLeftWidth: 2,
  },
});
