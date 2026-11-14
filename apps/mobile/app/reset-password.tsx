// Password reset link target (PRD §6.5; audit 04 A-04-014 → audit 07).
//
// The email links to `${APP_BASE_URL}/reset-password?token=…`. Expired or used
// tokens get a clear explanation and a "send a new link" action (§6.5 Errors).

import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api, FlyleafApiError } from '@/lib/api';
import { validatePassword } from '@/lib/auth-validation';
import { transientAuthError, UNREACHABLE } from '@/lib/authErrors';
import { Button, Screen, Txt, sheet } from '@/ui/components';
import { fontFamilies, radius, space, useTheme } from '@/ui/tokens';
import { ScreenHeader } from '@/ui/ScreenHeader';

export default function ResetPasswordScreen() {
  const c = useTheme();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'form' | 'done' | 'expired'>(token ? 'form' : 'expired');

  const submit = async () => {
    setError(null);
    const check = validatePassword(password);
    if (!check.valid) {
      setError(check.error ?? 'Choose a longer password.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(token!, password);
      setState('done');
    } catch (err) {
      if (err instanceof FlyleafApiError && err.status === 400) {
        setState('expired');
      } else if (err instanceof FlyleafApiError && err.status === 422) {
        // e.g. "That password is too common to be safe."
        setError(err.message);
      } else {
        setError(transientAuthError(err) ?? UNREACHABLE);
      }
    } finally {
      setBusy(false);
    }
  };

  // Field cannot carry autoComplete / textContentType, which password managers
  // need here, so these two inputs are drawn to match Field with a label above.
  const input = [
    { backgroundColor: c.surface, borderColor: error ? c.critical : c.lineStrong, color: c.ink },
    { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], minHeight: 48, fontSize: 15, fontFamily: fontFamilies.uiRegular },
  ];

  if (state === 'done') {
    return (
      <Screen>
        <ScreenHeader title="New password" />
        <View style={[sheet.pad, { gap: space[4] }]}>
          <Txt variant="displayM">Password changed</Txt>
          <Txt variant="body" color="ink2">
            You have been signed out on every device. Sign in with your new password.
          </Txt>
          <Button label="Sign in" variant="primary" onPress={() => router.replace('/auth?mode=login' as any)} />
        </View>
      </Screen>
    );
  }

  if (state === 'expired') {
    return (
      <Screen>
        <ScreenHeader title="New password" />
        <View style={[sheet.pad, { gap: space[4] }]}>
          <Txt variant="displayM">This link has expired</Txt>
          <Txt variant="body" color="ink2">
            Reset links work once and expire after 60 minutes. Send yourself a new one.
          </Txt>
          <Button label="Send a new link" variant="primary" onPress={() => router.replace('/auth?mode=forgot' as any)} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="New password" />
      <ScrollView contentContainerStyle={[sheet.pad, { gap: space[4] }]} keyboardShouldPersistTaps="handled">
        <View style={{ gap: space[1] }}>
          <Txt variant="displayM">Choose a new password</Txt>
          <Txt variant="body" color="ink2">At least 10 characters</Txt>
        </View>
        <View style={{ gap: space[1] }}>
          <Txt variant="micro" color="ink2">New password</Txt>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            placeholder="New password"
            placeholderTextColor={c.muted}
            accessibilityLabel="New password"
            style={input}
          />
        </View>
        <View style={{ gap: space[1] }}>
          <Txt variant="micro" color="ink2">Confirm new password</Txt>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            placeholder="Confirm new password"
            placeholderTextColor={c.muted}
            accessibilityLabel="Confirm new password"
            style={input}
          />
          {error ? <Txt variant="caption" color="critical">{error}</Txt> : null}
        </View>
        <Button label="Change password" variant="primary" loading={busy} onPress={() => void submit()} />
      </ScrollView>
    </Screen>
  );
}
