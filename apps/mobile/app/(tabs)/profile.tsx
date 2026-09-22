// Tab 5 — Profile (PRD §5.2, §6.18, §6.39, SL-72).
//
// First-class profile:
// 1. Identity header: Avatar, Display Name, Bio, Followers/Following, Privacy lock.
// 2. Favourites: 4 ordered defining books with direct link to picker (/profile/favourites).
// 3. Stats Strip: Live volume cards (books, pages, avg rating) with link to /stats.
// 4. Currently Reading: Real-time progress on active books.
// 5. The Wall preview: Latest finished posters with link to /wall.
// 6. Diary preview: Recent finished entries with link to /diary.
// 7. Edit Profile modal (bio <= 160 chars, display name, privacy toggle).
// 8. Theme switcher (system / light / dark).

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  Switch,
  Modal,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import {
  api,
  type Profile,
  type ReadingStats,
} from '@/lib/api';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  ProgressBar,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme, useThemeContext, type ThemeMode } from '@/ui/tokens';

export default function ProfileScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useSession();
  const { mode, setMode } = useThemeContext();
  const db = useDatabase();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [reads, setReads] = useState<LocalRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Edit Profile Modal
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editIsPrivate, setEditIsPrivate] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  // Load all profile data
  const loadData = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      // 1. Fetch profile & stats in parallel
      const [profileRes, statsRes] = await Promise.allSettled([
        api.myProfile(),
        api.myStats(),
      ]);

      if (profileRes.status === 'fulfilled') {
        setProfile(profileRes.value);
        setEditDisplayName(profileRes.value.displayName || '');
        setEditBio(profileRes.value.bio || '');
        setEditIsPrivate(profileRes.value.isPrivate);
      }

      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      }

      // 2. Fetch local reads for Currently Reading and Wall
      if (db) {
        const repo = new OfflineRepository(db);
        const local = await repo.getLocalReads();
        setReads(local);
      }
    } finally {
      setLoading(false);
    }
  }, [user, db]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
  const finishedReads = useMemo(() => {
    return reads.filter((r) => r.status === 'finished');
  }, [reads]);

  // Save profile edits
  const handleSaveProfile = async () => {
    if (editBio.length > 160) {
      Alert.alert('Bio Too Long', 'Bio must be 160 characters or fewer.');
      return;
    }

    try {
      setSavingProfile(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const updated = await api.updateProfile({
        displayName: editDisplayName.trim() || null,
        bio: editBio.trim() || null,
        isPrivate: editIsPrivate,
      });
      setProfile(updated);
      setEditModalVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to update profile. Please try again.');
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
          <Txt variant="title" style={{ fontWeight: '800', fontSize: 22 }}>
            Profile
          </Txt>
          {user && (
            <Button
              label="Sign out"
              variant="tertiary"
              size="sm"
              onPress={() => {
                void Haptics.selectionAsync();
                signOut();
              }}
            />
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
        {user ? (
          <>
            {/* 1. IDENTITY HEADER */}
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
                    {(profile?.displayName || user.username).charAt(0).toUpperCase()}
                  </Txt>
                </View>

                {/* Identity Info */}
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={sheet.row}>
                    <Txt variant="title" style={{ fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
                      {profile?.displayName || user.username}
                    </Txt>
                    {profile?.isPrivate && (
                      <Txt variant="caption" color="muted" style={{ marginLeft: 6 }}>
                        🔒
                      </Txt>
                    )}
                  </View>

                  <Txt variant="caption" color="muted">
                    @{user.username}
                  </Txt>

                  {/* Follower / Following count */}
                  <View style={[sheet.row, { gap: space[3], marginTop: space[1] }]}>
                    <Txt variant="caption">
                      <Txt variant="caption" style={{ fontWeight: '700' }}>
                        {profile?.followerCount ?? 0}
                      </Txt>{' '}
                      followers
                    </Txt>
                    <Txt variant="caption">
                      <Txt variant="caption" style={{ fontWeight: '700' }}>
                        {profile?.followingCount ?? 0}
                      </Txt>{' '}
                      following
                    </Txt>
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
                  No bio yet. Tap Edit profile to add a brief introduction.
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
                    Alert.alert('Share Profile', `flyleaf.app/u/${user.username}`);
                  }}
                  style={{ flex: 1 }}
                />
              </View>
            </View>

            {/* 2. FAVOURITES SECTION (Taste before volume) */}
            <View style={{ gap: space[2] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                  DEFINING FAVOURITES
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/profile/favourites' as any);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
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
                        <Txt variant="caption" numberOfLines={1} style={{ fontSize: 11, marginTop: 4 }}>
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
                      <Txt variant="title" color="muted" style={{ fontSize: 18 }}>
                        +
                      </Txt>
                      <Txt variant="caption" color="muted" style={{ fontSize: 10 }}>
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
                <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                  {stats?.year ? `${stats.year} READING STATS` : 'READING STATS'}
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/stats' as any);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                    Full Stats →
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
                    <Txt variant="title" tabular style={{ fontSize: 20, fontWeight: '800' }}>
                      {stats?.books_count ?? finishedReads.length}
                    </Txt>
                    <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                      books read
                    </Txt>
                  </Card>

                  <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                    <Txt variant="title" tabular style={{ fontSize: 20, fontWeight: '800' }}>
                      {(stats?.pages_count ?? 0).toLocaleString()}
                    </Txt>
                    <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                      pages tracked
                    </Txt>
                  </Card>

                  <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                    <Txt
                      variant="title"
                      tabular
                      style={{ fontSize: 20, fontWeight: '800', color: stats?.avg_rating ? c.accent : c.ink }}
                    >
                      {stats?.avg_rating ? `★ ${stats.avg_rating.toFixed(1)}` : '—'}
                    </Txt>
                    <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                      avg rating
                    </Txt>
                  </Card>
                </View>
              </Pressable>
            </View>

            {/* 4. CURRENTLY READING SHELF */}
            {currentlyReading.length > 0 && (
              <View style={{ gap: space[2] }}>
                <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                  CURRENTLY READING ({currentlyReading.length})
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
                              <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
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
                  <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                    THE WALL ({finishedReads.length})
                  </Txt>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      router.push('/wall' as any);
                    }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                      View Wall →
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
                <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                  READING DIARY
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/diary' as any);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                    Open Diary →
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
                    <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                      Complete Reading Journal
                    </Txt>
                    <Txt variant="caption" color="muted">
                      List, monthly poster shelves, and calendar heatmaps.
                    </Txt>
                  </View>
                  <Txt variant="title" color="accent">
                    →
                  </Txt>
                </View>
              </Card>
            </View>

            {/* 7. PRIVACY & SOCIAL (SO-02, SO-03) */}
            <View style={{ gap: space[2] }}>
              <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                PRIVACY & SOCIAL
              </Txt>

              <View style={{ gap: space[2] }}>
                {/* Follow Requests */}
                <Card
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/profile/requests' as any);
                  }}
                  style={{ padding: space[3] }}
                >
                  <View style={sheet.rowBetween}>
                    <View style={{ gap: 2 }}>
                      <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                        Follow Requests
                      </Txt>
                      <Txt variant="caption" color="muted">
                        Inspect and manage incoming follow requests.
                      </Txt>
                    </View>
                    <Txt variant="title" color="accent">
                      →
                    </Txt>
                  </View>
                </Card>

                {/* Blocked Accounts */}
                <Card
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/profile/blocked' as any);
                  }}
                  style={{ padding: space[3] }}
                >
                  <View style={sheet.rowBetween}>
                    <View style={{ gap: 2 }}>
                      <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                        Blocked Accounts
                      </Txt>
                      <Txt variant="caption" color="muted">
                        View and manage your blocked users list.
                      </Txt>
                    </View>
                    <Txt variant="title" color="accent">
                      →
                    </Txt>
                  </View>
                </Card>

                {/* Muted Content */}
                <Card
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/profile/muted' as any);
                  }}
                  style={{ padding: space[3] }}
                >
                  <View style={sheet.rowBetween}>
                    <View style={{ gap: 2 }}>
                      <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                        Muted Content
                      </Txt>
                      <Txt variant="caption" color="muted">
                        Inspect and manage muted users and muted books.
                      </Txt>
                    </View>
                    <Txt variant="title" color="accent">
                      →
                    </Txt>
                  </View>
                </Card>
              </View>
            </View>

            {/* 8. DATA & IMPORTS (IM-09) */}
            <View style={{ gap: space[2] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
                  DATA & IMPORTS
                </Txt>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push('/import' as any);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                    Import Library →
                  </Txt>
                </Pressable>
              </View>

              <Card
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push('/import' as any);
                }}
                style={{ padding: space[3] }}
              >
                <View style={sheet.rowBetween}>
                  <View style={{ gap: 2, flex: 1, marginRight: space[2] }}>
                    <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                      Import from Goodreads & StoryGraph
                    </Txt>
                    <Txt variant="caption" color="muted">
                      Bring your full reading history, ratings, and shelves into Flyleaf.
                    </Txt>
                  </View>
                  <Txt variant="title" color="accent">
                    →
                  </Txt>
                </View>
              </Card>
            </View>
          </>
        ) : (
          <EmptyState
            title="Sign in to your library"
            subtitle="Keep your reading diary, curate your 4 defining books, view The Wall, and track your stats across devices."
            action={
              <Button
                label="Sign in or create account"
                variant="primary"
                onPress={() => router.push('/auth')}
              />
            }
          />
        )}

        {/* 7. THEME PREFERENCE (SL-05) */}
        <View style={{ gap: space[2], paddingTop: space[2] }}>
          <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
            APPEARANCE & THEME
          </Txt>
          <SegmentedControl
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Warm Light' },
              { value: 'dark', label: 'Night Dark' },
            ]}
            value={mode}
            onChange={(val) => {
              void setMode(val as ThemeMode);
            }}
          />
        </View>
      </ScrollView>

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

              <Txt variant="title" style={{ fontWeight: '700', fontSize: 17 }}>
                Edit Profile
              </Txt>

              <Pressable
                onPress={handleSaveProfile}
                disabled={savingProfile}
                style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
              >
                {savingProfile ? (
                  <ActivityIndicator size="small" color={c.accent} />
                ) : (
                  <Txt variant="body" color="accent" style={{ fontWeight: '700' }}>
                    Save
                  </Txt>
                )}
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4] }}>
            {/* Display Name */}
            <View style={{ gap: space[1] }}>
              <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                Display Name
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
                <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                  Bio
                </Txt>
                <Txt
                  variant="caption"
                  color={editBio.length > 160 ? 'accent' : 'muted'}
                  style={{ fontSize: 11 }}
                >
                  {editBio.length}/160
                </Txt>
              </View>
              <TextInput
                value={editBio}
                onChangeText={setEditBio}
                placeholder="A brief sentence about what you love to read..."
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

            {/* Privacy Toggle */}
            <View
              style={[
                styles.privacyRow,
                { backgroundColor: c.surface, borderColor: c.line },
              ]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="body" style={{ fontWeight: '600' }}>
                  Private Profile
                </Txt>
                <Txt variant="caption" color="muted">
                  Only approved followers can view your reading diary and stats.
                </Txt>
              </View>
              <Switch
                value={editIsPrivate}
                onValueChange={setEditIsPrivate}
                trackColor={{ false: c.line, true: c.accent }}
              />
            </View>
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
    height: 46,
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
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space[3],
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: space[2],
  },
});
