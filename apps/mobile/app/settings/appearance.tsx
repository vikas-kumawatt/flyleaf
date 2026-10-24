// Settings → Appearance (LA-02, PRD §6.43): theme System / Light / Dark
// (useThemeContext, stored on the device; was on the Profile tab).
//
// Text size follows the phone's own font-size setting: every Txt scales with
// it (React Native's default), and LA-10 checks 200%. There is no in-app
// slider: the type scale in ui/tokens is fixed (owner decision on LA-02).

import React from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen, SegmentedControl, Txt } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { Group, NavRow, SectionTitle } from '@/ui/SettingsRows';
import { space, useTheme, useThemeContext, type ThemeMode } from '@/ui/tokens';

export default function AppearanceSettingsScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const { mode, setMode } = useThemeContext();

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <ScreenHeader title="Appearance" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[2] }}>
        <SectionTitle>Theme</SectionTitle>
        <SegmentedControl
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={mode}
          onChange={(val) => void setMode(val as ThemeMode)}
        />
        <Txt variant="caption" color="muted">
          System follows your phone, switching between light and dark with it.
        </Txt>

        <SectionTitle>Text size</SectionTitle>
        <Group>
          <NavRow label="Follows your phone" detail="Change the font size in your phone's display or accessibility settings and Flyleaf follows it." />
        </Group>
      </ScrollView>
    </Screen>
  );
}
