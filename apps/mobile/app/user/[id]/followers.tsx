// Followers List Screen (SO-05).
// Displays the followers of a specified user with 1-tap follow toggles and navigation.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  RefreshControl,
  StyleSheet,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, FlyleafApiError, type FollowUserListItem } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useActionGate } from '@/ui/ActionGate';
import { useOfflineSync } from '@/offline/sync';
import { FOLLOW_PAGE_SIZE, appendFollowPage, hasMoreFollows } from '@/lib/socialValidation';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  Txt,
  sheet, SkeletonList} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

export default function FollowersScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { setFollowing } = useOfflineSync();

  const [users, setUsers] = useState<FollowUserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchFollowers = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setNotFound(false);
      const res = await api.getFollowers(id, { limit: FOLLOW_PAGE_SIZE, offset: 0 });
      setUsers(res.users);
      setTotal(res.total);
      setMore(hasMoreFollows(res.users.length, res.total, res.users.length));
    } catch (err: any) {
      if (err?.status === 404 || err?.code === 'not_found') {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  // The next page (audit 13, A-13-013: only the first 50 were ever shown).
  const loadMore = async () => {
    if (!id || loadingMore) return;
    try {
      setLoadingMore(true);
      const res = await api.getFollowers(id, { limit: FOLLOW_PAGE_SIZE, offset: users.length });
      const next = appendFollowPage(users, res.users);
      setUsers(next);
      setTotal(res.total);
      setMore(hasMoreFollows(next.length, res.total, res.users.length));
    } catch {
      Alert.alert('Could not load more', 'We could not reach Flyleaf. Try again in a moment.');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchFollowers();
  }, [fetchFollowers]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await fetchFollowers();
    setRefreshing(false);
  };

  const handleToggleFollow = async (targetUser: FollowUserListItem) => {
    if (!user) {
      promptAuth({ title: `Sign up to follow @${targetUser.username}` });
      return;
    }
    // Follows need no verified email (owner decision on SO-5x, 13 Oct 2026);
    // reviews and comments still do.
    try {
      setProcessingId(targetUser.id);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Queued (D-07-2): sent now if online, after reconnect otherwise.
      if (targetUser.followedByViewer) {
        await setFollowing(targetUser.id, false);
        setUsers((prev) =>
          prev.map((u) => (u.id === targetUser.id ? { ...u, followedByViewer: false } : u)),
        );
      } else {
        await setFollowing(targetUser.id, true);
        setUsers((prev) =>
          prev.map((u) => (u.id === targetUser.id ? { ...u, followedByViewer: true } : u)),
        );
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      // email_unverified (an older server) has its own prompt (VerifyEmailProvider); say so for the rest.
      if (!(err instanceof FlyleafApiError && err.code === 'email_unverified')) {
        Alert.alert('Could not update', 'We could not reach Flyleaf. Try again in a moment.');
      }
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + space[2],
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>
          <Txt variant="title">
            Followers
            {total > 0 ? (
              <Txt variant="title" color="muted" tabular>
                {`  ${total}`}
              </Txt>
            ) : null}
          </Txt>
          <View style={{ width: 44 }} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: insets.bottom + space[8],
          gap: space[3],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
        }
      >
        {loading && !refreshing ? (
          <SkeletonList lead="avatar" style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : notFound ? (
          <EmptyState
            title="Account unavailable"
            subtitle="This profile is private or unavailable"
            action={
              <Button label="Go back" variant="primary" onPress={() => router.back()} />
            }
          />
        ) : users.length === 0 ? (
          <EmptyState
            title="No followers yet"
            subtitle="When people follow this account, they will appear here"
          />
        ) : (
          users.map((item) => (
            <Card
              key={item.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: space[3],
                gap: space[3],
              }}
            >
              <Pressable
                onPress={() => router.push(`/user/${item.id}` as any)}
                style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: space[3] }}
              >
                <View
                  style={[
                    styles.avatar,
                    {
                      backgroundColor: c.surface2,
                      borderColor: c.line,
                    },
                  ]}
                >
                  <Txt variant="body" style={{ fontWeight: '500', color: c.ink2 }}>
                    {(item.displayName || item.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>

                <View style={{ flex: 1 }}>
                  <View style={sheet.row}>
                    <Txt variant="body" style={{ fontWeight: '500' }} numberOfLines={1}>
                      {item.displayName || item.username}
                    </Txt>
                    {item.isPrivate && (
                      <Ionicons name="lock-closed-outline" size={14} color={c.muted} style={{ marginLeft: space[1] }} accessibilityLabel="Private account" />
                    )}
                  </View>
                  <Txt variant="caption" color="muted" numberOfLines={1}>
                    @{item.username}
                  </Txt>
                </View>
              </Pressable>

              <Button
                label={item.followedByViewer ? 'Following' : 'Follow'}
                variant={item.followedByViewer ? 'outline' : 'primary'}
                size="sm"
                onPress={() => handleToggleFollow(item)}
                disabled={processingId === item.id}
              />
            </Card>
          ))
        )}
        {!loading && !notFound && more ? (
          <Button
            label={loadingMore ? 'Loading…' : 'Show more'}
            variant="outline"
            onPress={loadMore}
            disabled={loadingMore}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
