// Blocked Users Settings Screen (PRD §6.42, PRD §4078, SO-03).
//
// Allows account owners to inspect their blocked users list and unblock with 1-tap.

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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type BlockedUserItem } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function BlockedUsersScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [blocks, setBlocks] = useState<BlockedUserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchBlocks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getBlockedUsers();
      setBlocks(res.blocks);
    } catch {
      // Ignore network errors on pull
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await fetchBlocks();
    setRefreshing(false);
  };

  const handleUnblock = async (blockedUserId: string, username: string) => {
    Alert.alert(
      'Unblock User',
      `Are you sure you want to unblock @${username}? They will be able to see your public content and request to follow you again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          style: 'destructive',
          onPress: async () => {
            try {
              setProcessingId(blockedUserId);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              await api.unblockUser(blockedUserId);
              setBlocks((prev) => prev.filter((b) => b.id !== blockedUserId));
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch {
              Alert.alert('Error', 'Failed to unblock user. Please try again.');
            } finally {
              setProcessingId(null);
            }
          },
        },
      ],
    );
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
            Blocked Accounts
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
        {loading && blocks.length === 0 ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : blocks.length === 0 ? (
          <EmptyState
            title="No Blocked Accounts"
            subtitle="Accounts you block will appear here. Blocked users cannot see your profile, content, or activity."
          />
        ) : (
          blocks.map((item) => {
            const isBusy = processingId === item.id;
            return (
              <Card key={item.id} style={{ padding: space[4] }}>
                <View style={sheet.rowBetween}>
                  <View style={[sheet.row, { gap: space[3], flex: 1 }]}>
                    {/* Avatar */}
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

                    {/* Info */}
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                        {item.display_name || item.username}
                      </Txt>
                      <Txt variant="caption" color="muted">
                        @{item.username}
                      </Txt>
                    </View>
                  </View>

                  {/* Unblock Action */}
                  <Button
                    label={isBusy ? '...' : 'Unblock'}
                    variant="outline"
                    size="sm"
                    disabled={isBusy}
                    onPress={() => handleUnblock(item.id, item.username)}
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
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
