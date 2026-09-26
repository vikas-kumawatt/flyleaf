// Email verification surfaces (PRD §6.4, §6.6; audit 05 A-05-011 → audit 07).
//
// - VerifyEmailBanner: persistent while /v1/me says emailVerified is false.
//   "Unverified email → allow log in but show a persistent verification banner."
// - VerifyEmailProvider: a prompt whenever the server refuses a write with
//   403 email_unverified (review, comment, follow), from any screen.

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { api, subscribeEmailUnverified } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Txt } from './components';
import { radius, space, useTheme } from './tokens';

const RESEND_COOLDOWN_S = 60;

/** Resend with the 60 s cooldown of PRD §6.6, shared by the banner and the prompt. */
function useResend() {
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = useCallback(async () => {
    if (cooldown > 0) return;
    try {
      await api.resendVerification();
      setCooldown(RESEND_COOLDOWN_S);
      setNotice('We sent a new link. Check your inbox.');
    } catch {
      setNotice('We could not send the email. Try again in a minute.');
    }
  }, [cooldown]);

  return { cooldown, notice, resend };
}

const VerifyEmailContext = createContext<{ prompt: () => void }>({ prompt: () => {} });

export function useVerifyEmailPrompt() {
  return useContext(VerifyEmailContext);
}

export function VerifyEmailProvider({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  const { user, refreshUser } = useSession();
  const [visible, setVisible] = useState(false);
  const { cooldown, notice, resend } = useResend();
  const [checkNotice, setCheckNotice] = useState<string | null>(null);

  useEffect(() => subscribeEmailUnverified(() => setVisible(true)), []);

  const checkAgain = async () => {
    try {
      const me = await refreshUser();
      if (me.emailVerified) {
        setVisible(false);
        setCheckNotice(null);
      } else {
        setCheckNotice('Not verified yet. Open the link in the email, then try again.');
      }
    } catch {
      setCheckNotice('We could not check just now. Try again in a moment.');
    }
  };

  return (
    <VerifyEmailContext.Provider value={{ prompt: () => setVisible(true) }}>
      {children}
      <Modal visible={visible && !!user} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}
          onPress={() => setVisible(false)}
          accessibilityLabel="Dismiss"
        >
          <Pressable
            onPress={() => {}}
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
            <Txt variant="displayM">Verify your email first</Txt>
            <Txt variant="body" color="muted">
              Reviews, comments and follows need a verified email address. Tap the link we sent to {user?.email ?? 'your email'}.
            </Txt>
            {notice || checkNotice ? (
              <Txt variant="caption" color="accent">
                {checkNotice ?? notice}
              </Txt>
            ) : null}
            <Button
              label={cooldown > 0 ? `Resend link (${cooldown}s)` : 'Resend link'}
              variant="primary"
              disabled={cooldown > 0}
              onPress={() => void resend()}
            />
            <Button label="I've verified" variant="secondary" onPress={() => void checkAgain()} />
            <Button label="Not now" variant="tertiary" onPress={() => setVisible(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </VerifyEmailContext.Provider>
  );
}

export function VerifyEmailBanner() {
  const c = useTheme();
  const { user } = useSession();
  const { cooldown, notice, resend } = useResend();

  // Only an explicit false: a user restored offline may not carry the flag.
  if (!user || user.emailVerified !== false) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space[2],
        paddingHorizontal: space[4],
        paddingVertical: space[2],
        backgroundColor: c.accentSoft,
        borderBottomWidth: 1,
        borderColor: c.line,
      }}
    >
      <Txt variant="caption" color="ink2" style={{ flex: 1 }}>
        {notice ?? 'Verify your email to post reviews, comment and follow.'}
      </Txt>
      <Pressable
        onPress={() => void resend()}
        disabled={cooldown > 0}
        accessibilityRole="button"
        accessibilityLabel="Resend verification email"
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
          {cooldown > 0 ? `Resend (${cooldown}s)` : 'Resend'}
        </Txt>
      </Pressable>
    </View>
  );
}
