// Settings → Account (LA-02, PRD §6.43): email, username, password and the
// devices signed in to the account.
//
// - Username: PATCH /me/username, checked as it is typed (the sign-up check).
// - Password: there is no change-password endpoint (owner decision on LA-02),
//   so this sends the reset email (POST /auth/forgot-password).
// - Sessions: GET /auth/sessions, DELETE /auth/sessions/:id, POST /auth/logout-all.
//   The list does not say which session is this phone's; revoking it signs this
//   phone out at its next refresh, and "Sign out everywhere" signs out here at once.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Session } from '@flyleaf/api-client';
import { api, FlyleafApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { validateUsername } from '@/lib/auth-validation';
import { createUsernameChecker, type UsernameStatus } from '@/lib/usernameCheck';
import {
  lastUsedLabel,
  passwordResetSent,
  sessionLabel,
  SIGN_OUT_EVERYWHERE_WARNING,
  usernameChangeError,
} from '@/lib/settings';
import { Button, Field, Screen, Txt } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { Group, NavRow, SectionTitle } from '@/ui/SettingsRows';
import { space, useTheme } from '@/ui/tokens';

export default function AccountSettingsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refreshUser, signOut } = useSession();

  // Username
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [nameStatus, setNameStatus] = useState<UsernameStatus>({ state: 'idle' });
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const checker = useRef<ReturnType<typeof createUsernameChecker> | null>(null);
  checker.current ??= createUsernameChecker((u, signal) => api.checkUsername(u, signal), setNameStatus);
  useEffect(() => () => checker.current?.dispose(), []);

  // Password reset
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [sendingReset, setSendingReset] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.sessions());
      setSessionsFailed(false);
    } catch {
      setSessionsFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  if (!user) return null;

  const local = validateUsername(name);
  const normalised = name.trim().toLowerCase();
  const unchanged = normalised === user.username.toLowerCase();
  const nameHint =
    !name ? null
    : !local.valid ? local.error
    : unchanged ? 'That is your username now.'
    : nameStatus.state === 'checking' ? 'Checking…'
    : nameStatus.state === 'available' ? 'Available.'
    : nameStatus.state === 'unavailable'
      ? nameStatus.reason === 'taken' ? 'That username is taken.' : nameStatus.reason === 'reserved' ? 'That username is reserved.' : 'That username cannot be used.'
    : null;

  const saveName = async () => {
    setSavingName(true);
    setNameError(null);
    try {
      await api.changeUsername(normalised);
      await refreshUser();
      setEditingName(false);
      setName('');
    } catch (err) {
      setNameError(err instanceof FlyleafApiError ? usernameChangeError(err) : usernameChangeError({}));
    } finally {
      setSavingName(false);
    }
  };

  const sendReset = async () => {
    setSendingReset(true);
    try {
      await api.forgotPassword(user.email);
      setResetMessage(passwordResetSent(user.email));
    } catch {
      setResetMessage('The email was not sent. Try again in a moment.');
    } finally {
      setSendingReset(false);
    }
  };

  const revoke = (s: Session) => {
    Alert.alert(
      `Sign out ${sessionLabel(s)}?`,
      'That device will need to sign in again. If it is this phone, you will be signed out here shortly.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            setBusySession(s.id);
            try {
              await api.revokeSession(s.id);
              setSessions((list) => list?.filter((x) => x.id !== s.id) ?? null);
            } catch (err) {
              // Already gone (404) or a failure: the list from the server is the truth.
              if (!(err instanceof FlyleafApiError && err.status === 404)) {
                Alert.alert('Not signed out', 'Try again in a moment.');
              }
              await loadSessions();
            } finally {
              setBusySession(null);
            }
          },
        },
      ],
    );
  };

  const revokeAll = () => {
    Alert.alert('Sign out everywhere?', SIGN_OUT_EVERYWHERE_WARNING, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out everywhere',
        style: 'destructive',
        onPress: async () => {
          setBusySession('all');
          try {
            await api.logoutAll();
            await signOut();
            router.dismissAll();
          } catch {
            Alert.alert('Not signed out', 'Try again in a moment.');
            setBusySession(null);
          }
        },
      },
    ]);
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <ScreenHeader title="Account" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[2] }}
      >
        <SectionTitle>Sign-in</SectionTitle>
        <Group>
          <NavRow label="Email" detail={user.email} />
          <NavRow
            label="Username"
            detail={`@${user.username}`}
            onPress={() => {
              setEditingName((v) => !v);
              setName('');
              setNameError(null);
              checker.current?.update(null);
            }}
          />
          {editingName ? (
            <View style={{ padding: space[4], gap: space[2] }}>
              <Field
                label="New username"
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  setNameError(null);
                  const ok = validateUsername(v).valid && v.trim().toLowerCase() !== user.username.toLowerCase();
                  checker.current?.update(ok ? v.trim().toLowerCase() : null);
                }}
                placeholder={user.username}
                error={nameError ?? undefined}
              />
              {nameHint && !nameError ? (
                <Txt variant="caption" color={nameStatus.state === 'available' && local.valid && !unchanged ? 'positive' : 'muted'}>
                  {nameHint}
                </Txt>
              ) : null}
              <Txt variant="caption" color="muted">
                Links with your old username keep working, and nobody else can take it.
              </Txt>
              <Button
                label={savingName ? 'Saving…' : 'Change username'}
                variant="primary"
                disabled={savingName || !local.valid || unchanged || nameStatus.state === 'unavailable'}
                onPress={() => void saveName()}
              />
            </View>
          ) : null}
          <NavRow
            label="Password"
            detail={resetMessage ?? 'We will email you a link to choose a new password.'}
            trailing={sendingReset ? 'Sending…' : undefined}
            onPress={sendingReset ? undefined : () => void sendReset()}
          />
        </Group>

        <SectionTitle>Signed-in devices</SectionTitle>
        {sessions === null ? (
          sessionsFailed ? (
            <Group>
              <NavRow label="Could not load your devices" detail="Tap to try again" onPress={() => void loadSessions()} />
            </Group>
          ) : (
            <ActivityIndicator color={c.accent} accessibilityLabel="Loading signed-in devices" />
          )
        ) : (
          <Group>
            {sessions.map((s) => (
              <View
                key={s.id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[4], paddingVertical: space[3], gap: space[3], minHeight: 56 }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt variant="body" style={{ fontWeight: '500' }}>
                    {sessionLabel(s)}
                  </Txt>
                  <Txt variant="caption" color="muted">
                    {lastUsedLabel(s.lastUsedAt)}
                  </Txt>
                </View>
                <Button
                  label="Sign out"
                  variant="tertiary"
                  loading={busySession === s.id}
                  disabled={busySession !== null}
                  onPress={() => revoke(s)}
                  accessibilityLabel={`Sign out ${sessionLabel(s)}, ${lastUsedLabel(s.lastUsedAt)}`}
                />
              </View>
            ))}
            {sessions.length === 0 ? <NavRow label="No other devices" /> : null}
          </Group>
        )}
        <Button
          label="Sign out everywhere"
          variant="destructive"
          loading={busySession === 'all'}
          disabled={busySession !== null}
          onPress={revokeAll}
          style={{ marginTop: space[2] }}
        />
      </ScrollView>
    </Screen>
  );
}
