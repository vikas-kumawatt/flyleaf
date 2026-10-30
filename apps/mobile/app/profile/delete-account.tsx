// Settings → Delete account (LA-01, PRD §25.4, AC-17). A store requirement:
// it must be completable in the app.
//
// Step 1: what will be lost, the 30-day grace, and an export offered first.
// Step 2: password re-entry and a final confirmation naming the consequences.
// The server does the deleting (DELETE /v1/me ends every session); this
// screen then signs out on the phone, as the Sign out button does.

import React, { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  deletedMessage,
  deleteErrorMessage,
  GRACE_PROMISE,
  WHAT_IS_LOST,
  WHAT_STAYS,
} from '@/lib/accountDeletion';
import { Button, Card, EmptyState, Field, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function DeleteAccountScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useSession();

  const [step, setStep] = useState<'consequences' | 'confirm'>('consequences');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await api.deleteAccount(password);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await signOut();
      router.replace('/(tabs)/profile' as any);
      Alert.alert('Account deleted', deletedMessage(res.purgeAfter));
    } catch (err) {
      setError(deleteErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const confirm = () => {
    void Haptics.selectionAsync();
    Alert.alert(
      'Delete your account?',
      `No one will be able to see your profile, reads or reviews from now on. ${GRACE_PROMISE}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: () => void remove() },
      ],
    );
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <View style={{ paddingTop: insets.top + space[2], paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <View style={sheet.rowBetween}>
          <Button label="Back" variant="tertiary" onPress={() => router.back()} />
          <Txt variant="title">Delete account</Txt>
          <View style={{ width: 48 }} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[3] }}>
        {!user ? (
          <EmptyState title="Not signed in" subtitle="Sign in to delete your account" />
        ) : step === 'consequences' ? (
          <>
            <Card style={{ padding: space[4], gap: space[2] }}>
              <Txt variant="body" style={{ fontWeight: '500' }}>
                What will be deleted
              </Txt>
              {WHAT_IS_LOST.map((line) => (
                <Txt key={line} variant="body">
                  {`• ${line}`}
                </Txt>
              ))}
              <Txt variant="caption" color="muted">
                {WHAT_STAYS}
              </Txt>
            </Card>

            <Card style={{ padding: space[4], gap: space[2] }}>
              <Txt variant="body" style={{ fontWeight: '500' }}>
                30 days to change your mind
              </Txt>
              <Txt variant="body">{GRACE_PROMISE} After that it is permanent.</Txt>
            </Card>

            {/* PRD §25.4 step 7: the export is offered before deletion. */}
            <Card style={{ padding: space[4], gap: space[2] }}>
              <Txt variant="body" style={{ fontWeight: '500' }}>
                Keep a copy first
              </Txt>
              <Txt variant="body">
                Export your library as CSV or JSON. The link is emailed to you and still works after you delete your account.
              </Txt>
              <Button
                label="Export my library"
                variant="secondary"
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push('/import' as any);
                }}
              />
            </Card>

            <Button
              label="Continue"
              variant="destructive"
              onPress={() => {
                void Haptics.selectionAsync();
                setStep('confirm');
              }}
            />
          </>
        ) : (
          <Card style={{ padding: space[4], gap: space[3] }}>
            <Txt variant="body">
              Enter your password to delete <Txt variant="body" style={{ fontWeight: '500' }}>@{user.username}</Txt>. Your
              profile, reads, reviews and shelves disappear for everyone straight away, and you are signed out on every device.
            </Txt>
            <Field
              label="Password"
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                setError(null);
              }}
              secureTextEntry
              error={error ?? undefined}
            />
            <Button
              label={deleting ? 'Deleting…' : 'Delete my account'}
              variant="destructive"
              disabled={deleting || password.length === 0}
              onPress={confirm}
            />
            <Button label="Keep my account" variant="tertiary" disabled={deleting} onPress={() => router.back()} />
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
