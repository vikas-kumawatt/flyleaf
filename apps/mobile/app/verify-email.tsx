// Email verification link target (PRD §6.6; audit 04 A-04-014 → audit 07).
//
// The email links to `${APP_BASE_URL}/verify-email?token=…`; the app opens it
// as flyleaf://verify-email?token=… (and as an https App Link once the domain
// is set up, see the findings). The token is verified once, on arrival.

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api, FlyleafApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

type State = 'verifying' | 'verified' | 'expired' | 'error' | 'missing';

export default function VerifyEmailScreen() {
  const c = useTheme();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { user, refreshUser } = useSession();
  const [state, setState] = useState<State>(token ? 'verifying' : 'missing');
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    (async () => {
      try {
        await api.verifyEmail(token);
        setState('verified');
        if (user) void refreshUser().catch(() => {});
      } catch (err) {
        // 400 invalid_or_expired_token covers expired, used and unknown alike.
        setState(err instanceof FlyleafApiError && err.status === 400 ? 'expired' : 'error');
      }
    })();
  }, [token, user, refreshUser]);

  const sendNewLink = async () => {
    if (!user) {
      router.replace('/auth?mode=login' as any);
      return;
    }
    try {
      await api.resendVerification();
      setNotice('We sent a new link. Check your inbox.');
    } catch {
      setNotice('We could not send the email. Try again in a minute.');
    }
  };

  return (
    <Screen>
      <View style={[sheet.pad, { gap: space[4] }]}>
        {state === 'verifying' && (
          <View style={{ alignItems: 'center', gap: space[3], marginTop: space[8] }}>
            <ActivityIndicator color={c.accent} />
            <Txt variant="body" color="muted">Verifying your email…</Txt>
          </View>
        )}

        {state === 'verified' && (
          <>
            <Txt variant="displayM">Email verified</Txt>
            <Txt variant="body" color="muted">
              You can now post reviews, comment and follow readers.
            </Txt>
            <Button label="Continue" variant="primary" onPress={() => router.replace('/')} />
          </>
        )}

        {(state === 'expired' || state === 'missing') && (
          <>
            <Txt variant="displayM">{state === 'expired' ? 'This link has expired' : 'This link is incomplete'}</Txt>
            <Txt variant="body" color="muted">
              {state === 'expired'
                ? 'Verification links work once and expire after 24 hours. Send yourself a new one.'
                : 'Open the link from the email again, or send yourself a new one.'}
            </Txt>
            {notice ? <Txt variant="caption" color="accent">{notice}</Txt> : null}
            <Button
              label={user ? 'Send a new link' : 'Sign in to send a new link'}
              variant="primary"
              onPress={() => void sendNewLink()}
            />
          </>
        )}

        {state === 'error' && (
          <>
            <Txt variant="displayM">We couldn't verify your email</Txt>
            <Txt variant="body" color="muted">
              Check your connection, then open the link again.
            </Txt>
            <Button label="Go to Home" variant="secondary" onPress={() => router.replace('/')} />
          </>
        )}
      </View>
    </Screen>
  );
}
