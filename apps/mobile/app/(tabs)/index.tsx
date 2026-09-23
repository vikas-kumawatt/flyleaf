// Tab 1 — Home / Feed (PRD §5.2, §12, SO-15).
//
// Social feed segmented by Friends and Popular.
// Supports FeedCard types (reviews, finishes, DNF, aggregated shelf/follows, cold start cards)
// and interactive Swipe Actions (Swipe Right -> Want to read, Swipe Left -> Rate & Review).

import React, { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import { FeedCard } from '@/ui/FeedCard';
import { type FeedActivityItem } from '@/lib/feedCard';
import {
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

// Sample feed items covering distinct card types & cold start badges
const SAMPLE_FEED_ITEMS: FeedActivityItem[] = [
  {
    id: 'f1',
    actor_id: 'u_paloma',
    actor: { id: 'u_paloma', username: 'paloma', display_name: 'Paloma', avatar_url: null },
    verb: 'reviewed',
    work_id: 'w_piranesi',
    work: { id: 'w_piranesi', title: 'Piranesi', author_name: 'Susanna Clarke', cover_id: 8231856 },
    object_type: 'read',
    object_id: 'r1',
    metadata: {
      rating: 5,
      review_text: 'The Beauty of the House is immeasurable; its Kindness infinite. A breathtaking, reverent puzzle of a novel.',
      like_count: 14,
      comment_count: 3,
    },
    visibility: 'public',
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'f2',
    actor_id: 'u_elena',
    actor: { id: 'u_elena', username: 'elena', display_name: 'Elena', avatar_url: null },
    verb: 'started',
    work_id: 'w_left_hand',
    work: { id: 'w_left_hand', title: 'The Left Hand of Darkness', author_name: 'Ursula K. Le Guin', cover_id: 8231990 },
    object_type: 'read',
    object_id: 'r2',
    metadata: {
      like_count: 5,
      comment_count: 0,
    },
    visibility: 'public',
    created_at: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    id: 'f3',
    actor_id: 'u_marcus',
    actor: { id: 'u_marcus', username: 'marcus', display_name: 'Marcus', avatar_url: null },
    verb: 'shelved',
    work_id: null,
    work: null,
    object_type: 'shelf',
    object_id: 's_sci_fi',
    metadata: {
      is_aggregated: true,
      count: 4,
      shelf_name: 'Essential Sci-Fi Classics',
      works: [
        { id: 'w1', title: 'Dune', cover_id: 8231856 },
        { id: 'w2', title: 'Neuromancer', cover_id: 8231990 },
      ],
      like_count: 8,
    },
    visibility: 'public',
    created_at: new Date(Date.now() - 14400000).toISOString(),
  },
  {
    id: 'f4',
    actor_id: 'u_trend',
    actor: { id: 'u_trend', username: 'bookish_sam', display_name: 'Sam', avatar_url: null },
    verb: 'finished',
    work_id: 'w_dune',
    work: { id: 'w_dune', title: 'Dune Messiah', author_name: 'Frank Herbert', cover_id: 8231856 },
    object_type: 'read',
    object_id: 'r4',
    metadata: {
      rating: 4.5,
      is_blended_popular: true,
      label: 'Popular on Flyleaf',
      like_count: 32,
      comment_count: 7,
    },
    visibility: 'public',
    created_at: new Date(Date.now() - 28800000).toISOString(),
  },
];

export default function HomeScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { migrationMessage, dismissMigrationMessage } = useGuestShelf();
  const [feedMode, setFeedMode] = useState<'friends' | 'popular'>('popular');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  };

  const handleWantToRead = (workId: string) => {
    if (!user) {
      promptAuth({ title: 'Sign in to save books to your Want to Read shelf' });
      return;
    }
    showToast('Saved to Want to Read');
  };

  const handleRateAndReview = (workId: string) => {
    if (!user) {
      promptAuth({ title: 'Sign in to rate and review books' });
      return;
    }
    router.push({ pathname: '/log', params: { workId } });
  };

  return (
    <Screen>
      {/* Toast Notification for Swipe Actions */}
      {toastMessage && (
        <View
          style={{
            position: 'absolute',
            top: insets.top + space[2],
            left: space[4],
            right: space[4],
            zIndex: 999,
            backgroundColor: c.accent,
            paddingHorizontal: space[4],
            paddingVertical: space[3],
            borderRadius: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.15,
            shadowRadius: 6,
            elevation: 4,
          }}
        >
          <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
          <Txt variant="body" color="ground" style={{ fontWeight: '600', flex: 1 }}>
            {toastMessage}
          </Txt>
        </View>
      )}

      {/* Migration Confirmation Banner (PRD §4.2, SL-33) */}
      {migrationMessage && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: c.accentSoft,
            paddingHorizontal: space[4],
            paddingVertical: space[3],
            gap: space[3],
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          }}
        >
          <Ionicons name="bookmark" size={20} color={c.accent} />
          <Txt variant="body" color="accent" style={{ flex: 1, fontWeight: '500' }}>
            {migrationMessage}
          </Txt>
          <Pressable
            onPress={dismissMigrationMessage}
            accessibilityRole="button"
            accessibilityLabel="Dismiss confirmation"
            hitSlop={8}
          >
            <Ionicons name="close" size={20} color={c.muted} />
          </Pressable>
        </View>
      )}

      {/* Header with Title and Notifications Bell */}
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
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM">Flyleaf</Txt>
          <View style={sheet.row}>
            {user ? (
              <Pressable
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                accessibilityRole="button"
                accessibilityLabel="Notifications"
                style={styles.headerIconButton}
              >
                <Ionicons name="notifications-outline" size={22} color={c.ink} />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push('/auth')}
                accessibilityRole="button"
                accessibilityLabel="Sign in"
              >
                <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                  Sign in
                </Txt>
              </Pressable>
            )}
          </View>
        </View>

        {/* Segmented feed switcher */}
        <View style={{ marginTop: space[3] }}>
          <SegmentedControl
            values={['friends', 'popular'] as const}
            selected={feedMode}
            onSelect={setFeedMode}
            labels={{
              friends: 'Following',
              popular: 'Popular',
            }}
          />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[12],
          gap: space[4],
        }}
      >
        {feedMode === 'friends' && !user ? (
          <EmptyState
            title="Follow readers to see their activity"
            subtitle="Sign in to follow friends, discover book recommendations, and see reviews in your personal feed."
            action={
              <Pressable onPress={() => router.push('/auth')}>
                <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                  Sign in to Flyleaf
                </Txt>
              </Pressable>
            }
          />
        ) : (
          SAMPLE_FEED_ITEMS.map((item) => (
            <FeedCard
              key={item.id}
              item={item}
              onWantToRead={handleWantToRead}
              onRateAndReview={handleRateAndReview}
            />
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
