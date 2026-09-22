// Muted Content Settings Screen (PRD §6.42, PRD §4078, SO-04).
//
// Allows account owners to inspect muted users and muted books with 1-tap unmute actions.

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
import { api, type MutedUserItem, type MutedWorkItem } from '@/lib/api';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function MutedItemsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState<'users' | 'works'>('users');
  const [mutedUsers, setMutedUsers] = useState<MutedUserItem[]>([]);
  const [mutedWorks, setMutedWorks] = useState<MutedWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchMutes = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getMutes();
      setMutedUsers(res.users);
      setMutedWorks(res.works);
    } catch {
      // Ignore network errors on pull
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMutes();
  }, [fetchMutes]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await fetchMutes();
    setRefreshing(false);
  };

  const handleUnmuteUser = async (userId: string, username: string) => {
    try {
      setProcessingId(userId);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await api.unmuteUser(userId);
      setMutedUsers((prev) => prev.filter((u) => u.id !== userId));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to unmute user. Please try again.');
    } finally {
      setProcessingId(null);
    }
  };

  const handleUnmuteWork = async (workId: string, title: string) => {
    try {
      setProcessingId(workId);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await api.unmuteWork(workId);
      setMutedWorks((prev) => prev.filter((w) => w.id !== workId));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to unmute book. Please try again.');
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
          gap: space[3],
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
            Muted Content
          </Txt>

          <View style={{ minWidth: 44 }} />
        </View>

        <SegmentedControl
          options={[
            { value: 'users', label: `Users (${mutedUsers.length})` },
            { value: 'works', label: `Books (${mutedWorks.length})` },
          ]}
          value={activeTab}
          onChange={(val) => {
            void Haptics.selectionAsync();
            setActiveTab(val as 'users' | 'works');
          }}
        />
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
        {loading && mutedUsers.length === 0 && mutedWorks.length === 0 ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : activeTab === 'users' ? (
          mutedUsers.length === 0 ? (
            <EmptyState
              title="No Muted Users"
              subtitle="Users you mute will be hidden from your feed without unfollowing them."
            />
          ) : (
            mutedUsers.map((item) => {
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

                    <Button
                      label={isBusy ? '...' : 'Unmute'}
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      onPress={() => handleUnmuteUser(item.id, item.username)}
                    />
                  </View>
                </Card>
              );
            })
          )
        ) : mutedWorks.length === 0 ? (
          <EmptyState
            title="No Muted Books"
            subtitle="Muted books stop appearing in your activity feeds and recommendations."
          />
        ) : (
          mutedWorks.map((item) => {
            const isBusy = processingId === item.id;
            return (
              <Card key={item.id} style={{ padding: space[4] }}>
                <View style={sheet.rowBetween}>
                  <View style={[sheet.row, { gap: space[3], flex: 1 }]}>
                    <Cover coverId={item.cover_id} size="s" />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                        {item.title}
                      </Txt>
                      <Txt variant="caption" color="muted" numberOfLines={1}>
                        {item.author_name}
                      </Txt>
                    </View>
                  </View>

                  <Button
                    label={isBusy ? '...' : 'Unmute'}
                    variant="outline"
                    size="sm"
                    disabled={isBusy}
                    onPress={() => handleUnmuteWork(item.id, item.title)}
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
