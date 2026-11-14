// Pending Follow requests Screen (PRD §6.42, AC-13, SO-02).
//
// Allows account owners (especially private accounts) to inspect, accept, and decline incoming follow requests.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type PendingFollowRequest } from '@/lib/api';
import {
  Button,
  EmptyState,
  Screen,
  Txt,
  sheet, SkeletonList} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

export default function FollowRequestsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [requests, setRequests] = useState<PendingFollowRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getPendingFollowRequests();
      setRequests(res.requests);
      setLoadFailed(false);
    } catch {
      // Network errors keep the list as it was; the error state below offers a retry when it is empty.
      setLoadFailed(true);
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
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>

          <Txt variant="title">
            Follow requests
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
          <SkeletonList lead="avatar" style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : requests.length === 0 && loadFailed ? (
          <EmptyState
            title="Could not load follow requests"
            subtitle="Check your connection and try again."
            action={<Button label="Try again" variant="primary" onPress={() => void fetchRequests()} />}
          />
        ) : requests.length === 0 ? (
          <EmptyState
            title="No pending requests"
            subtitle="When people request to follow your account, their requests will show up here"
          />
        ) : (
          <View>
          {requests.map((item, index) => {
            const isBusy = processingId === item.id;
            return (
              <View
                key={item.id}
                style={{
                  paddingVertical: space[4],
                  gap: space[3],
                  borderTopWidth: index ? 1 : 0,
                  borderTopColor: c.line,
                }}
              >
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
                        { backgroundColor: c.surface2, borderColor: c.line },
                      ]}
                    >
                      <Txt
                        variant="title"
                        style={{ fontSize: 18, fontWeight: '500', color: c.ink2 }}
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
                      <Txt variant="body" style={{ fontWeight: '500' }}>
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
              </View>
            );
          })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
