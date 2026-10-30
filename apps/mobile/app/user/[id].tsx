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
import { api, FlyleafApiError, type GoalResponse, type Profile, type ReadingStats } from '@/lib/api';
import { deviceTimeZone, goalRingModel, streakCopy } from '@/lib/statsView';
import { GoalRing } from '@/ui/GoalRing';
import { useSession } from '@/lib/session';
import { ReportSheet, type ReportTarget } from '@/ui/ReportSheet';
import { useActionGate } from '@/ui/ActionGate';
import { useOfflineSync } from '@/offline/sync';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { fontFamilies, radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

export default function UserProfileScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const { promptAuth } = useActionGate();
  const { setFollowing } = useOfflineSync();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [goal, setGoal] = useState<GoalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submittingFollow, setSubmittingFollow] = useState(false);

  const loadProfileData = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      // Counted as this viewer may count them (§17.5); days in the viewer's zone.
      const tz = deviceTimeZone();
      const [profileRes, statsRes, goalRes] = await Promise.allSettled([
        api.userProfile(id),
        api.userStats(id, undefined, tz),
        api.userGoal(id, undefined, tz),
      ]);

      if (profileRes.status === 'fulfilled') {
        setProfile(profileRes.value);
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      }
      setGoal(goalRes.status === 'fulfilled' ? goalRes.value : null);
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
    // Follows need no verified email (owner decision on SO-5x, 13 Oct 2026);
    // reviews and comments still do.
    try {
      setSubmittingFollow(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Queued (D-07-2): the new state shows at once and is sent now if online,
      // after reconnect otherwise. A private account gets a request.
      if (profile.followStatus === 'accepted' || profile.followStatus === 'pending') {
        await setFollowing(id, false);
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
        await setFollowing(id, true);
        const newStatus = profile.isPrivate ? 'pending' : 'accepted';
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
      // email_unverified (an older server) has its own prompt (VerifyEmailProvider); say so for the rest.
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
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>

          <Txt variant="title" numberOfLines={1}>
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
              <Txt variant="caption" color="muted" style={{ fontWeight: '500' }}>
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
            subtitle="This profile could not be loaded or no longer exists"
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
                      backgroundColor: c.surface2,
                      borderColor: c.line,
                    },
                  ]}
                >
                  <Txt variant="title" style={{ fontSize: 26, fontWeight: '500', color: c.ink2 }}>
                    {(profile.displayName || profile.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>

                {/* Info */}
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={sheet.row}>
                    <Txt variant="displayM" numberOfLines={1}>
                      {profile.displayName || profile.username}
                    </Txt>
                    {profile.isPrivate && (
                      <Ionicons name="lock-closed-outline" size={14} color={c.muted} style={{ marginLeft: space[1] }} accessibilityLabel="Private account" />
                    )}
                  </View>

                  <View style={[sheet.row, { gap: space[2] }]}>
                    <Txt variant="caption" color="muted">
                      @{profile.username}
                    </Txt>
                    {profile.followedBy && (
                      <Txt variant="micro" color="muted">
                        · Follows you
                      </Txt>
                    )}
                  </View>

                  <View style={[sheet.row, { gap: space[3], marginTop: space[1] }]}>
                    <Pressable onPress={() => router.push(`/user/${profile.id}/followers` as any)}>
                      <Txt variant="caption">
                        <Txt variant="caption" style={{ fontWeight: '500' }}>
                          {profile.followerCount}
                        </Txt>{' '}
                        followers
                      </Txt>
                    </Pressable>
                    <Pressable onPress={() => router.push(`/user/${profile.id}/following` as any)}>
                      <Txt variant="caption">
                        <Txt variant="caption" style={{ fontWeight: '500' }}>
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
              {profile.followStatus !== 'self' && user && (
                <Pressable
                  onPress={() => setReportTarget({ type: 'user', id: profile.id })}
                  accessibilityRole="button"
                  accessibilityLabel={`Report @${profile.username}`}
                  style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
                >
                  <Txt variant="caption" color="muted">Report profile</Txt>
                </Pressable>
              )}
            </View>

            {/* Privacy Check */}
            {isRestricted ? (
              <Card style={{ padding: space[6], alignItems: 'center', gap: space[2] }}>
                <Ionicons name="lock-closed-outline" size={24} color={c.muted} />
                <Txt variant="title">This account is private</Txt>
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
                    <Txt variant="micro" color="muted">Defining favourites</Txt>
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
                          <Txt variant="caption" numberOfLines={1} style={{ fontFamily: fontFamilies.displayRegular, marginTop: space[1] }}>
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
                      <Txt variant="micro" color="muted">Reading stats</Txt>
                      <Pressable
                        onPress={() => {
                          void Haptics.selectionAsync();
                          router.push(`/stats?userId=${id}` as any);
                        }}
                      >
                        <Txt variant="caption" color="ink2" style={{ fontWeight: '500' }}>
                          All stats
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
                          <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                            {stats.books_count}
                          </Txt>
                          <Txt variant="micro" color="muted">
                            books read
                          </Txt>
                        </Card>

                        <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                          <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                            {stats.pages_count.toLocaleString()}
                          </Txt>
                          <Txt variant="micro" color="muted">
                            pages tracked
                          </Txt>
                        </Card>

                        <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                          <View style={[sheet.row, { gap: space[1] }]}>
                            {stats.avg_rating ? <Ionicons name="star" size={16} color={c.star} /> : null}
                            <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                              {stats.avg_rating ? stats.avg_rating.toFixed(1) : '—'}
                            </Txt>
                          </View>
                          <Txt variant="micro" color="muted">
                            avg rating
                          </Txt>
                        </Card>
                      </View>
                    </Pressable>
                    {/* Streak (§8.7, never a loss) and their goal ring (§8.6), only when they have them. */}
                    {(streakCopy(stats) || goalRingModel(goal)) && (
                      <View style={[sheet.row, { gap: space[2] }]}>
                        {streakCopy(stats) && (
                          <Card style={{ flex: 1, padding: space[3], justifyContent: 'center' }}>
                            <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                              {streakCopy(stats)!.hero}
                            </Txt>
                            <Txt variant="micro" color="muted">
                              {streakCopy(stats)!.label}
                            </Txt>
                          </Card>
                        )}
                        {goalRingModel(goal) && (
                          <Card style={{ padding: space[3], alignItems: 'center', justifyContent: 'center' }}>
                            <GoalRing model={goalRingModel(goal)} />
                          </Card>
                        )}
                      </View>
                    )}
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
                      <Txt variant="title">The Wall</Txt>
                      <Txt variant="caption" color="muted">
                        Every cover @{profile.username} has finished
                      </Txt>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={c.muted} />
                  </View>
                </Card>
              </>
            )}
          </>
        )}
      </ScrollView>
      <ReportSheet target={reportTarget} onClose={() => setReportTarget(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 68,
    height: 68,
    borderRadius: 34, // circle
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
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
