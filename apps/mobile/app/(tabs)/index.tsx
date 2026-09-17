// Tab 1 — Home / Feed (PRD §5.2, design.md §10).
//
// Social feed segmented by Friends and Popular.
// Reviewed and finished cards are cover-forward.
// Notifications bell in header.

import React, { useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import {
  Card,
  Cover,
  EmptyState,
  Screen,
  SegmentedControl,
  Stars,
  Txt,
  sheet,
} from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function HomeScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { migrationMessage, dismissMigrationMessage } = useGuestShelf();
  const [feedMode, setFeedMode] = useState<'friends' | 'popular'>('popular');

  return (
    <Screen>
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
          <>
            {/* Featured community review card */}
            <Card onPress={() => {}}>
              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                <View style={sheet.row}>
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      backgroundColor: c.surface2,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Txt variant="caption" color="ink2" style={{ fontWeight: '600' }}>
                      P
                    </Txt>
                  </View>
                  <Txt variant="caption" color="ink2" style={{ fontWeight: '600' }}>
                    paloma
                  </Txt>
                </View>
                <Txt variant="caption" color="muted">
                  finished
                </Txt>
              </View>

              <View style={sheet.rowTop}>
                <Cover coverId={8231856} title="Piranesi" author="Susanna Clarke" size="s" />
                <View style={{ flex: 1, gap: space[1] }}>
                  <Txt variant="title">Piranesi</Txt>
                  <Txt variant="caption" color="muted">
                    Susanna Clarke
                  </Txt>
                  <Stars value={5} size={20} />
                </View>
              </View>

              <Txt variant="bodyL" color="ink" numberOfLines={3}>
                The Beauty of the House is immeasurable; its Kindness infinite. A breathtaking,
                reverent puzzle of a novel.
              </Txt>
            </Card>

            {/* Reading update card */}
            <Card onPress={() => {}}>
              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                <View style={sheet.row}>
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      backgroundColor: c.surface2,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Txt variant="caption" color="ink2" style={{ fontWeight: '600' }}>
                      E
                    </Txt>
                  </View>
                  <Txt variant="caption" color="ink2" style={{ fontWeight: '600' }}>
                    elena
                  </Txt>
                </View>
                <Txt variant="caption" color="muted">
                  started reading
                </Txt>
              </View>

              <View style={sheet.rowTop}>
                <Cover
                  coverId={8231990}
                  title="The Left Hand of Darkness"
                  author="Ursula K. Le Guin"
                  size="s"
                />
                <View style={{ flex: 1, gap: space[1] }}>
                  <Txt variant="title">The Left Hand of Darkness</Txt>
                  <Txt variant="caption" color="muted">
                    Ursula K. Le Guin
                  </Txt>
                  <Txt variant="caption" color="muted">
                    First read · 1969
                  </Txt>
                </View>
              </View>
            </Card>
          </>
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
