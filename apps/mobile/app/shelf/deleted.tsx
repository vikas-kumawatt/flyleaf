// Recently deleted shelves (PRD §15.6: soft delete, 30-day recovery).
//
// Audit 11: the delete flow promised "You can restore deleted shelves within
// 30 days", but there was no endpoint and no screen. This lists the owner's
// shelves deleted in the last 30 days and restores one with a tap.

import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { api } from '@/lib/api';
import { track } from '@/lib/events';
import { Button, EmptyState, Screen, Txt, SkeletonList } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';
import { ScreenHeader } from '@/ui/ScreenHeader';

type DeletedShelf = Awaited<ReturnType<typeof api.getDeletedShelves>>['shelves'][number];

function daysLeft(purgeAfter: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - now) / 86_400_000));
}

export default function DeletedShelvesScreen() {
  const c = useTheme();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [shelves, setShelves] = useState<DeletedShelf[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getDeletedShelves();
      setShelves(res.shelves);
    } catch (err: any) {
      Alert.alert('Could not load deleted shelves', err?.message || 'Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const restore = async (shelf: DeletedShelf) => {
    if (restoring) return;
    try {
      setRestoring(shelf.id);
      await api.restoreShelf(shelf.id);
      track('shelf_restored', { shelf_id: shelf.id });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShelves((prev) => prev.filter((s) => s.id !== shelf.id));
      router.push(`/shelf/${shelf.id}` as any);
    } catch (err: any) {
      Alert.alert(
        'Could not restore shelf',
        err?.code === 'shelf_limit_reached'
          ? 'You already have 200 shelves. Delete one to make room, then restore this one.'
          : err?.message || 'Please try again.',
      );
      if (err?.status === 404) void load();
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Recently deleted" />
      <ScrollView contentContainerStyle={{ padding: space[4] }}>
        {loading && shelves.length === 0 ? (
          <SkeletonList rows={3} lead="cover" style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : shelves.length === 0 ? (
          <EmptyState
            title="Nothing deleted recently"
            subtitle="Shelves you delete can be restored here for 30 days"
          />
        ) : (
          // Ruled rows, not a card each: a page of entries
          shelves.map((shelf, index) => {
            const left = daysLeft(shelf.purge_after);
            return (
              <View
                key={shelf.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space[3],
                  paddingVertical: space[3],
                  borderTopWidth: index ? 1 : 0,
                  borderTopColor: c.line,
                }}
              >
                <View style={{ flex: 1, gap: space[1] }}>
                  <Txt variant="title" numberOfLines={2}>{shelf.name}</Txt>
                  <Txt variant="caption" color="muted" tabular>
                    {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'} · {left}{' '}
                    {left === 1 ? 'day' : 'days'} left to restore
                  </Txt>
                </View>
                <Button
                  label={restoring === shelf.id ? 'Restoring…' : 'Restore'}
                  onPress={() => void restore(shelf)}
                  disabled={restoring !== null}
                  variant="secondary"
                  size="sm"
                />
              </View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
