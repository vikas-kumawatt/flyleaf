// Public User Profile Screen (PRD §6.18, Architecture §3.3, SL-72).
//
// Displays any user's 4 favourites, stats strip, The Wall, and Diary preview with privacy enforcement.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, FlyleafApiError, type Profile, type ReadingStats } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useActionGate } from '@/ui/ActionGate';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function UserProfileScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { promptAuth } = useActionGate();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submittingFollow, setSubmittingFollow] = useState(false);

  const loadProfileData = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const [profileRes, statsRes] = await Promise.allSettled([
        api.userProfile(id),
        api.userStats(id),
      ]);

      if (profileRes.status === 'fulfilled') {
        setProfile(profileRes.value);
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadProfileData();
  }, [loadProfileData]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await loadProfileData();
    setRefreshing(false);
  };

  const handleFollowToggle = async () => {
    if (!id || !profile || profile.followStatus === 'self' || submittingFollow) return;
    if (!user) {
      promptAuth({
        title: `Sign up to follow @${profile.username}`,
        subtitle: 'Follow readers whose taste you trust and see what they read.',
      });
      return;
    }
    try {
      setSubmittingFollow(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      if (profile.followStatus === 'accepted' || profile.followStatus === 'pending') {
        const res = await api.unfollowUser(id);
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                followStatus: 'none',
                followerCount:
                  prev.followStatus === 'accepted'
                    ? Math.max(0, prev.followerCount - 1)
                    : prev.followerCount,
              }
            : null,
        );
      } else {
        const res = await api.followUser(id);
        const newStatus = res.status;
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                followStatus: newStatus,
                followerCount:
                  newStatus === 'accepted' ? prev.followerCount + 1 : prev.followerCount,
              }
            : null,
        );
      }
    } catch (err) {
      // email_unverified has its own prompt (VerifyEmailProvider); say so for the rest.
      if (!(err instanceof FlyleafApiError && err.code === 'email_unverified')) {
        Alert.alert('Could not update', 'We could not reach Flyleaf. Try again in a moment.');
      }
      void loadProfileData();
    } finally {
      setSubmittingFollow(false);
    }
  };

  const handleBlockUser = async () => {
    if (!id || !profile || profile.followStatus === 'self') return;
    if (!user) {
      promptAuth({ title: `Sign up to block @${profile.username}` });
      return;
    }
    Alert.alert(
      `Block @${profile.username}?`,
      "They won't be able to see your profile or content, and you won't see theirs. They will not be notified.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              await api.blockUser(id);
              setProfile(null);
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch {
              Alert.alert('Error', 'Failed to block user. Please try again.');
            }
          },
        },
      ],
    );
  };

  const handleMuteUser = async () => {
    if (!id || !profile || profile.followStatus === 'self') return;
    if (!user) {
      promptAuth({ title: `Sign up to mute @${profile.username}` });
      return;
    }
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await api.muteUser(id);
      Alert.alert('Muted', `@${profile.username} has been muted. Their activity will be hidden from your feeds.`);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to mute user. Please try again.');
    }
  };

  const isRestricted = profile?.isRestricted || (profile?.isPrivate && profile?.followStatus !== 'accepted' && profile?.followStatus !== 'self');

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

          <Txt variant="title" style={{ fontWeight: '700', fontSize: 17 }} numberOfLines={1}>
            {profile?.displayName || (profile ? `@${profile.username}` : 'Reader')}
          </Txt>

          {profile && profile.followStatus !== 'self' ? (
            <Pressable
              onPress={handleBlockUser}
              accessibilityRole="button"
              accessibilityLabel="Block User"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
            >
              <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                Block
              </Txt>
            </Pressable>
          ) : (
            <View style={{ minWidth: 44 }} />
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: insets.bottom + space[8],
          gap: space[4],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
        }
      >
        {loading && !profile ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : !profile ? (
          <EmptyState
            title="Reader not found"
            subtitle="This profile could not be loaded or may no longer exist."
            action={
              <Button
                label="Go back"
                variant="primary"
                onPress={() => router.back()}
              />
            }
          />
        ) : (
          <>
            {/* Identity & Follow Row */}
            <View style={{ gap: space[3] }}>
              <View style={[sheet.rowTop, { gap: space[4] }]}>
                {/* Large Avatar */}
                <View
                  style={[
                    styles.avatar,
                    {
                      backgroundColor: c.accentSoft,
                      borderColor: c.line,
                    },
                  ]}
                >
                  <Txt variant="title" style={{ fontSize: 26, fontWeight: '800', color: c.accent }}>
                    {(profile.displayName || profile.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>

                {/* Info */}
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={sheet.row}>
                    <Txt variant="title" style={{ fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
                      {profile.displayName || profile.username}
                    </Txt>
                    {profile.isPrivate && (
                      <Txt variant="caption" color="muted" style={{ marginLeft: 6 }}>
                        🔒
                      </Txt>
                    )}
                  </View>

                  <View style={[sheet.row, { gap: space[2] }]}>
                    <Txt variant="caption" color="muted">
                      @{profile.username}
                    </Txt>
                    {profile.followedBy && (
                      <View
                        style={{
                          backgroundColor: c.accentSoft,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderRadius: radius.sm,
                        }}
                      >
                        <Txt variant="caption" color="accent" style={{ fontSize: 10, fontWeight: '700' }}>
                          Follows you
                        </Txt>
                      </View>
                    )}
                  </View>

                  <View style={[sheet.row, { gap: space[3], marginTop: space[1] }]}>
                    <Pressable onPress={() => router.push(`/user/${profile.id}/followers` as any)}>
                      <Txt variant="caption">
                        <Txt variant="caption" style={{ fontWeight: '700' }}>
                          {profile.followerCount}
                        </Txt>{' '}
                        followers
                      </Txt>
                    </Pressable>
                    <Pressable onPress={() => router.push(`/user/${profile.id}/following` as any)}>
                      <Txt variant="caption">
                        <Txt variant="caption" style={{ fontWeight: '700' }}>
                          {profile.followingCount}
                        </Txt>{' '}
                        following
                      </Txt>
                    </Pressable>
                  </View>
                </View>
              </View>

              {/* Bio */}
              {profile.bio && (
                <Txt variant="body" style={{ lineHeight: 20 }}>
                  {profile.bio}
                </Txt>
              )}

              {/* Action Bar (Follow / Mute / Block) */}
              {profile.followStatus !== 'self' && (
                <View style={[sheet.row, { gap: space[2] }]}>
                  <Button
                    label={
                      profile.followStatus === 'accepted'
                        ? 'Following'
                        : profile.followStatus === 'pending'
                          ? 'Requested'
                          : profile.isPrivate
                            ? 'Request to follow'
                            : 'Follow'
                    }
                    variant={profile.followStatus === 'none' ? 'primary' : 'outline'}
                    onPress={handleFollowToggle}
                    disabled={submittingFollow}
                    style={{ flex: 2 }}
                  />
                  <Button
                    label="Mute"
                    variant="outline"
                    onPress={handleMuteUser}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label="Block"
                    variant="outline"
                    onPress={handleBlockUser}
                    style={{ flex: 1 }}
                  />
                </View>
              )}
            </View>

            {/* Privacy Check */}
            {isRestricted ? (
              <Card style={{ padding: space[6], alignItems: 'center', gap: space[2] }}>
                <Txt variant="title" style={{ fontSize: 28 }}>
                  🔒
                </Txt>
                <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                  This Account is Private
                </Txt>
                <Txt variant="caption" color="muted" style={{ textAlign: 'center' }}>
                  {profile.followStatus === 'pending'
                    ? `Follow request sent to @${profile.username}. Once accepted, their reading activity will appear here.`
                    : `Follow @${profile.username} to see their favourite books, reading diary, and stats.`}
                </Txt>
              </Card>
            ) : (
              <>
                {/* 4 Defining Favourites */}
                {profile.favourites && profile.favourites.length > 0 && (
                  <View style={{ gap: space[2] }}>
                    <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                      DEFINING FAVOURITES
                    </Txt>
                    <View style={styles.favouritesRow}>
                      {profile.favourites.map((fav) => (
                        <Pressable
                          key={fav.id}
                          onPress={() => {
                            void Haptics.selectionAsync();
                            router.push(`/work/${fav.id}` as any);
                          }}
                          style={styles.favItem}
                        >
                          <Cover coverId={fav.cover_id} title={fav.title} size="fluid" />
                          <Txt variant="caption" numberOfLines={1} style={{ fontSize: 11, marginTop: 4 }}>
                            {fav.title}
                          </Txt>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}

                {/* Stats Strip */}
                {stats && (
                  <View style={{ gap: space[2] }}>
                    <View style={sheet.rowBetween}>
                      <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                        READING STATS
                      </Txt>
                      <Pressable
                        onPress={() => {
                          void Haptics.selectionAsync();
                          router.push(`/stats?userId=${id}` as any);
                        }}
                      >
                        <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                          Full Stats →
                        </Txt>
                      </Pressable>
                    </View>

                    <Pressable
                      onPress={() => {
                        void Haptics.selectionAsync();
                        router.push(`/stats?userId=${id}` as any);
                      }}
                    >
                      <View style={[sheet.row, { gap: space[2] }]}>
                        <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                          <Txt variant="title" tabular style={{ fontSize: 20, fontWeight: '800' }}>
                            {stats.books_count}
                          </Txt>
                          <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                            books read
                          </Txt>
                        </Card>

                        <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                          <Txt variant="title" tabular style={{ fontSize: 20, fontWeight: '800' }}>
                            {stats.pages_count.toLocaleString()}
                          </Txt>
                          <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                            pages tracked
                          </Txt>
                        </Card>

                        <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                          <Txt
                            variant="title"
                            tabular
                            style={{ fontSize: 20, fontWeight: '800', color: stats.avg_rating ? c.accent : c.ink }}
                          >
                            {stats.avg_rating ? `★ ${stats.avg_rating.toFixed(1)}` : '—'}
                          </Txt>
                          <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                            avg rating
                          </Txt>
                        </Card>
                      </View>
                    </Pressable>
                  </View>
                )}

                {/* The Wall Link */}
                <Card
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push(`/wall?userId=${id}` as any);
                  }}
                  style={{ padding: space[3] }}
                >
                  <View style={sheet.rowBetween}>
                    <View style={{ gap: 2 }}>
                      <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                        The Wall
                      </Txt>
                      <Txt variant="caption" color="muted">
                        Explore all book covers completed by @{profile.username}
                      </Txt>
                    </View>
                    <Txt variant="title" color="accent">
                      →
                    </Txt>
                  </View>
                </Card>
              </>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  favouritesRow: {
    flexDirection: 'row',
    gap: space[2],
  },
  favItem: {
    width: '23%',
    aspectRatio: 2 / 3,
  },
});
