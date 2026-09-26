// Password reset link target (PRD §6.5; audit 04 A-04-014 → audit 07).
//
// The email links to `${APP_BASE_URL}/reset-password?token=…`. Expired or used
// tokens get a clear explanation and a "send a new link" action (§6.5 Errors).

import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api, FlyleafApiError } from '@/lib/api';
import { validatePassword } from '@/lib/auth-validation';
import { Button, Screen, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

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
        setError('We could not reach Flyleaf. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const input = [
    { backgroundColor: c.surface, borderColor: c.line, color: c.ink },
    { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], minHeight: 48, fontSize: 15 },
  ];

  if (state === 'done') {
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt variant="displayM">Password changed</Txt>
          <Txt variant="body" color="muted">
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
        <View style={sheet.pad}>
          <Txt variant="displayM">This link has expired</Txt>
          <Txt variant="body" color="muted">
            Reset links work once and expire after 60 minutes. Send yourself a new one.
          </Txt>
          <Button label="Send a new link" variant="primary" onPress={() => router.replace('/auth?mode=forgot' as any)} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={sheet.pad} keyboardShouldPersistTaps="handled">
        <Txt variant="displayM">Choose a new password</Txt>
        <Txt variant="body" color="muted">At least 10 characters.</Txt>
        {error ? <Txt variant="caption" color="critical">{error}</Txt> : null}
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
        <Button label="Change password" variant="primary" loading={busy} onPress={() => void submit()} />
      </ScrollView>
    </Screen>
  );
}
