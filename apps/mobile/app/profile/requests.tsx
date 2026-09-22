// Pending Follow Requests Screen (PRD §6.42, AC-13, SO-02).
//
// Allows account owners (especially private accounts) to inspect, accept, and decline incoming follow requests.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type PendingFollowRequest } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function FollowRequestsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [requests, setRequests] = useState<PendingFollowRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getPendingFollowRequests();
      setRequests(res.requests);
    } catch {
      // Ignore network errors on pull
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await fetchRequests();
    setRefreshing(false);
  };

  const handleAccept = async (requesterId: string) => {
    try {
      setProcessingId(requesterId);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await api.acceptFollowRequest(requesterId);
      setRequests((prev) => prev.filter((r) => r.id !== requesterId));
    } catch {
      void fetchRequests();
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (requesterId: string) => {
    try {
      setProcessingId(requesterId);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await api.rejectFollowRequest(requesterId);
      setRequests((prev) => prev.filter((r) => r.id !== requesterId));
    } catch {
      void fetchRequests();
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
        <View style={sheet.rowBetween}>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.back();
            }}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
              ← Back
            </Txt>
          </Pressable>

          <Txt variant="title" style={{ fontWeight: '700', fontSize: 17 }}>
            Follow Requests
          </Txt>

          <View style={{ minWidth: 44 }} />
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
        {loading && requests.length === 0 ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : requests.length === 0 ? (
          <EmptyState
            title="No Pending Requests"
            subtitle="When people request to follow your account, their requests will show up here."
          />
        ) : (
          requests.map((item) => {
            const isBusy = processingId === item.id;
            return (
              <Card key={item.id} style={{ padding: space[4], gap: space[3] }}>
                <View style={[sheet.rowTop, { gap: space[3] }]}>
                  {/* Avatar */}
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push(`/user/${item.id}` as any);
                    }}
                  >
                    <View
                      style={[
                        styles.avatar,
                        { backgroundColor: c.accentSoft, borderColor: c.line },
                      ]}
                    >
                      <Txt
                        variant="title"
                        style={{ fontSize: 18, fontWeight: '800', color: c.accent }}
                      >
                        {(item.display_name || item.username).charAt(0).toUpperCase()}
                      </Txt>
                    </View>
                  </Pressable>

                  {/* Info */}
                  <View style={{ flex: 1, gap: 2 }}>
                    <Pressable
                      onPress={() => {
                        void Haptics.selectionAsync();
                        router.push(`/user/${item.id}` as any);
                      }}
                    >
                      <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                        {item.display_name || item.username}
                      </Txt>
                      <Txt variant="caption" color="muted">
                        @{item.username}
                      </Txt>
                    </Pressable>

                    {item.bio && (
                      <Txt
                        variant="caption"
                        numberOfLines={2}
                        style={{ marginTop: 4, lineHeight: 16 }}
                      >
                        {item.bio}
                      </Txt>
                    )}
                  </View>
                </View>

                {/* Actions */}
                <View style={[sheet.row, { gap: space[2], justifyContent: 'flex-end' }]}>
                  <Button
                    label="Decline"
                    variant="outline"
                    size="sm"
                    onPress={() => handleReject(item.id)}
                    disabled={isBusy}
                  />
                  <Button
                    label="Accept"
                    variant="primary"
                    size="sm"
                    onPress={() => handleAccept(item.id)}
                    disabled={isBusy}
                  />
                </View>
              </Card>
            );
          })
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
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
