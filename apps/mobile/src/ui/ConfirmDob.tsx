// Asks for a date of birth the account never entered (D-07-3, A-07-004).
//
// Accounts made before the signup fix were stored with 2000-01-01. /v1/me says
// dobConfirmed false for them; until they answer, the server treats them as a
// minor for maturity rules. Asked at launch; "Not now" hides it until the next
// launch. The rules are signup's (validateDob mirrors the server's dobSchema).

import React, { useState } from 'react';
import { Modal, View } from 'react-native';
import { api, FlyleafApiError } from '@/lib/api';
import { validateDob } from '@/lib/auth-validation';
import { useSession } from '@/lib/session';
import { Button, Field, Txt } from './components';
import { radius, space, useTheme } from './tokens';

export function ConfirmDobPrompt() {
  const c = useTheme();
  const { user, refreshUser } = useSession();
  const [dismissed, setDismissed] = useState(false);
  const [dob, setDob] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Only an explicit false: a user restored offline may not carry the flag.
  if (!user || user.dobConfirmed !== false || dismissed) return null;

  const submit = async () => {
    const check = validateDob(dob.trim());
    if (!check.valid) {
      setError(check.error ?? 'Check your date of birth.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.confirmDateOfBirth(dob.trim());
      await refreshUser();
    } catch (err) {
      if (err instanceof FlyleafApiError && err.code === 'dob_already_confirmed') {
        // Confirmed on another device: nothing left to ask.
        await refreshUser().catch(() => setDismissed(true));
      } else if (err instanceof FlyleafApiError && err.status === 422) {
        setError(err.message);
      } else {
        setError('We could not save it just now. Try again in a moment.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setDismissed(true)}>
      <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}>
        <View
          accessibilityRole="alert"
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderTopWidth: 1,
            borderColor: c.line,
            padding: space[4],
            paddingBottom: space[8],
            gap: space[3],
          }}
        >
          <Txt variant="displayM">Confirm your date of birth</Txt>
          <Txt variant="body" color="muted">
            An earlier version of the app did not save the date you entered at signup. Until you confirm it, some
            content settings stay at their most restricted.
          </Txt>
          <Field
            label="Date of birth (age 13+)"
            value={dob}
            onChangeText={(v) => {
              setDob(v);
              setError(null);
            }}
            placeholder="YYYY-MM-DD"
            keyboardType="number-pad"
            error={error ?? undefined}
          />
          <Button label={saving ? 'Saving…' : 'Confirm'} variant="primary" disabled={saving} onPress={() => void submit()} />
          <Button label="Not now" variant="tertiary" onPress={() => setDismissed(true)} />
        </View>
      </View>
    </Modal>
  );
}
