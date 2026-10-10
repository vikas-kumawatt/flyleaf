// Settings → Content (PRD §6 Settings, §7.8 [LOCKED], audit 10 A-07-036).
//
// One control: "Show explicit titles in search", off by default. Only an
// account with a confirmed date of birth at 18 or over sees it (GET /me
// explicitSettingAvailable); turning it on re-enters that date. The server
// enforces all of this; the screen only mirrors it.

import React, { useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, FlyleafApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Card, EmptyState, Field, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function ContentSettingsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refreshUser } = useSession();

  const [askingDob, setAskingDob] = useState(false);
  const [dob, setDob] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (showExplicit: boolean, dateOfBirth?: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.setContentSettings({ showExplicit, ...(dateOfBirth ? { dateOfBirth } : {}) });
      await refreshUser();
      setAskingDob(false);
      setDob('');
    } catch (err) {
      if (err instanceof FlyleafApiError && (err.status === 422 || err.status === 403)) setError(err.message);
      else setError('We could not save that just now. Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  const onToggle = (next: boolean) => {
    void Haptics.selectionAsync();
    setError(null);
    if (next) setAskingDob(true);
    else void save(false);
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <View style={{ paddingTop: insets.top + space[2], paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <View style={sheet.rowBetween}>
          <Button label="Back" variant="tertiary" onPress={() => router.back()} />
          <Txt variant="title">Content</Txt>
          <View style={{ width: 48 }} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: space[4], gap: space[3] }}>
        {!user?.explicitSettingAvailable ? (
          // Under 18, or no confirmed date of birth: the control does not exist (§7.8).
          <EmptyState title="No content settings" subtitle="There is nothing to change here for your account." />
        ) : (
          <Card style={{ padding: space[4], gap: space[3] }}>
            <View style={[sheet.rowBetween, { gap: space[3] }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                  Show explicit titles in search
                </Txt>
                <Txt variant="caption" color="muted">
                  Only search changes. Your own diary, shelves and stats always show every book you log.
                </Txt>
              </View>
              <Switch
                value={askingDob || Boolean(user.showExplicit)}
                onValueChange={onToggle}
                disabled={saving}
                accessibilityLabel="Show explicit titles in search"
              />
            </View>
            {askingDob && (
              <View style={{ gap: space[2] }}>
                <Field
                  label="Re-enter your date of birth"
                  value={dob}
                  onChangeText={(v) => {
                    setDob(v);
                    setError(null);
                  }}
                  placeholder="YYYY-MM-DD"
                  keyboardType="number-pad"
                  error={error ?? undefined}
                />
                <Button
                  label={saving ? 'Saving…' : 'Turn on'}
                  variant="primary"
                  disabled={saving || dob.trim().length === 0}
                  onPress={() => void save(true, dob.trim())}
                />
                <Button label="Cancel" variant="tertiary" onPress={() => { setAskingDob(false); setDob(''); setError(null); }} />
              </View>
            )}
            {!askingDob && error && (
              <Txt variant="caption" color="critical">
                {error}
              </Txt>
            )}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
