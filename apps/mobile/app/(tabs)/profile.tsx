// Tab 5 — Profile (PRD §5.2, §6.18, §6.39, SL-72).
//
// First-class profile:
// 1. Identity header: Avatar, Display Name, Bio, Followers/Following, Privacy lock.
// 2. Favourites: 4 ordered defining books with direct link to picker (/profile/favourites).
// 3. Stats Strip: books, pages, avg rating, streak (§8.7, "longest" framing) and
//    the reading-goal ring (ST-05; PRD §8.6: the ring lives here and nowhere else).
// 4. Currently Reading: Real-time progress on active books.
// 5. The Wall preview: Latest finished posters with link to /wall.
// 6. Diary preview: Recent finished entries with link to /diary.
// 7. Edit Profile modal (bio <= 160 chars, display name).
// 8. Settings (LA-02): one entry to app/settings, which holds privacy, the
//    theme, blocked/muted/content, imports, legal, sign out and deletion.

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { pickAndUploadAvatar, useAvatarSource, type AvatarSource } from '@/lib/avatar';
import { useSession } from '@/lib/session';
import { profileShareUrl } from '@/lib/followSuggestions';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import {
  api,
  PUBLIC_BASE,
  type Profile,
  type ReadingStats,
  type GoalResponse,
} from '@/lib/api';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  ProgressBar,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';
import { GoalRing } from '@/ui/GoalRing';
import { GoalSheet } from '@/ui/GoalSheet';
import { deviceTimeZone, goalRingModel, streakCopy } from '@/lib/statsView';

export default function ProfileScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const db = useDatabase();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarSource = useAvatarSource(profile?.avatarUrl);

  // PRD §6.7: library, camera or the generated avatar. A failure says so and
  // leaves the current avatar in place.
  const changeAvatar = () => {
    const run = async (source: AvatarSource) => {
      setAvatarBusy(true);
      try {
        const url = await pickAndUploadAvatar(source);
        if (url !== null) setProfile((p) => (p ? { ...p, avatarUrl: url } : p));
      } catch (err) {
        Alert.alert('Photo not saved', err instanceof Error ? err.message : 'Try again in a moment.');
      } finally {
        setAvatarBusy(false);
      }
    };
    const remove = async () => {
      setAvatarBusy(true);
      try {
        await api.removeAvatar();
        setProfile((p) => (p ? { ...p, avatarUrl: null } : p));
      } catch {
        Alert.alert('Photo not removed', 'Try again in a moment.');
      } finally {
        setAvatarBusy(false);
      }
    };
    Alert.alert('Profile photo', undefined, [
      { text: 'Choose from library', onPress: () => void run('library') },
      { text: 'Take a photo', onPress: () => void run('camera') },
      ...(profile?.avatarUrl ? [{ text: 'Remove photo', style: 'destructive' as const, onPress: () => void remove() }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [goal, setGoal] = useState<GoalResponse | null>(null);
  const [goalSheetVisible, setGoalSheetVisible] = useState(false);
  const [reads, setReads] = useState<LocalRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Edit Profile Modal
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Load all profile data
  const loadData = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      // 1. Fetch profile & stats in parallel
      // Streak days and "this year" are the reader's own (PRD §8.7).
      const tz = deviceTimeZone();
      const [profileRes, statsRes, goalRes] = await Promise.allSettled([
        api.myProfile(),
        api.myStats(undefined, tz),
        api.myGoal(undefined, tz),
      ]);

      if (profileRes.status === 'fulfilled') {
        setProfile(profileRes.value);
        setEditDisplayName(profileRes.value.displayName || '');
        setEditBio(profileRes.value.bio || '');
      }

      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      }
      if (goalRes.status === 'fulfilled') {
        setGoal(goalRes.value);
      }

      // 2. Fetch local reads for Currently Reading and Wall
      if (db && user) {
        const repo = new OfflineRepository(db, user.id);
        const local = await repo.getLocalReads();
        setReads(local);
      }
    } finally {
      setLoading(false);
    }
  }, [user, db]);

  // On every return to the tab: privacy and the username can change in Settings.
  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await loadData();
    setRefreshing(false);
  };

  // Currently reading books
  const currentlyReading = useMemo(() => {
    return reads.filter((r) => r.status === 'reading');
  }, [reads]);

  // Finished reads for Wall preview
  const streak = stats ? streakCopy(stats) : null;
  const finishedReads = useMemo(() => {
    return reads.filter((r) => r.status === 'finished');
  }, [reads]);

  // Save profile edits
  const handleSaveProfile = async () => {
    if (editBio.length > 160) {
      Alert.alert('Bio too long', 'Keep it to 160 characters.');
      return;
    }

    try {
      setSavingProfile(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const updated = await api.updateProfile({
        displayName: editDisplayName.trim() || null,
        bio: editBio.trim() || null,
      });
      setProfile(updated);
      setEditModalVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Profile not saved', 'Try again in a moment.');
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Header */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={sheet.rowBetween}>
          <Txt variant="displayL">
            Profile
          </Txt>
          <Button
            label="Settings"
            variant="tertiary"
            size="sm"
            accessibilityLabel="Open settings"
            onPress={() => {
              void Haptics.selectionAsync();
              router.push('/settings' as any);
            }}
            style={{ minHeight: 44 }}
          />
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
        {user ? (
          <>
            {/* 1. IDENTITY HEADER */}
            <View style={{ gap: space[3] }}>
              <View style={[sheet.rowTop, { gap: space[4] }]}>
                {/* Large Avatar: tap to change (PRD §6.7) */}
                <Pressable
                  onPress={changeAvatar}
                  disabled={avatarBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Change profile photo"
                  style={[
                    styles.avatar,
                    {
                      backgroundColor: c.surface2,
                      borderColor: c.line,
                      overflow: 'hidden',
                    },
                  ]}
                >
                  {avatarBusy ? (
                    <ActivityIndicator color={c.muted} />
                  ) : avatarSource ? (
                    <Image source={avatarSource} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                  ) : (
                    <Txt variant="displayM" color="ink2">
                      {(profile?.displayName || user.username).charAt(0).toUpperCase()}
                    </Txt>
                  )}
                </Pressable>

                {/* Identity Info */}
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={sheet.row}>
                    <Txt variant="title" style={{ fontSize: 17, fontWeight: '500' }} numberOfLines={1}>
                      {profile?.displayName || user.username}
                    </Txt>
                    {profile?.isPrivate && (
                      <Ionicons
                        name="lock-closed-outline"
                        size={16}
                        color={c.muted}
                        style={{ marginLeft: space[2] }}
                        accessibilityLabel="Private account"
                      />
                    )}
                  </View>

                  <Txt variant="caption" color="muted">
                    @{user.username}
                  </Txt>

                  {/* Follower / Following count */}
                  <View style={[sheet.row, { gap: space[3], marginTop: space[1] }]}>
                    <Pressable
                      onPress={() => {
                        if (user?.id) {
                          router.push(`/user/${user.id}/followers` as any);
                        }
                      }}
                    >
                      <Txt variant="caption">
                        <Txt variant="caption" style={{ fontWeight: '500' }}>
                          {profile?.followerCount ?? 0}
                        </Txt>{' '}
                        followers
                      </Txt>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        if (user?.id) {
                          router.push(`/user/${user.id}/following` as any);
                        }
                      }}
                    >
                      <Txt variant="caption">
                        <Txt variant="caption" style={{ fontWeight: '500' }}>
                          {profile?.followingCount ?? 0}
                        </Txt>{' '}
                        following
                      </Txt>
                    </Pressable>
                  </View>
                </View>
              </View>

              {/* Bio */}
              {profile?.bio ? (
                <Txt variant="body" style={{ lineHeight: 20 }}>
                  {profile.bio}
                </Txt>
              ) : (
                <Txt variant="caption" color="muted" style={{ fontStyle: 'italic' }}>
                  No bio yet. Tap Edit profile to add one.
                </Txt>
              )}

              {/* Action Bar */}
              <View style={[sheet.row, { gap: space[2] }]}>
                <Button
                  label="Edit profile"
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setEditModalVisible(true);
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  label="Share profile"
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    void Haptics.selectionAsync();
                    // SO-51: <server>/@username, the server-rendered public profile.
                    Alert.alert('Share profile', profileShareUrl(user.username, PUBLIC_BASE));
                  }}
                  style={{ flex: 1 }}
                />
              </View>
            </View>

            {/* 2. FAVOURITES SECTION (Taste before volume) */}
            <View style={{ gap: space[2] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="title">
                  Defining favourites
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/profile/favourites' as any);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                    Edit 4
                  </Txt>
                </Pressable>
              </View>

              {/* 4 Favourite book covers */}
              <View style={styles.favouritesRow}>
                {[0, 1, 2, 3].map((idx) => {
                  const fav = profile?.favourites?.[idx];
                  if (fav) {
                    return (
                      <Pressable
                        key={fav.id}
                        onPress={() => {
                          void Haptics.selectionAsync();
                          router.push(`/work/${fav.id}` as any);
                        }}
                        style={styles.favItem}
                        accessibilityRole="button"
                        accessibilityLabel={fav.title}
                      >
                        <Cover coverId={fav.cover_id} title={fav.title} size="fluid" />
                        <Txt variant="caption" numberOfLines={1} style={{ marginTop: space[1] }}>
                          {fav.title}
                        </Txt>
                      </Pressable>
                    );
                  }

                  return (
                    <Pressable
                      key={`empty-${idx}`}
                      onPress={() => {
                        void Haptics.selectionAsync();
                        router.push('/profile/favourites' as any);
                      }}
                      style={[
                        styles.favItem,
                        styles.emptyFavSlot,
                        { borderColor: c.line, backgroundColor: c.surface },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Add favourite book"
                    >
                      <Txt variant="title" color="muted" style={{ fontSize: 17 }}>
                        +
                      </Txt>
                      <Txt variant="caption" color="muted">
                        Slot {idx + 1}
                      </Txt>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* 3. READING STATS STRIP */}
            <View style={{ gap: space[2] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="title">
                  {stats?.year ? `Reading in ${stats.year}` : 'Reading stats'}
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/stats' as any);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                    Full stats
                  </Txt>
                </Pressable>
              </View>

              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push('/stats' as any);
                }}
              >
                <View style={[sheet.row, { gap: space[2] }]}>
                  <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                    <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                      {stats?.books_count ?? finishedReads.length}
                    </Txt>
                    <Txt variant="caption" color="muted">
                      books read
                    </Txt>
                  </Card>

                  <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                    <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                      {(stats?.pages_count ?? 0).toLocaleString()}
                    </Txt>
                    <Txt variant="caption" color="muted">
                      pages tracked
                    </Txt>
                  </Card>

                  <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                    <View style={[sheet.row, { gap: space[1] }]}>
                      {stats?.avg_rating ? <Ionicons name="star" size={16} color={c.star} /> : null}
                      <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                        {stats?.avg_rating ? stats.avg_rating.toFixed(1) : '—'}
                      </Txt>
                    </View>
                    <Txt variant="caption" color="muted">
                      avg rating
                    </Txt>
                  </Card>
                </View>
              </Pressable>

              {/* Streak (§8.7: a broken one shows as the longest, never as a loss; nothing at all
                  for a reader who never logs progress) and the goal ring (§8.6). */}
              <View style={[sheet.row, { gap: space[2] }]}>
                {streak && (
                  <Card style={{ flex: 1, padding: space[3], justifyContent: 'center' }}>
                    <Txt variant="title" tabular style={{ fontSize: 24, lineHeight: 28 }}>
                      {streak.hero}
                    </Txt>
                    <Txt variant="caption" color="muted">
                      {streak.label}
                    </Txt>
                    {streak.detail && (
                      <Txt variant="caption" color="muted">
                        {streak.detail}
                      </Txt>
                    )}
                  </Card>
                )}
                <Card style={{ padding: space[3], alignItems: 'center', justifyContent: 'center' }}>
                  <GoalRing
                    model={goalRingModel(goal)}
                    emptyLabel="Set goal"
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setGoalSheetVisible(true);
                    }}
                  />
                </Card>
              </View>
            </View>

            {/* 4. CURRENTLY READING SHELF */}
            {currentlyReading.length > 0 && (
              <View style={{ gap: space[2] }}>
                <Txt variant="title">
                  Currently reading <Txt variant="title" color="muted" tabular>{currentlyReading.length}</Txt>
                </Txt>

                <View style={{ gap: space[2] }}>
                  {currentlyReading.slice(0, 2).map((r) => {
                    const pct = r.percent ?? (r.page && r.page_count ? Math.round((r.page / r.page_count) * 100) : 0);

                    return (
                      <Card
                        key={r.id}
                        onPress={() => router.push(`/work/${r.work_id}` as any)}
                        style={{ padding: space[3] }}
                      >
                        <View style={sheet.rowTop}>
                          <Cover coverId={r.cover_id} title={r.title ?? ''} size="m" />
                          <View style={{ flex: 1, marginLeft: space[3], gap: 4 }}>
                            <Txt variant="title" numberOfLines={1}>
                              {r.title}
                            </Txt>
                            <Txt variant="caption" color="muted" numberOfLines={1}>
                              {r.author_name}
                            </Txt>
                            <View style={{ marginTop: space[1], gap: 4 }}>
                              <ProgressBar percent={pct} />
                              <Txt variant="caption" color="muted">
                                {r.page ? `Page ${r.page}` : `${pct}% completed`}
                              </Txt>
                            </View>
                          </View>
                        </View>
                      </Card>
                    );
                  })}
                </View>
              </View>
            )}

            {/* 5. THE WALL PREVIEW */}
            {finishedReads.length > 0 && (
              <View style={{ gap: space[2] }}>
                <View style={sheet.rowBetween}>
                  <Txt variant="title">
                    The wall <Txt variant="title" color="muted" tabular>{finishedReads.length}</Txt>
                  </Txt>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push('/wall' as any);
                    }}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                      View wall
                    </Txt>
                  </Pressable>
                </View>

                {/* 6-poster preview grid */}
                <View style={styles.wallPreviewGrid}>
                  {finishedReads.slice(0, 6).map((r) => (
                    <Pressable
                      key={r.id}
                      onPress={() => {
                        void Haptics.selectionAsync();
                        router.push(`/work/${r.work_id}` as any);
                      }}
                      style={styles.wallPreviewItem}
                      accessibilityRole="button"
                      accessibilityLabel={r.title ?? 'Finished book'}
                    >
                      <Cover coverId={r.cover_id} title={r.title ?? ''} size="fluid" />
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {/* 6. RECENT DIARY PREVIEW */}
            <View style={{ gap: space[2] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="title">
                  Reading diary
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/diary' as any);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                    Open diary
                  </Txt>
                </Pressable>
              </View>

              <Card
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push('/diary' as any);
                }}
                style={{ padding: space[3] }}
              >
                <View style={sheet.rowBetween}>
                  <View style={{ gap: 2 }}>
                    <Txt variant="title" style={{ fontSize: 15, fontWeight: '500' }}>
                      Reading journal
                    </Txt>
                    <Txt variant="caption" color="muted">
                      List, monthly shelves and calendar
                    </Txt>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={c.muted} />
                </View>
              </Card>
            </View>

            {/* 7. FOLLOW REQUESTS (SO-02, SO-03) */}
            {profile?.isPrivate && (
              <Card
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push('/profile/requests' as any);
                }}
                style={{ padding: space[3] }}
              >
                <View style={sheet.rowBetween}>
                  <View style={{ gap: 2 }}>
                    <Txt variant="title" style={{ fontSize: 15, fontWeight: '500' }}>
                      Follow requests
                    </Txt>
                    <Txt variant="caption" color="muted">
                      Approve or decline who follows you
                    </Txt>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={c.muted} />
                </View>
              </Card>
            )}

            {/* 8. SETTINGS (LA-02): everything that used to be listed here. */}
            <Card
              onPress={() => {
                void Haptics.selectionAsync();
                router.push('/settings' as any);
              }}
              style={{ padding: space[3] }}
            >
              <View style={sheet.rowBetween}>
                <View style={{ gap: 2, flex: 1, marginRight: space[2] }}>
                  <Txt variant="title" style={{ fontSize: 15, fontWeight: '500' }}>
                    Settings
                  </Txt>
                  <Txt variant="caption" color="muted">
                    Account, privacy, notifications, blocked and muted, imports, appearance
                  </Txt>
                </View>
                <Ionicons name="chevron-forward" size={18} color={c.muted} />
              </View>
            </Card>
          </>
        ) : (
          <EmptyState
            title="Sign in to your library"
            subtitle="Keep your diary, four defining books, the wall and your stats on every device."
            action={
              <Button
                label="Sign in or create account"
                variant="primary"
                onPress={() => router.push('/auth')}
              />
            }
          />
        )}

      </ScrollView>

      <GoalSheet
        visible={goalSheetVisible}
        year={goal?.year ?? new Date().getFullYear()}
        goal={goal}
        onClose={() => setGoalSheetVisible(false)}
        onSaved={setGoal}
      />

      {/* EDIT PROFILE MODAL */}
      <Modal
        visible={editModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditModalVisible(false)}
      >
        <Screen style={{ flex: 1, backgroundColor: c.ground }}>
          {/* Modal Header */}
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
                onPress={() => setEditModalVisible(false)}
                style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
              >
                <Txt variant="body" color="muted">
                  Cancel
                </Txt>
              </Pressable>

              <Txt variant="title" style={{ fontWeight: '500', fontSize: 17 }}>
                Edit profile
              </Txt>

              <Pressable
                onPress={handleSaveProfile}
                disabled={savingProfile}
                style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
              >
                {savingProfile ? (
                  <ActivityIndicator size="small" color={c.accent} />
                ) : (
                  <Txt variant="body" color="accent" style={{ fontWeight: '500' }}>
                    Save
                  </Txt>
                )}
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4] }}>
            {/* Display Name */}
            <View style={{ gap: space[1] }}>
              <Txt variant="caption" color="muted" style={{ fontWeight: '500' }}>
                Display name
              </Txt>
              <TextInput
                value={editDisplayName}
                onChangeText={setEditDisplayName}
                placeholder="Your name"
                placeholderTextColor={c.muted}
                style={[
                  styles.textInput,
                  { backgroundColor: c.surface, borderColor: c.line, color: c.ink },
                ]}
              />
            </View>

            {/* Bio (<= 160 chars) */}
            <View style={{ gap: space[1] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="caption" color="muted" style={{ fontWeight: '500' }}>
                  Bio
                </Txt>
                <Txt
                  variant="caption"
                  color={editBio.length > 160 ? 'accent' : 'muted'}
                  style={{ fontSize: 12 }}
                >
                  {editBio.length}/160
                </Txt>
              </View>
              <TextInput
                value={editBio}
                onChangeText={setEditBio}
                placeholder="What you love to read"
                placeholderTextColor={c.muted}
                multiline
                numberOfLines={3}
                maxLength={160}
                style={[
                  styles.textArea,
                  { backgroundColor: c.surface, borderColor: c.line, color: c.ink },
                ]}
              />
            </View>

            <Txt variant="caption" color="muted">
              Private account and other privacy settings are in Settings, Privacy
            </Txt>
          </ScrollView>
        </Screen>
      </Modal>
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
    justifyContent: 'space-between',
    gap: space[2],
  },
  favItem: {
    width: '23%',
    aspectRatio: 2 / 3,
  },
  emptyFavSlot: {
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  wallPreviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  wallPreviewItem: {
    width: '31.3%',
    aspectRatio: 2 / 3,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  textInput: {
    height: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space[3],
    fontSize: 15,
  },
  textArea: {
    height: 84,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space[3],
    paddingTop: space[2],
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
