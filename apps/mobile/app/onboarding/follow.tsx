// Onboarding: follow suggestions (SO-52, PRD §6.11).
//
// 12–15 reader cards (avatar, name, why they are suggested, their favourite
// covers, a follow button), "Follow all", and Continue. The server decides who
// may be suggested (never blocked, muted, private, followed or banned
// accounts) and ranks them; this screen only shows them. Skippable, like every
// onboarding step but sign-up (PRD §4.1). Shown after sign-up, and from the
// Home feed when it has no one in it.
//
// Follows go through the offline queue (D-07-2), like the profile's button.
// An unverified account cannot follow yet (D-04-1): the verify prompt opens
// instead of queuing a write that can only fail.
//
// Analytics: follow_suggestions_shown{count}, user_followed{source:onboarding}.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { api, type FollowSuggestion } from '@/lib/api';
import { track } from '@/lib/events';
import { suggestionReason, toFollowAll } from '@/lib/followSuggestions';
import { useSession } from '@/lib/session';
import { useOfflineSync } from '@/offline/sync';
import { Button, Card, Cover, EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function FollowSuggestionsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { setFollowing } = useOfflineSync();

  const [users, setUsers] = useState<FollowSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const shown = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await api.followSuggestions();
      setUsers(res.users);
      if (!shown.current) {
        shown.current = true;
        track('follow_suggestions_shown', { count: res.users.length });
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const done = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const follow = async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      for (const id of ids) {
        await setFollowing(id, true);
        track('user_followed', { source: 'onboarding' });
        setFollowed((prev) => new Set(prev).add(id));
      }
    } catch {
      // email_unverified has its own prompt; anything else stays retryable.
    } finally {
      setBusy(false);
    }
  };

  const unfollow = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await setFollowing(id, false);
      setFollowed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const remaining = toFollowAll(users, followed);

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <View style={{ paddingTop: insets.top + space[4], paddingHorizontal: space[4], paddingBottom: space[3], gap: space[1] }}>
        <Txt variant="displayL">Readers to follow</Txt>
        <Txt variant="caption" color="muted">
          Their reviews and finishes fill your feed. You can change this any time.
        </Txt>
      </View>

      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[12] * 2, gap: space[3] }}>
        {loading ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : failed ? (
          <EmptyState
            title="Could not load suggestions"
            subtitle="Check your connection and try again, or skip this step."
            action={<Button label="Try again" variant="outline" onPress={() => void load()} />}
          />
        ) : users.length === 0 ? (
          <EmptyState
            title="No suggestions yet"
            subtitle="As more readers join, we will suggest people who read what you read. The Popular feed has plenty in the meantime."
          />
        ) : (
          users.map((u) => {
            const isFollowed = followed.has(u.id);
            return (
              <Card key={u.id} style={{ padding: space[4], gap: space[3] }}>
                <View style={[sheet.rowTop, { gap: space[3] }]}>
                  <Pressable onPress={() => router.push(`/user/${u.id}` as any)} accessibilityRole="button" accessibilityLabel={`Open @${u.username}`}>
                    <View style={[styles.avatar, { backgroundColor: c.surface2, borderColor: c.line }]}>
                      <Txt variant="title" style={{ fontSize: 18, fontWeight: '500', color: c.ink2 }}>
                        {(u.display_name || u.username).charAt(0).toUpperCase()}
                      </Txt>
                    </View>
                  </Pressable>
                  <View style={{ flex: 1, gap: space[1] }}>
                    <Txt variant="body" style={{ fontWeight: '500' }} numberOfLines={1}>
                      {u.display_name || u.username}
                    </Txt>
                    <Txt variant="caption" color="muted" numberOfLines={1}>
                      @{u.username} · {suggestionReason(u.reason)}
                    </Txt>
                  </View>
                  <Button
                    label={isFollowed ? 'Following' : 'Follow'}
                    variant={isFollowed ? 'outline' : 'primary'}
                    size="sm"
                    disabled={busy}
                    onPress={() => void (isFollowed ? unfollow(u.id) : follow([u.id]))}
                  />
                </View>
                {u.favourites.length > 0 && (
                  <View style={[sheet.row, { gap: space[2] }]}>
                    {u.favourites.map((f) => (
                      <Cover key={f.id} coverId={f.cover_id} title={f.title} size="s" />
                    ))}
                  </View>
                )}
              </Card>
            );
          })
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space[3], backgroundColor: c.ground, borderTopColor: c.line }]}>
        {remaining.length > 1 && (
          <Button label={`Follow all ${remaining.length}`} variant="outline" disabled={busy} onPress={() => void follow(remaining)} style={{ flex: 1 }} />
        )}
        <Button label={followed.size > 0 ? 'Continue' : 'Skip'} onPress={done} style={{ flex: 1 }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: space[2],
    paddingHorizontal: space[4],
    paddingTop: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
