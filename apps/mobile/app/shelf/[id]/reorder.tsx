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
  Easing,
  View,
  ScrollView,
  Pressable,
  TextInput,
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
import { moveItemInArray, repositionItem, formatShelfRank, fetchAllShelfItems } from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Cover, EmptyState, Screen, Txt, SkeletonList, Skeleton } from '@/ui/components';
import { fontFamilies, motion, radius, space, useTheme } from '@/ui/tokens';

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
        Animated.timing(panY, {
          toValue: 0,
          duration: motion.menu,
          easing: Easing.bezier(...motion.easing),
          useNativeDriver: true,
        }).start();
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
        Animated.timing(panY, {
          toValue: 0,
          duration: motion.menu,
          easing: Easing.bezier(...motion.easing),
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
          // Opaque so a dragged row covers the rules beneath it
          backgroundColor: c.ground,
          borderBottomColor: c.line,
          transform: [{ translateY: panY }],
        },
      ]}
    >
      {/* Rank / Move to Position trigger */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Rank ${index + 1}. Tap to move to position.`}
        accessibilityHint="Opens a dialog to type a new rank number"
        hitSlop={8}
        onPress={() => onOpenMoveToModal(index)}
        style={styles.rankBadge}
      >
        <Txt variant="caption" color="ink2" tabular>#{index + 1}</Txt>
        <Ionicons name="pencil-outline" size={12} color={c.muted} />
      </Pressable>

      {/* Book Cover */}
      <Cover
        coverId={item.work.cover_id}
        title={item.work.title}
        author={item.work.author_name}
        size="xs"
      />

      {/* Book Details */}
      <View style={styles.detailsWrapper}>
        <Txt variant="title" numberOfLines={2}>
          {item.work.title}
        </Txt>
        <Txt variant="caption" color="muted" numberOfLines={1}>
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
      // Every item: the order sent back must list the whole shelf (audit 11).
      const [shelfRes, allItems] = await Promise.all([
        api.getShelf(id),
        fetchAllShelfItems((page) => api.getShelfItems(id, page)),
      ]);
      setShelf(shelfRes.shelf);
      setItems(allItems);
      setInitialOrder(allItems.map((it) => it.work_id));
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
      setModalError(`Enter a number from 1 to ${items.length}`);
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
      if (err?.code === 'order_mismatch') {
        // The shelf changed since this screen loaded (another device added or
        // removed a book). Reload rather than overwrite.
        Alert.alert('Shelf changed', 'This shelf changed while you were reordering. It has been reloaded.');
        void loadShelfData();
        return;
      }
      Alert.alert('Reorder failed', err?.message || 'Could not update shelf order. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (isDirty) {
      Alert.alert(
        'Discard changes?',
        'You have unsaved changes to this shelf order. Are you sure you want to discard them?',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => router.back() },
        ],
      );
    } else {
      router.back();
    }
  };

  if (loading) {
    return (
      <Screen style={{ backgroundColor: c.ground, paddingTop: Math.max(insets.top, space[3]) }}>
        {/* Loading shelf order: the shape of the screen, not a spinner (design.md §5) */}
        <View style={{ height: 44, paddingHorizontal: space[4], justifyContent: 'center' }}>
          <Skeleton width={24} height={24} borderRadius={radius.sm} />
        </View>
        <SkeletonList rows={7} lead="cover" />
      </Screen>
    );
  }

  const selectedItem = targetItemIndex !== null ? items[targetItemIndex] : null;

  return (
    <Screen>
      {/* Top bar: the way out on the left, the one primary action on the right */}
      <View style={[styles.navBar, { paddingTop: Math.max(insets.top, space[3]) }]}>
        <Button
          label="Cancel"
          variant="tertiary"
          accessibilityLabel="Cancel reordering"
          onPress={handleCancel}
        />
        <Button
          label="Save"
          size="sm"
          accessibilityLabel="Save new shelf order"
          disabled={!isDirty || saving}
          loading={saving}
          onPress={handleSave}
        />
      </View>

      {/* Title, instructions and status */}
      <View style={styles.header}>
        <Txt variant="displayL">Reorder</Txt>
        {shelf?.name ? (
          <Txt variant="body" color="ink2" numberOfLines={1}>
            {shelf.name}
          </Txt>
        ) : null}
        <Txt variant="caption" color="muted">
          Drag a handle, use the arrows, or tap a number to type a position
        </Txt>
        {isDirty && (
          <View style={styles.dirtyRow}>
            <Txt variant="caption" color="muted">Unsaved changes</Txt>
            <Button
              label="Reset"
              variant="tertiary"
              size="sm"
              accessibilityLabel="Reset to original order"
              onPress={handleResetOrder}
            />
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
          <EmptyState title="No books to reorder" />
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
        <View style={[styles.modalOverlay, { backgroundColor: c.overlay }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setModalVisible(false)}
            accessibilityLabel="Close dialog"
          />
          <View style={[styles.modalCard, { backgroundColor: c.surface }]}>
            <Txt variant="title">Move to position</Txt>

            {selectedItem && (
              <View style={[styles.modalBookRow, { borderBottomColor: c.line }]}>
                <Cover coverId={selectedItem.work.cover_id} size="xs" />
                <View style={{ flex: 1, gap: space[1] }}>
                  <Txt variant="title" numberOfLines={2}>
                    {selectedItem.work.title}
                  </Txt>
                  <Txt variant="caption" color="muted" tabular>
                    Now #{targetItemIndex! + 1} of {items.length}
                  </Txt>
                </View>
              </View>
            )}

            {/* Quick jump presets */}
            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="ink2">Jump to</Txt>
              <View style={styles.presetsRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  label="Top"
                  onPress={() => handleApplyPositionJump(1)}
                  style={{ flex: 1 }}
                />
                {items.length > 2 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={`Middle · ${Math.ceil(items.length / 2)}`}
                    onPress={() => handleApplyPositionJump(Math.ceil(items.length / 2))}
                    style={{ flex: 1 }}
                  />
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  label={`Bottom · ${items.length}`}
                  onPress={() => handleApplyPositionJump(items.length)}
                  style={{ flex: 1 }}
                />
              </View>
            </View>

            {/* Custom rank input: Field has no autoFocus, so this matches its label and box */}
            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="ink2">
                Position, 1 to {items.length}
              </Txt>
              <TextInput
                keyboardType="number-pad"
                value={targetPositionText}
                onChangeText={(txt) => {
                  setTargetPositionText(txt);
                  setModalError(null);
                }}
                accessibilityLabel={`Position, 1 to ${items.length}`}
                placeholder={`1..${items.length}`}
                placeholderTextColor={c.muted}
                style={[
                  styles.modalInput,
                  {
                    color: c.ink,
                    backgroundColor: c.surface,
                    borderColor: modalError ? c.critical : c.lineStrong,
                  },
                ]}
                autoFocus
              />
              {modalError && (
                <Txt variant="caption" color="critical">
                  {modalError}
                </Txt>
              )}
            </View>

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
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[2],
  },
  header: {
    paddingHorizontal: space[4],
    paddingBottom: space[3],
    gap: space[1],
  },
  dirtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listContent: {
    paddingHorizontal: space[4],
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[3],
    borderBottomWidth: 1,
  },
  rankBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    minWidth: 44,
    minHeight: 44,
  },
  detailsWrapper: {
    flex: 1,
    justifyContent: 'center',
    gap: space[1],
  },
  rowControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dragHandle: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space[4],
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space[4],
    gap: space[4],
  },
  modalBookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingBottom: space[3],
    borderBottomWidth: 1,
  },
  presetsRow: {
    flexDirection: 'row',
    gap: space[2],
  },
  modalInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    fontFamily: fontFamilies.uiMedium,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  modalActionRow: {
    flexDirection: 'row',
    gap: space[3],
  },
});
