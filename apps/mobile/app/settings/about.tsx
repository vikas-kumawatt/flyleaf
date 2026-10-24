// Settings → About & legal (LA-02, PRD §6.43, §41.1): terms, privacy policy,
// licences and data sources, with Open Library's attribution.
//
// Terms and the privacy policy are written in LA-13; until then their rows
// say so instead of opening a page (LEGAL_LINKS url null).

import React from 'react';
import { Linking, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { ASSET_CREDITS } from '@/lib/licences';
import { LEGAL_LINKS, LEGAL_PENDING, versionLabel } from '@/lib/settings';
import { Screen, Txt } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { Group, NavRow, SectionTitle } from '@/ui/SettingsRows';
import { space, useTheme } from '@/ui/tokens';

const OPEN_LIBRARY = ASSET_CREDITS.find((a) => a.name === 'Open Library');

export default function AboutSettingsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <ScreenHeader title="About & legal" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[2] }}>
        <SectionTitle>Legal</SectionTitle>
        <Group>
          {LEGAL_LINKS.map((l) => (
            <NavRow
              key={l.key}
              label={l.label}
              trailing={!l.href && !l.url ? LEGAL_PENDING : undefined}
              onPress={
                l.href ? () => router.push(l.href as any)
                : l.url ? () => void Linking.openURL(l.url!)
                : undefined
              }
            />
          ))}
        </Group>

        {OPEN_LIBRARY ? (
          <>
            <SectionTitle>Data sources</SectionTitle>
            <Group>
              <NavRow
                label={OPEN_LIBRARY.name}
                detail={`${OPEN_LIBRARY.notice} ${OPEN_LIBRARY.licence}.`}
                onPress={OPEN_LIBRARY.url ? () => void Linking.openURL(OPEN_LIBRARY.url!) : undefined}
              />
            </Group>
          </>
        ) : null}

        <Txt variant="caption" color="muted" style={{ textAlign: 'center', marginTop: space[4] }}>
          {`Flyleaf · ${versionLabel(Constants.expoConfig?.version)}`}
        </Txt>
      </ScrollView>
    </Screen>
  );
}
