// Settings → Privacy (LA-02, PRD §6.43): the private-account toggle
// (PATCH /me/profile isPrivate). Going private hides existing public activity
// in the same transaction (activity setAccountPrivacy); going public accepts
// pending follow requests. Both are confirmed first.
//
// Not here, because the API has no setting for them (owner decision on LA-02):
// default read and review visibility, activity visibility, searchable by email.
// Each read and review keeps its own visibility, chosen when it is posted.

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { PRIVATE_ACCOUNT_DETAIL, privacyConfirm } from '@/lib/settings';
import { Button, EmptyState, Screen, Txt, SkeletonSettings } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { Group, SwitchRow } from '@/ui/SettingsRows';
import { space, useTheme } from '@/ui/tokens';

export default function PrivacySettingsScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const [isPrivate, setIsPrivate] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIsPrivate((await api.myProfile()).isPrivate);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = (next: boolean) => {
    const copy = privacyConfirm(next);
    Alert.alert(copy.title, copy.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: copy.action,
        onPress: async () => {
          setSaving(true);
          setError(null);
          try {
            setIsPrivate((await api.updateProfile({ isPrivate: next })).isPrivate);
          } catch {
            setError('Your privacy setting was not changed. Try again in a moment.');
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <ScreenHeader title="Privacy" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[3] }}>
        {isPrivate === null ? (
          loadFailed ? (
            <EmptyState
              title="Could not load your privacy setting"
              subtitle="Check your connection and try again."
              action={<Button label="Try again" variant="primary" onPress={() => void load()} />}
            />
          ) : (
            <View accessible accessibilityLabel="Loading privacy setting">
              <SkeletonSettings rows={1} />
            </View>
          )
        ) : (
          <>
            <Group>
              <SwitchRow
                label="Private account"
                detail={PRIVATE_ACCOUNT_DETAIL}
                value={isPrivate}
                disabled={saving}
                onValueChange={change}
              />
            </Group>
            {error ? (
              <View accessibilityLiveRegion="polite">
                <Txt variant="caption" color="critical">
                  {error}
                </Txt>
              </View>
            ) : null}
            <Txt variant="caption" color="muted">
              Each read and review also has its own visibility (public, followers or only you), chosen when you post it.
            </Txt>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
