// Settings root (LA-02, PRD §6.43): a grouped list, the app version and
// sign out. Reached from the Profile tab. The screens it lists keep their
// own routes (/profile/*, /import, /licences), so older links still work.

import React from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useSession } from '@/lib/session';
import { useOfflineSync } from '@/offline/sync';
import { settingsGroups, versionLabel } from '@/lib/settings';
import { Button, Screen, Txt } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { Group, NavRow, SectionTitle } from '@/ui/SettingsRows';
import { space, useTheme } from '@/ui/tokens';

export default function SettingsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useSession();
  const { unsyncedCount, deadLetterCount } = useOfflineSync();

  const onSignOut = () => {
    const waiting = unsyncedCount + deadLetterCount;
    const run = async () => {
      await signOut();
      router.dismissAll();
    };
    if (waiting === 0) {
      void run();
      return;
    }
    // Queued writes are kept for this account and sent when it signs in again
    // on this phone; they never replay for anyone else (A-07-002).
    Alert.alert(
      'Some updates have not synced',
      `${waiting} ${waiting === 1 ? 'update is' : 'updates are'} still on this phone. They will be sent next time you sign in here.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void run() },
      ],
    );
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <ScreenHeader title="Settings" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[2] }}>
        {user ? (
          <>
            {settingsGroups({ explicitSettingAvailable: Boolean(user.explicitSettingAvailable) }).map((g) => (
              <View key={g.title} style={{ gap: space[2] }}>
                <SectionTitle>{g.title}</SectionTitle>
                <Group>
                  {g.rows.map((r) => (
                    <NavRow
                      key={r.key}
                      label={r.label}
                      detail={r.detail}
                      destructive={r.destructive}
                      onPress={() => router.push(r.href as any)}
                    />
                  ))}
                </Group>
              </View>
            ))}
            <View style={{ marginTop: space[4] }}>
              <Button label="Sign out" variant="destructive" onPress={onSignOut} />
            </View>
          </>
        ) : (
          // A guest still has the app-level settings.
          <View style={{ gap: space[2] }}>
            <SectionTitle>App</SectionTitle>
            <Group>
              <NavRow label="Appearance" detail="Theme and text size" onPress={() => router.push('/settings/appearance' as any)} />
              <NavRow label="About & legal" detail="Terms, privacy policy, licences and data sources" onPress={() => router.push('/settings/about' as any)} />
            </Group>
          </View>
        )}
        <Txt variant="caption" color="muted" style={{ textAlign: 'center', marginTop: space[4] }}>
          {`Flyleaf · ${versionLabel(Constants.expoConfig?.version)}`}
        </Txt>
      </ScrollView>
    </Screen>
  );
}
