// Tab 5 — Profile (PRD §5.2, design.md §10, SL-05).
//
// Identity, avatar, 4 favourites, reading stats strip, and theme switching.

import React from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
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
import { space, useTheme, useThemeContext, type ThemeMode } from '@/ui/tokens';

export default function ProfileScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useSession();
  const { mode, setMode } = useThemeContext();

  return (
    <Screen>
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
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM">Profile</Txt>
          {user && (
            <Button
              label="Sign out"
              variant="tertiary"
              onPress={signOut}
              style={{ minHeight: 36, paddingHorizontal: space[2] }}
            />
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[12],
          gap: space[6],
        }}
      >
        {user ? (
          <>
            {/* User Identity Card */}
            <View style={[sheet.row, { gap: space[4] }]}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: c.accentSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: c.line,
                }}
              >
                <Txt variant="title" color="accent">
                  {user.username.charAt(0).toUpperCase()}
                </Txt>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="title">@{user.username}</Txt>
                <Txt variant="caption" color="muted">
                  {user.email}
                </Txt>
              </View>
            </View>

            {/* Favourites Section (Taste comes before quantity) */}
            <View style={{ gap: space[3] }}>
              <Txt variant="micro" color="muted">
                FAVOURITE BOOKS
              </Txt>
              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                <Cover coverId={8231856} title="Piranesi" size="s" />
                <Cover coverId={8231990} title="The Left Hand of Darkness" size="s" />
                <Cover coverId={10521270} title="Klara and the Sun" size="s" />
                <Cover coverId={3155564} title="Invisible Cities" size="s" />
              </View>
            </View>

            {/* Reading Stats Strip */}
            <View style={{ gap: space[3] }}>
              <Txt variant="micro" color="muted">
                2026 STATS
              </Txt>
              <View style={[sheet.row, { gap: space[3] }]}>
                <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                  <Txt variant="displayM" tabular>
                    14
                  </Txt>
                  <Txt variant="caption" color="muted">
                    books read
                  </Txt>
                </Card>
                <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                  <Txt variant="displayM" tabular>
                    4,120
                  </Txt>
                  <Txt variant="caption" color="muted">
                    pages tracked
                  </Txt>
                </Card>
                <Card style={{ flex: 1, alignItems: 'center', padding: space[3] }}>
                  <Txt variant="displayM" tabular>
                    4.2
                  </Txt>
                  <Txt variant="caption" color="muted">
                    avg rating
                  </Txt>
                </Card>
              </View>
            </View>
          </>
        ) : (
          <EmptyState
            title="Sign in to your library"
            subtitle="Keep your reading diary, track daily pages, and save your favourite books across devices."
            action={
              <Button
                label="Sign in or create account"
                variant="primary"
                onPress={() => router.push('/auth')}
              />
            }
          />
        )}

        {/* Theme Preference Switcher (SL-05) */}
        <View style={{ gap: space[3], paddingTop: space[2] }}>
          <Txt variant="micro" color="muted">
            APPEARANCE (THEME)
          </Txt>
          <SegmentedControl
            values={['system', 'light', 'dark'] as const}
            selected={mode}
            onSelect={(val) => {
              void setMode(val as ThemeMode);
            }}
            labels={{
              system: 'System default',
              light: 'Light',
              dark: 'Dark (Night)',
            }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
