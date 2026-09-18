// Reorder Shelf Screen (SH-05, PRD §6.36, §46.2, design.md §194, §256).
//
// Features:
// - Sequential rank badges (#1..#N)
// - Step Up and Step Down arrows for instant single-position adjustments
// - Pan gesture drag handle with haptic feedback
// - "Move to Position" modal dialog as the accessible alternative to dragging
// - Quick position jump shortcuts (Top #1, Middle #mid, Bottom #N)
// - Save flow sending PUT /v1/shelves/:id/order
// - Telemetry: track('shelf_reordered', { shelf_id, count })
// - Discard confirmation on unpersisted changes

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Modal,
  PanResponder,
  PanResponderGestureState,
  Animated,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Shelf, type ShelfItem } from '@/lib/api';
import { moveItemInArray, repositionItem, formatShelfRank } from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Cover, Screen, Txt } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

interface ReorderRowProps {
  item: ShelfItem;
  index: number;
  total: number;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onOpenMoveToModal: (index: number) => void;
  onDragStep: (fromIndex: number, direction: 'up' | 'down') => void;
}

function ReorderRow({
  item,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onOpenMoveToModal,
  onDragStep,
}: ReorderRowProps) {
  const c = useTheme();
  const panY = useRef(new Animated.Value(0)).current;
  const isDragging = useRef(false);
  const dragAccumulator = useRef(0);
  const STEP_HEIGHT = 68;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dy) > 6,
      onPanResponderGrant: () => {
        isDragging.current = true;
        dragAccumulator.current = 0;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      },
      onPanResponderMove: (_, gestureState: PanResponderGestureState) => {
        panY.setValue(gestureState.dy);
        const delta = gestureState.dy - dragAccumulator.current;
        if (delta > STEP_HEIGHT) {
          dragAccumulator.current += STEP_HEIGHT;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onDragStep(index, 'down');
        } else if (delta < -STEP_HEIGHT) {
          dragAccumulator.current -= STEP_HEIGHT;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onDragStep(index, 'up');
        }
      },
      onPanResponderRelease: () => {
        isDragging.current = false;
        Animated.spring(panY, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 4,
        }).start();
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
        Animated.spring(panY, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <Animated.View
      style={[
        styles.rowCard,
        {
          backgroundColor: c.surface,
          borderColor: c.line,
          transform: [{ translateY: panY }],
        },
      ]}
    >
      {/* Rank Badge / Move to Position trigger */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Rank ${index + 1}. Tap to move to position.`}
        accessibilityHint="Opens a dialog to type a new rank number"
        hitSlop={8}
        onPress={() => onOpenMoveToModal(index)}
        style={[styles.rankBadge, { backgroundColor: c.surface2, borderColor: c.lineStrong }]}
      >
        <Txt style={[styles.rankText, { color: c.accent }]}>#{index + 1}</Txt>
        <Ionicons name="pencil" size={10} color={c.muted} style={{ marginTop: 2 }} />
      </Pressable>

      {/* Book Cover */}
      <View style={styles.coverWrapper}>
        <Cover
          coverId={item.work.cover_id}
          title={item.work.title}
          author={item.work.author_name}
          size="xs"
        />
      </View>

      {/* Book Details */}
      <View style={styles.detailsWrapper}>
        <Txt numberOfLines={1} style={[styles.bookTitle, { color: c.ink }]}>
          {item.work.title}
        </Txt>
        <Txt numberOfLines={1} style={[styles.bookAuthor, { color: c.muted }]}>
          {item.work.author_name}
        </Txt>
      </View>

      {/* Reorder Action Controls */}
      <View style={styles.rowControls}>
        {/* Step Up Button */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.work.title} up to position ${index}`}
          disabled={isFirst}
          hitSlop={6}
          onPress={() => onMoveUp(index)}
          style={[styles.stepButton, { opacity: isFirst ? 0.25 : 1 }]}
        >
          <Ionicons name="chevron-up" size={20} color={c.ink} />
        </Pressable>

        {/* Step Down Button */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.work.title} down to position ${index + 2}`}
          disabled={isLast}
          hitSlop={6}
          onPress={() => onMoveDown(index)}
          style={[styles.stepButton, { opacity: isLast ? 0.25 : 1 }]}
        >
          <Ionicons name="chevron-down" size={20} color={c.ink} />
        </Pressable>

        {/* Pan Drag Handle */}
        <View
          {...panResponder.panHandlers}
          accessibilityRole="adjustable"
          accessibilityLabel={`Drag handle for ${item.work.title}`}
          accessibilityHint="Drag up or down to reorder, or use up and down arrow buttons"
          style={styles.dragHandle}
        >
          <Ionicons name="reorder-three" size={24} color={c.muted} />
        </View>
      </View>
    </Animated.View>
  );
}

export default function ReorderShelfScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [initialOrder, setInitialOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Accessible "Move to Position" modal state (PRD §6.36, §46.2)
  const [modalVisible, setModalVisible] = useState(false);
  const [targetItemIndex, setTargetItemIndex] = useState<number | null>(null);
  const [targetPositionText, setTargetPositionText] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  const loadShelfData = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const [shelfRes, itemsRes] = await Promise.all([
        api.getShelf(id),
        api.getShelfItems(id, { limit: 200 }),
      ]);
      setShelf(shelfRes.shelf);
      setItems(itemsRes.data);
      setInitialOrder(itemsRes.data.map((it) => it.work_id));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load shelf items for reordering.');
      router.back();
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    void loadShelfData();
  }, [loadShelfData]);

  // Determine if order has changed
  const currentOrder = items.map((it) => it.work_id);
  const isDirty =
    currentOrder.length > 0 &&
    initialOrder.length > 0 &&
    currentOrder.some((workId, i) => workId !== initialOrder[i]);

  const handleMoveUp = (fromIndex: number) => {
    if (fromIndex <= 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setItems((prev) => moveItemInArray(prev, fromIndex, fromIndex - 1));
  };

  const handleMoveDown = (fromIndex: number) => {
    if (fromIndex >= items.length - 1) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setItems((prev) => moveItemInArray(prev, fromIndex, fromIndex + 1));
  };

  const handleDragStep = (fromIndex: number, direction: 'up' | 'down') => {
    if (direction === 'up' && fromIndex > 0) {
      setItems((prev) => moveItemInArray(prev, fromIndex, fromIndex - 1));
    } else if (direction === 'down' && fromIndex < items.length - 1) {
      setItems((prev) => moveItemInArray(prev, fromIndex, fromIndex + 1));
    }
  };

  const handleResetOrder = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const idMap = new Map(items.map((it) => [it.work_id, it]));
    const restored: ShelfItem[] = [];
    for (const wid of initialOrder) {
      const item = idMap.get(wid);
      if (item) restored.push(item);
    }
    setItems(restored);
  };

  // Open "Move to Position" modal dialog
  const openMoveToModal = (index: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTargetItemIndex(index);
    setTargetPositionText(String(index + 1));
    setModalError(null);
    setModalVisible(true);
  };

  const handleApplyPositionJump = (targetRank: number) => {
    if (targetItemIndex === null) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setItems((prev) => repositionItem(prev, targetItemIndex, targetRank));
    setModalVisible(false);
  };

  const handleApplyPositionInput = () => {
    if (targetItemIndex === null) return;
    const parsed = parseInt(targetPositionText, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > items.length) {
      setModalError(`Please enter a valid rank between 1 and ${items.length}.`);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setItems((prev) => repositionItem(prev, targetItemIndex, parsed));
    setModalVisible(false);
  };

  const handleSave = async () => {
    if (!id || saving || !isDirty) return;
    try {
      setSaving(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const work_ids = items.map((it) => it.work_id);
      await api.reorderShelf(id, { work_ids });
      track('shelf_reordered', { shelf_id: id, count: work_ids.length });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err: any) {
      Alert.alert('Reorder Failed', err?.message || 'Could not update shelf order. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (isDirty) {
      Alert.alert(
        'Discard Changes?',
        'You have unsaved changes to this shelf order. Are you sure you want to discard them?',
        [
          { text: 'Keep Editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => router.back() },
        ],
      );
    } else {
      router.back();
    }
  };

  if (loading) {
    return (
      <Screen style={[styles.center, { backgroundColor: c.ground }]}>
        <ActivityIndicator size="large" color={c.accent} />
        <Txt style={{ color: c.muted, marginTop: space[3] }}>Loading shelf order...</Txt>
      </Screen>
    );
  }

  const selectedItem = targetItemIndex !== null ? items[targetItemIndex] : null;

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Navigation Top Bar */}
      <View
        style={[
          styles.navBar,
          {
            paddingTop: Math.max(insets.top, space[3]),
            borderBottomColor: c.line,
            backgroundColor: c.surface,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel reordering"
          hitSlop={12}
          onPress={handleCancel}
          style={styles.navButton}
        >
          <Txt style={{ color: c.ink, fontSize: 16 }}>Cancel</Txt>
        </Pressable>

        <View style={styles.navTitleContainer}>
          <Txt numberOfLines={1} style={[styles.navTitle, { color: c.ink }]}>
            Reorder Shelf
          </Txt>
          {shelf?.name && (
            <Txt numberOfLines={1} style={{ color: c.muted, fontSize: 12 }}>
              {shelf.name}
            </Txt>
          )}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save new shelf order"
          disabled={!isDirty || saving}
          hitSlop={12}
          onPress={handleSave}
          style={[styles.navButton, { opacity: !isDirty || saving ? 0.35 : 1 }]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : (
            <Txt style={{ color: c.accent, fontSize: 16, fontWeight: '700' }}>Save</Txt>
          )}
        </Pressable>
      </View>

      {/* Instructions & Status Bar */}
      <View style={[styles.statusBar, { backgroundColor: c.surface2, borderBottomColor: c.line }]}>
        <View style={{ flex: 1 }}>
          <Txt style={[styles.statusText, { color: c.muted }]}>
            Drag handles, tap arrows, or tap{' '}
            <Txt style={{ color: c.accent, fontWeight: '600' }}>#rank</Txt> for numeric positioning.
          </Txt>
        </View>

        {isDirty && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <View style={[styles.dirtyPill, { backgroundColor: c.accentSoft }]}>
              <Txt style={[styles.dirtyPillText, { color: c.accent }]}>Unsaved changes</Txt>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reset to original order"
              hitSlop={8}
              onPress={handleResetOrder}
            >
              <Txt style={{ color: c.muted, fontSize: 12, textDecorationLine: 'underline' }}>
                Reset
              </Txt>
            </Pressable>
          </View>
        )}
      </View>

      {/* Reorderable List */}
      <ScrollView
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + space[6] },
        ]}
      >
        {items.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Txt style={{ color: c.muted }}>No books on this shelf to reorder.</Txt>
          </View>
        ) : (
          items.map((item, index) => (
            <ReorderRow
              key={item.work_id}
              item={item}
              index={index}
              total={items.length}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
              onOpenMoveToModal={openMoveToModal}
              onDragStep={handleDragStep}
            />
          ))
        )}
      </ScrollView>

      {/* Move To Position Accessible Modal (PRD §6.36, §46.2) */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setModalVisible(false)}
            accessibilityLabel="Close dialog"
          />
          <View
            style={[
              styles.modalCard,
              { backgroundColor: c.surface, borderColor: c.line },
            ]}
          >
            <View style={styles.modalHeader}>
              <Ionicons name="swap-vertical" size={22} color={c.accent} />
              <Txt style={[styles.modalTitle, { color: c.ink }]}>Move to Position</Txt>
            </View>

            {selectedItem && (
              <View style={styles.modalBookRow}>
                <Cover coverId={selectedItem.work.cover_id} size="xs" />
                <View style={{ flex: 1, marginLeft: space[3] }}>
                  <Txt numberOfLines={1} style={[styles.modalBookTitle, { color: c.ink }]}>
                    {selectedItem.work.title}
                  </Txt>
                  <Txt style={{ color: c.muted, fontSize: 13, marginTop: 2 }}>
                    Currently at rank #{targetItemIndex! + 1} of {items.length}
                  </Txt>
                </View>
              </View>
            )}

            {/* Quick jump presets */}
            <Txt style={[styles.presetLabel, { color: c.muted }]}>Quick Jump</Txt>
            <View style={styles.presetsRow}>
              <Button
                variant="outline"
                size="sm"
                label="Top (#1)"
                onPress={() => handleApplyPositionJump(1)}
                style={{ flex: 1 }}
              />
              {items.length > 2 && (
                <Button
                  variant="outline"
                  size="sm"
                  label={`Middle (#${Math.ceil(items.length / 2)})`}
                  onPress={() => handleApplyPositionJump(Math.ceil(items.length / 2))}
                  style={{ flex: 1 }}
                />
              )}
              <Button
                variant="outline"
                size="sm"
                label={`Bottom (#${items.length})`}
                onPress={() => handleApplyPositionJump(items.length)}
                style={{ flex: 1 }}
              />
            </View>

            {/* Custom rank input */}
            <Txt style={[styles.presetLabel, { color: c.muted, marginTop: space[3] }]}>
              Enter Custom Rank (1 – {items.length})
            </Txt>
            <TextInput
              keyboardType="number-pad"
              value={targetPositionText}
              onChangeText={(txt) => {
                setTargetPositionText(txt);
                setModalError(null);
              }}
              placeholder={`1..${items.length}`}
              placeholderTextColor={c.muted}
              style={[
                styles.modalInput,
                {
                  color: c.ink,
                  backgroundColor: c.surface2,
                  borderColor: modalError ? c.critical : c.line,
                },
              ]}
              autoFocus
            />

            {modalError && (
              <Txt style={{ color: c.critical, fontSize: 12, marginTop: space[1] }}>
                {modalError}
              </Txt>
            )}

            {/* Action buttons */}
            <View style={styles.modalActionRow}>
              <Button
                variant="secondary"
                label="Cancel"
                onPress={() => setModalVisible(false)}
                style={{ flex: 1 }}
              />
              <Button
                variant="primary"
                label="Move"
                onPress={handleApplyPositionInput}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
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
    paddingHorizontal: space[4],
    paddingBottom: space[3],
    borderBottomWidth: 1,
  },
  navButton: {
    minWidth: 60,
    alignItems: 'center',
  },
  navTitleContainer: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: space[2],
  },
  navTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderBottomWidth: 1,
  },
  statusText: {
    fontSize: 12,
    lineHeight: 16,
  },
  dirtyPill: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  dirtyPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  listContent: {
    padding: space[4],
    gap: space[2],
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space[8],
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
  },
  rankBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[2],
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginRight: space[3],
    minWidth: 38,
    justifyContent: 'center',
  },
  rankText: {
    fontSize: 13,
    fontWeight: '700',
    marginRight: 2,
  },
  coverWrapper: {
    marginRight: space[3],
  },
  detailsWrapper: {
    flex: 1,
    justifyContent: 'center',
    marginRight: space[2],
  },
  bookTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  bookAuthor: {
    fontSize: 12,
    marginTop: 2,
  },
  rowControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  stepButton: {
    padding: space[1],
    borderRadius: radius.sm,
  },
  dragHandle: {
    padding: space[1],
    marginLeft: space[1],
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: space[4],
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space[4],
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginBottom: space[3],
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  modalBookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: space[3],
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(128,128,128,0.2)',
    marginBottom: space[3],
  },
  modalBookTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  presetLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: space[2],
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  presetsRow: {
    flexDirection: 'row',
    gap: space[2],
    marginBottom: space[2],
  },
  modalInput: {
    height: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    fontSize: 16,
    fontWeight: '600',
  },
  modalActionRow: {
    flexDirection: 'row',
    gap: space[3],
    marginTop: space[4],
  },
});
