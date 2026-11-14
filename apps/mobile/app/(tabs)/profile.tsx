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
  Share,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { pickAndUploadAvatar, useAvatarSource, type AvatarSource } from '@/lib/avatar';
import { encodeShareOptions } from '@/lib/shareCard';
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
import { Button, Cover, EmptyState, ProgressBar, Screen, Txt, sheet, Skeleton } from '@/ui/components';
import { familyFor, fontFamilies, radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';
import { GoalRing } from '@/ui/GoalRing';
import { GoalSheet } from '@/ui/GoalSheet';
import { StatStrip } from '@/ui/StatCard';
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
          <Txt variant="displayL">Profile</Txt>
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
          // design.md §4: sections sit 32 apart.
          gap: space[8],
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
                <View style={{ flex: 1, gap: space[1] }}>
                  <View style={[sheet.row, { gap: space[2] }]}>
                    <View style={{ flexShrink: 1 }}>
                      <Txt variant="displayM" numberOfLines={2}>
                        {profile?.displayName || user.username}
                      </Txt>
                    </View>
                    {profile?.isPrivate && (
                      <Ionicons
                        name="lock-closed-outline"
                        size={16}
                        color={c.muted}
                        accessibilityLabel="Private account"
                      />
                    )}
                  </View>

                  <Txt variant="caption" color="muted" numberOfLines={1}>
                    @{user.username}
                  </Txt>
                </View>
              </View>

              {/* Counts */}
              <View style={[sheet.row, { gap: space[6], flexWrap: 'wrap' }]}>
                <Pressable
                  onPress={() => {
                    if (user?.id) {
                      router.push(`/user/${user.id}/followers` as any);
                    }
                  }}
                  accessibilityRole="button"
                  style={[sheet.row, { gap: space[1], minHeight: 44 }]}
                >
                  <Txt variant="body" tabular style={{ fontWeight: '500' }}>
                    {profile?.followerCount ?? 0}
                  </Txt>
                  <Txt variant="body" color="ink2">
                    followers
                  </Txt>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (user?.id) {
                      router.push(`/user/${user.id}/following` as any);
                    }
                  }}
                  accessibilityRole="button"
                  style={[sheet.row, { gap: space[1], minHeight: 44 }]}
                >
                  <Txt variant="body" tabular style={{ fontWeight: '500' }}>
                    {profile?.followingCount ?? 0}
                  </Txt>
                  <Txt variant="body" color="ink2">
                    following
                  </Txt>
                </Pressable>
              </View>

              {/* Bio */}
              {profile?.bio ? (
                <Txt variant="body">{profile.bio}</Txt>
              ) : (
                <Txt variant="caption" color="muted">
                  No bio yet · Edit profile to add one
                </Txt>
              )}

              {/* One action: edit. Sharing is a quiet text action beside it. */}
              <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
                <Button
                  label="Edit profile"
                  variant="secondary"
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setEditModalVisible(true);
                  }}
                />
                <Button
                  label="Share profile"
                  variant="tertiary"
                  onPress={() => {
                    void Haptics.selectionAsync();
                    // The profile card (PRD §6.45), or the link to the
                    // server-rendered public profile (SO-51).
                    const url = profileShareUrl(user.username, PUBLIC_BASE);
                    Alert.alert('Share profile', url, [
                      {
                        text: 'Share card',
                        onPress: () =>
                          router.push(
                            `/share?options=${encodeURIComponent(encodeShareOptions([{ label: 'Profile', card: { template: 'profile', userId: user.id } }]))}` as any,
                          ),
                      },
                      { text: 'Share link', onPress: () => void Share.share({ message: url, url }) },
                      { text: 'Cancel', style: 'cancel' },
                    ]);
                  }}
                />
              </View>
            </View>

            {loading && !profile ? (
              // First load: favourites and stats as their shapes (design.md §5).
              <View
                style={{ gap: space[6] }}
                accessible
                accessibilityLabel="Loading your profile"
                accessibilityState={{ busy: true }}
              >
                <View style={{ gap: space[3] }}>
                  <Skeleton width={140} height={24} />
                  <View style={{ flexDirection: 'row', gap: space[2] }}>
                    {[0, 1, 2, 3].map((k) => (
                      <View key={k} style={{ flex: 1, aspectRatio: 2 / 3 }}>
                        <Skeleton width="100%" height={0} borderRadius={radius.xs} style={{ flex: 1 }} />
                      </View>
                    ))}
                  </View>
                </View>
                <View style={{ gap: space[3] }}>
                  <Skeleton width={120} height={24} />
                  <Skeleton width="100%" height={72} borderRadius={radius.lg} />
                </View>
              </View>
            ) : (
              <>
                {/* 2. FAVOURITES (taste before volume) */}
                <Section
                  title="Favourites"
                  action={{
                    label: 'Edit',
                    accessibilityLabel: 'Edit favourites',
                    onPress: () => {
                      void Haptics.selectionAsync();
                      router.push('/profile/favourites' as any);
                    },
                  }}
                >
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
                            <View style={styles.favCover}>
                              <Cover coverId={fav.cover_id} title={fav.title} size="fluid" />
                            </View>
                            <Txt
                              variant="caption"
                              numberOfLines={2}
                              style={{ fontFamily: fontFamilies.displayRegular, marginTop: space[1] }}
                            >
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
                          style={styles.favItem}
                          accessibilityRole="button"
                          accessibilityLabel="Add favourite book"
                        >
                          <View style={[styles.favCover, styles.emptyFavSlot, { backgroundColor: c.surface2 }]}>
                            <Ionicons name="add-outline" size={22} color={c.muted} />
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </Section>

                {/* 3. READING STATS STRIP */}
                <Section
                  title={stats?.year ? `Reading in ${stats.year}` : 'Reading stats'}
                  action={{
                    label: 'Full stats',
                    onPress: () => {
                      void Haptics.selectionAsync();
                      router.push('/stats' as any);
                    },
                  }}
                >
                  <StatStrip
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push('/stats' as any);
                    }}
                    figures={[
                      { value: String(stats?.books_count ?? finishedReads.length), label: (stats?.books_count ?? finishedReads.length) === 1 ? 'book read' : 'books read' },
                      { value: (stats?.pages_count ?? 0).toLocaleString(), label: 'pages tracked' },
                      {
                        value: stats?.avg_rating ? stats.avg_rating.toFixed(1) : '—',
                        label: 'avg rating',
                        star: Boolean(stats?.avg_rating),
                      },
                    ]}
                  />

                  {/* Streak (§8.7: a broken one shows as the longest, never as a loss; nothing at all
                      for a reader who never logs progress) and the goal ring (§8.6). */}
                  <StatStrip
                    figures={streak ? [{ value: streak.hero, label: streak.label, detail: streak.detail ?? undefined }] : []}
                    trailing={
                      <GoalRing
                        model={goalRingModel(goal)}
                        emptyLabel="Set goal"
                        onPress={() => {
                          void Haptics.selectionAsync();
                          setGoalSheetVisible(true);
                        }}
                      />
                    }
                  />
                </Section>
              </>
            )}

            {/* 4. CURRENTLY READING */}
            {currentlyReading.length > 0 && (
              <Section title="Currently reading" count={currentlyReading.length}>
                <View>
                  {currentlyReading.slice(0, 2).map((r, index) => {
                    const pct = r.percent ?? (r.page && r.page_count ? Math.round((r.page / r.page_count) * 100) : 0);

                    return (
                      <Pressable
                        key={r.id}
                        onPress={() => router.push(`/work/${r.work_id}` as any)}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                          sheet.rowTop,
                          {
                            gap: space[3],
                            paddingVertical: space[3],
                            borderTopWidth: index ? 1 : 0,
                            borderTopColor: c.line,
                            backgroundColor: pressed ? c.surface2 : 'transparent',
                          },
                        ]}
                      >
                        <Cover coverId={r.cover_id} title={r.title ?? ''} author={r.author_name ?? undefined} size="s" />
                        <View style={{ flex: 1, gap: space[1] }}>
                          <Txt variant="title" numberOfLines={2}>
                            {r.title}
                          </Txt>
                          <Txt variant="caption" color="ink2" numberOfLines={1}>
                            {r.author_name}
                          </Txt>
                          <View style={{ marginTop: space[1], gap: space[1] }}>
                            <ProgressBar percent={pct} />
                            <Txt variant="caption" color="muted" tabular>
                              {r.page ? `Page ${r.page}` : `${pct}% completed`}
                            </Txt>
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </Section>
            )}

            {/* 5. THE WALL PREVIEW */}
            {finishedReads.length > 0 && (
              <Section
                title="The wall"
                count={finishedReads.length}
                action={{
                  label: 'View wall',
                  onPress: () => {
                    void Haptics.selectionAsync();
                    router.push('/wall' as any);
                  },
                }}
              >
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
              </Section>
            )}

            {/* 6. DIARY */}
            <Section
              title="Diary"
              action={{
                label: 'Open diary',
                onPress: () => {
                  void Haptics.selectionAsync();
                  router.push('/diary' as any);
                },
              }}
            >
              <LinkRow
                title="Reading journal"
                subtitle="List, monthly shelves and calendar"
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push('/diary' as any);
                }}
              />
            </Section>

            {/* 7. FOLLOW REQUESTS (SO-02, SO-03) and SETTINGS (LA-02) */}
            <Section title="Account">
              <View>
                {profile?.isPrivate && (
                  <LinkRow
                    title="Follow requests"
                    subtitle="Approve or decline who follows you"
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push('/profile/requests' as any);
                    }}
                  />
                )}
                <LinkRow
                  title="Settings"
                  subtitle="Account, privacy, notifications, blocked and muted, imports, appearance"
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/settings' as any);
                  }}
                />
              </View>
            </Section>
          </>
        ) : (
          <EmptyState
            title="Sign in to your library"
            subtitle="Keep your diary, four defining books, the wall and your stats on every device."
            action={
              <View style={{ gap: space[2], alignItems: 'center' }}>
                <Button label="Create account" variant="primary" onPress={() => router.push('/auth')} />
                <Button label="Sign in" variant="secondary" onPress={() => router.push('/auth')} />
              </View>
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
              <Button
                label="Cancel"
                variant="tertiary"
                size="sm"
                onPress={() => setEditModalVisible(false)}
                style={{ minHeight: 44 }}
              />

              <Txt variant="title">Edit profile</Txt>

              <Button
                label="Save"
                variant="tertiary"
                size="sm"
                onPress={handleSaveProfile}
                loading={savingProfile}
                style={{ minHeight: 44 }}
              />
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4] }}>
            {/* Display Name */}
            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="ink2">
                Display name
              </Txt>
              <TextInput
                value={editDisplayName}
                onChangeText={setEditDisplayName}
                placeholder="Your name"
                placeholderTextColor={c.muted}
                accessibilityLabel="Display name"
                style={[
                  styles.textInput,
                  { backgroundColor: c.surface, borderColor: c.lineStrong, color: c.ink, fontFamily: familyFor(false, '400') },
                ]}
              />
            </View>

            {/* Bio (<= 160 chars) */}
            <View style={{ gap: space[1] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="micro" color="ink2">
                  Bio
                </Txt>
                <Txt variant="micro" color={editBio.length > 160 ? 'accent' : 'muted'} tabular>
                  {editBio.length}/160
                </Txt>
              </View>
              <TextInput
                value={editBio}
                onChangeText={setEditBio}
                placeholder="What you love to read"
                placeholderTextColor={c.muted}
                accessibilityLabel="Bio"
                multiline
                numberOfLines={3}
                maxLength={160}
                style={[
                  styles.textArea,
                  { backgroundColor: c.surface, borderColor: c.lineStrong, color: c.ink, fontFamily: familyFor(false, '400') },
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

// A section of the page: a hairline rule, then a serif heading with an optional
// count and one quiet action (design.md §10, Profile).
function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: { label: string; accessibilityLabel?: string; onPress: () => void };
  children: React.ReactNode;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: space[3], paddingTop: space[4], borderTopWidth: 1, borderTopColor: c.line }}>
      <View style={[sheet.rowBetween, { gap: space[3] }]}>
        <View style={[sheet.row, { gap: space[2], flexShrink: 1 }]}>
          <Txt variant="displayM" style={{ flexShrink: 1 }}>
            {title}
          </Txt>
          {count !== undefined ? (
            <Txt variant="body" color="muted" tabular>
              {count}
            </Txt>
          ) : null}
        </View>
        {action ? (
          <Button
            label={action.label}
            accessibilityLabel={action.accessibilityLabel}
            variant="tertiary"
            size="sm"
            onPress={action.onPress}
            style={{ minHeight: 44 }}
          />
        ) : null}
      </View>
      {children}
    </View>
  );
}

// A ruled row that opens another screen.
function LinkRow({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) {
  const c = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        sheet.row,
        {
          gap: space[3],
          minHeight: 44,
          paddingVertical: space[3],
          borderTopWidth: 1,
          borderTopColor: c.line,
          backgroundColor: pressed ? c.surface2 : 'transparent',
        },
      ]}
    >
      <View style={{ flex: 1, gap: space[1] }}>
        <Txt variant="title">{title}</Txt>
        <Txt variant="caption" color="muted">
          {subtitle}
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  favouritesRow: {
    flexDirection: 'row',
    gap: space[2],
  },
  favItem: {
    flex: 1,
  },
  favCover: {
    width: '100%',
    aspectRatio: 2 / 3,
  },
  emptyFavSlot: {
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wallPreviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  wallPreviewItem: {
    width: '31.3%',
    aspectRatio: 2 / 3,
    borderRadius: radius.xs,
    overflow: 'hidden',
  },
  textInput: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space[3],
    fontSize: 15,
  },
  textArea: {
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space[3],
    paddingTop: space[2],
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
