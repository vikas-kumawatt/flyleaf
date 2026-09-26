// Following List Screen (SO-05).
// Displays users followed by a specified profile with 1-tap follow toggles and navigation.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
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
import { useVerifyEmailPrompt } from '@/ui/VerifyEmail';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function FollowingScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { setFollowing } = useOfflineSync();
  const { prompt: promptVerify } = useVerifyEmailPrompt();

  const [users, setUsers] = useState<FollowUserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchFollowing = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setNotFound(false);
      const res = await api.getFollowing(id);
      setUsers(res.users);
      setTotal(res.total);
    } catch (err: any) {
      if (err?.status === 404 || err?.code === 'not_found') {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchFollowing();
  }, [fetchFollowing]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await fetchFollowing();
    setRefreshing(false);
  };

  const handleToggleFollow = async (targetUser: FollowUserListItem) => {
    if (!user) {
      promptAuth({ title: `Sign up to follow @${targetUser.username}` });
      return;
    }
    // The server refuses follows until the email is verified (D-04-1): say so
    // now rather than queue a write that can only fail (D-07-2).
    if (user.emailVerified === false) {
      promptVerify();
      return;
    }
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
      // email_unverified has its own prompt (VerifyEmailProvider); say so for the rest.
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
            style={{
              paddingVertical: space[1],
              paddingHorizontal: space[2],
              borderRadius: radius.sm,
              backgroundColor: c.surface,
            }}
          >
            <Txt variant="body" style={{ fontWeight: '600', color: c.ink }}>
              ← Back
            </Txt>
          </Pressable>
          <Txt variant="title" style={{ fontSize: 18, fontWeight: '700' }}>
            Following {total > 0 ? `(${total})` : ''}
          </Txt>
          <View style={{ width: 60 }} />
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
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : notFound ? (
          <EmptyState
            title="Account unavailable"
            subtitle="This profile is private or unavailable."
            action={
              <Button label="Go back" variant="primary" onPress={() => router.back()} />
            }
          />
        ) : users.length === 0 ? (
          <EmptyState
            title="Not following anyone yet"
            subtitle="Accounts followed by this user will appear here."
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
                      backgroundColor: c.accentSoft,
                      borderColor: c.line,
                    },
                  ]}
                >
                  <Txt variant="body" style={{ fontWeight: '800', color: c.accent }}>
                    {(item.displayName || item.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>

                <View style={{ flex: 1 }}>
                  <View style={sheet.row}>
                    <Txt variant="body" style={{ fontWeight: '700' }} numberOfLines={1}>
                      {item.displayName || item.username}
                    </Txt>
                    {item.isPrivate && (
                      <Txt variant="caption" color="muted" style={{ marginLeft: 4 }}>
                        🔒
                      </Txt>
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
