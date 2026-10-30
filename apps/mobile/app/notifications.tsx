// Notification centre (SO-33; PRD §6.14).
//
// Bell on Home → here. Grouped Today / This week / Earlier, unread dot,
// per-row avatar and text, mark-all-read. A tap marks the row read and opens
// its screen on top of this one (this screen is already Home → Notifications,
// so back comes here). Pushes open through src/ui/PushBridge.tsx instead,
// which synthesises the whole back stack.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { api, type NotificationItem } from '@/lib/api';
import { track } from '@/lib/events';
import { useSession } from '@/lib/session';
import {
  markLocallyRead,
  mergePages,
  notificationRows,
  targetOf,
  type NotificationRow,
} from '@/lib/notifications';
import { enablePush, pushPermissionGranted } from '@/lib/push';
import { EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

const PAGE = 30;

function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function NotificationsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [pushOff, setPushOff] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api.getNotifications({ limit: PAGE });
      setItems(page.items);
      setCursor(page.next_cursor);
      setUnread(page.unread_count);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
    track('notifications_viewed', {});
    void pushPermissionGranted().then((granted) => setPushOff(!granted));
  }, [user, load]);

  // Coming back from a notification's screen: refresh quietly.
  useFocusEffect(
    useCallback(() => {
      if (user && !loading) void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]),
  );

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.getNotifications({ cursor, limit: PAGE });
      setItems((prev) => mergePages(prev, page.items));
      setCursor(page.next_cursor);
      setUnread(page.unread_count);
    } catch {
      // The next scroll tries again.
    } finally {
      setLoadingMore(false);
    }
  };

  const markAllRead = async () => {
    void Haptics.selectionAsync();
    const before = items;
    setItems(markLocallyRead(items));
    setUnread(0);
    try {
      setUnread((await api.markNotificationsRead()).unread_count);
    } catch {
      setItems(before);
    }
  };

  const open = (item: NotificationItem) => {
    void Haptics.selectionAsync();
    track('notification_tapped', { type: item.type, source: 'centre' });
    if (!item.read) {
      setItems((prev) => markLocallyRead(prev, [item.id]));
      setUnread((n) => Math.max(0, n - 1));
      void api.markNotificationsRead([item.id]).catch(() => {});
    }
    router.push(targetOf(item.deep_link) as Href);
  };

  const rows = useMemo(() => notificationRows(items), [items]);

  if (!user) {
    return (
      <Screen>
        <EmptyState title="Sign in to see notifications" />
      </Screen>
    );
  }

  const renderRow = ({ item: row }: { item: NotificationRow<NotificationItem> }) => {
    if (row.kind === 'header') {
      return (
        <Txt variant="micro" color="muted" style={styles.sectionHeader}>
          {row.title}
        </Txt>
      );
    }
    const n = row.item;
    const initial = (n.actor?.display_name || n.actor?.username || 'F').charAt(0).toUpperCase();
    return (
      <Pressable
        onPress={() => open(n)}
        accessibilityRole="button"
        accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.text}`}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? c.surface2 : n.read ? c.ground : c.surface, borderBottomColor: c.line },
        ]}
      >
        <View style={[styles.avatar, { backgroundColor: c.surface2, borderColor: c.line }]}>
          {n.actor?.avatar_url ? (
            <Image source={{ uri: n.actor.avatar_url }} style={styles.avatarImage} contentFit="cover" />
          ) : (
            n.actor ? (
              <Txt variant="body" style={{ fontWeight: '500', color: c.ink2 }}>
                {initial}
              </Txt>
            ) : (
              <Ionicons name="arrow-down" size={18} color={c.muted} />
            )
          )}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="body" numberOfLines={3}>
            {n.text}
          </Txt>
          <Txt variant="caption" color="muted">
            {timeAgo(n.updated_at)}
          </Txt>
        </View>
        {!n.read ? <View style={[styles.dot, { backgroundColor: c.accent }]} accessibilityElementsHidden /> : null}
      </Pressable>
    );
  };

  return (
    <Screen>
      <View
        style={{
          paddingTop: insets.top + space[2],
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={sheet.rowBetween}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>
          <Txt variant="title">Notifications</Txt>
          <Pressable
            onPress={markAllRead}
            disabled={unread === 0}
            accessibilityRole="button"
            accessibilityLabel="Mark all as read"
            accessibilityState={{ disabled: unread === 0 }}
            hitSlop={12}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
          >
            <Txt variant="caption" color={unread === 0 ? 'muted' : 'accent'} style={{ fontWeight: '500' }}>
              Mark all read
            </Txt>
          </Pressable>
        </View>
      </View>

      {pushOff ? (
        <Pressable
          onPress={async () => setPushOff(!(await enablePush()))}
          accessibilityRole="button"
          style={[styles.banner, { backgroundColor: c.surface2 }]}
        >
          <Txt variant="caption" color="ink2">
            Push notifications are off on this device. Tap to turn them on.
          </Txt>
        </Pressable>
      ) : null}

      {loading ? (
        <ActivityIndicator color={c.accent} style={{ marginTop: space[8] }} />
      ) : error && items.length === 0 ? (
        <EmptyState
          title="Couldn't load notifications"
          subtitle="Check your connection and pull to try again"
        />
      ) : (
        <FlashList
          data={rows}
          renderItem={renderRow}
          keyExtractor={(row) => (row.kind === 'header' ? `h:${row.title}` : row.item.id)}
          getItemType={(row) => row.kind}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingBottom: insets.bottom + space[8] }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={c.accent}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ListEmptyComponent={
            <EmptyState title="Nothing yet" subtitle="When people react to your reviews, you'll see it here" />
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator color={c.accent} style={{ margin: space[4] }} /> : null}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    paddingHorizontal: space[4],
    paddingTop: space[4],
    paddingBottom: space[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 64,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: 40, height: 40 },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  banner: { paddingHorizontal: space[4], paddingVertical: space[3] },
});
