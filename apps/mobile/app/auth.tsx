// Comprehensive Auth Modal (SL-20, SL-21, SL-22, PRD §6.2-§6.7).
//
// Modes:
// 1. welcome: 3-card carousel + "Look around first" (guest entry)
// 2. login: Returning user login with enumeration protection & forgot link
// 3. signup_step1: Email + password strength meter + DOB age gate (>= 13)
// 4. signup_step2: Username (live validation + reserved check) + avatar preview
// 5. forgot: Password reset request with safe confirmation copy
// 6. reset: Reset password with token
// 7. verify: Email verification notice with 60s cooldown timer

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, FlyleafApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  validateUsername,
  validatePassword,
  validateDob,
} from '@/lib/auth-validation';
import { createUsernameChecker, type UsernameStatus } from '@/lib/usernameCheck';
import { WelcomeCarousel } from '@/ui/WelcomeCarousel';
import { Button, Card, Screen, Txt, sheet } from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

type AuthMode =
  | 'welcome'
  | 'login'
  | 'signup_step1'
  | 'signup_step2'
  | 'forgot'
  | 'reset'
  | 'verify';

export default function AuthScreen() {
  const c = useTheme();
  const router = useRouter();
  const { signIn, signUp } = useSession();
  // /reset-password and /verify-email send people here for a new link.
  const { mode: initialMode } = useLocalSearchParams<{ mode?: string }>();

  const [mode, setMode] = useState<AuthMode>(
    initialMode === 'forgot' || initialMode === 'login' ? initialMode : 'welcome',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Empty: a pre-filled adult date let anyone tap through the age gate (A-07-004).
  const [dob, setDob] = useState('');
  const [username, setUsername] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Verification cooldown timer (60s)
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => setCooldown((t) => t - 1), 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  // Username validation state
  const usernameCheck = validateUsername(username);

  // Live availability, 400 ms after typing stops (PRD §6.7)
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>({ state: 'idle' });
  const checker = useRef<ReturnType<typeof createUsernameChecker> | null>(null);
  checker.current ??= createUsernameChecker((u, signal) => api.checkUsername(u, signal), setUsernameStatus);
  useEffect(() => () => checker.current?.dispose(), []);
  useEffect(() => {
    checker.current?.update(usernameCheck.valid ? username.trim().toLowerCase() : null);
  }, [username, usernameCheck.valid]);
  const passwordCheck = validatePassword(password);
  const dobCheck = validateDob(dob);

  // ---------------------------------------------------------------- Actions
  const handleLogin = async () => {
    setGeneralError(null);
    if (!email || !password) {
      setGeneralError('Please enter both your email and password.');
      return;
    }

    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.back();
    } catch (err: any) {
      // PRD §6.4: Generic error to prevent account enumeration
      setGeneralError('Email or password is incorrect. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSignupStep1 = () => {
    setGeneralError(null);
    if (!email || !email.includes('@')) {
      setGeneralError('Please enter a valid email address.');
      return;
    }
    if (!passwordCheck.valid) {
      setGeneralError(passwordCheck.error ?? 'Password is too short.');
      return;
    }
    if (!dobCheck.valid) {
      setGeneralError(dobCheck.error ?? 'Please check your date of birth.');
      return;
    }
    setMode('signup_step2');
  };

  const handleSignupSubmit = async () => {
    setGeneralError(null);
    if (!usernameCheck.valid) {
      setGeneralError(usernameCheck.error ?? 'Please choose a valid username.');
      return;
    }

    setBusy(true);
    try {
      await signUp(email.trim(), username.trim().toLowerCase(), password, dob.trim());
      router.back();
    } catch (err: any) {
      if (err instanceof FlyleafApiError && err.code === 'username_taken') {
        setGeneralError('That username is already taken. Try another.');
      } else if (err instanceof FlyleafApiError && err.code === 'email_taken') {
        setGeneralError('An account with that email already exists.');
      } else {
        setGeneralError(err?.message ?? 'Could not create account. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    setGeneralError(null);
    if (!email || !email.includes('@')) {
      setGeneralError('Please enter your email address.');
      return;
    }

    setBusy(true);
    try {
      await api.forgotPassword(email.trim());
      // PRD §6.5: Identical copy regardless of whether the email exists
      setSuccessNotice('If that email is registered, we sent a password reset link.');
    } catch {
      setSuccessNotice('If that email is registered, we sent a password reset link.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async () => {
    setGeneralError(null);
    if (!resetToken.trim()) {
      setGeneralError('Please enter the reset token.');
      return;
    }
    if (password.length < 10) {
      setGeneralError('New password must be at least 10 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setGeneralError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await api.resetPassword(resetToken.trim(), password);
      setSuccessNotice('Password reset successfully. You can now sign in.');
      setMode('login');
    } catch (err: any) {
      setGeneralError(err?.message ?? 'Invalid or expired token.');
    } finally {
      setBusy(false);
    }
  };

  const handleResendVerification = async () => {
    if (cooldown > 0) return;
    setBusy(true);
    try {
      await api.resendVerification();
      setCooldown(60);
      setSuccessNotice('Verification email sent.');
    } catch (err: any) {
      setGeneralError('Could not resend email. Please wait before retrying.');
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- Render Modes
  if (mode === 'welcome') {
    return (
      <Screen>
        <WelcomeCarousel
          onGetStarted={() => setMode('signup_step1')}
          onLogin={() => setMode('login')}
          onLookAround={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={sheet.pad} keyboardShouldPersistTaps="handled">
        {/* Modal Top Bar */}
        <View style={[sheet.row, { justifyContent: 'space-between', marginBottom: space[2] }]}>
          <Pressable
            onPress={() => {
              setGeneralError(null);
              setSuccessNotice(null);
              if (mode === 'signup_step2') setMode('signup_step1');
              else if (mode === 'signup_step1' || mode === 'login') setMode('welcome');
              else setMode('login');
            }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.iconButton}
          >
            <Ionicons name="arrow-back" size={24} color={c.ink} />
          </Pressable>

          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.iconButton}
          >
            <Ionicons name="close" size={24} color={c.muted} />
          </Pressable>
        </View>

        {/* Success Notice Banner */}
        {successNotice && (
          <View style={[styles.banner, { backgroundColor: c.accentSoft, borderColor: c.accent }]}>
            <Ionicons name="checkmark-circle-outline" size={20} color={c.accent} />
            <Txt variant="body" color="accent" style={{ flex: 1 }}>
              {successNotice}
            </Txt>
          </View>
        )}

        {/* Error Notice Banner */}
        {generalError && (
          <View style={[styles.banner, { backgroundColor: c.surface2, borderColor: c.critical }]}>
            <Ionicons name="alert-circle-outline" size={20} color={c.critical} />
            <Txt variant="caption" color="critical" style={{ flex: 1 }}>
              {generalError}
            </Txt>
          </View>
        )}

        {/* ------------------------------------------------ Login Mode */}
        {mode === 'login' && (
          <View style={{ gap: space[4] }}>
            <Txt variant="displayM">Welcome back</Txt>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                EMAIL
              </Txt>
              <TextInput
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="name@example.com"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <View style={{ gap: space[1] }}>
              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                <Txt variant="micro" color="muted">
                  PASSWORD
                </Txt>
                <Pressable onPress={() => setMode('forgot')}>
                  <Txt variant="caption" color="accent">
                    Forgot password?
                  </Txt>
                </Pressable>
              </View>
              <View style={[styles.passwordContainer, { backgroundColor: c.surface, borderColor: c.line }]}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  placeholder="Enter password"
                  placeholderTextColor={c.muted}
                  style={[styles.passwordInput, { color: c.ink }]}
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={c.muted}
                  />
                </Pressable>
              </View>
            </View>

            <Button label="Sign in" variant="primary" onPress={handleLogin} loading={busy} />

            <View style={[sheet.row, { justifyContent: 'center', gap: space[2], marginTop: space[2] }]}>
              <Txt variant="body" color="muted">
                New to Flyleaf?
              </Txt>
              <Pressable onPress={() => setMode('signup_step1')}>
                <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                  Create account
                </Txt>
              </Pressable>
            </View>
          </View>
        )}

        {/* ------------------------------------------------ Sign Up Step 1 */}
        {mode === 'signup_step1' && (
          <View style={{ gap: space[4] }}>
            <Txt variant="displayM">Create an account</Txt>
            <Txt variant="body" color="muted">
              Step 1 of 2 · Account credentials
            </Txt>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                EMAIL
              </Txt>
              <TextInput
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="name@example.com"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                PASSWORD
              </Txt>
              <View style={[styles.passwordContainer, { backgroundColor: c.surface, borderColor: c.line }]}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  placeholder="Min 10 characters"
                  placeholderTextColor={c.muted}
                  style={[styles.passwordInput, { color: c.ink }]}
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={c.muted}
                  />
                </Pressable>
              </View>

              {/* Password strength indicator */}
              {password.length > 0 && (
                <View style={{ flexDirection: 'row', gap: 4, marginTop: 4, alignItems: 'center' }}>
                  {[1, 2, 3, 4].map((step) => (
                    <View
                      key={step}
                      style={{
                        flex: 1,
                        height: 4,
                        borderRadius: 2,
                        backgroundColor:
                          step <= passwordCheck.score
                            ? passwordCheck.score < 2
                              ? c.critical
                              : c.accent
                            : c.surface2,
                      }}
                    />
                  ))}
                  <Txt variant="micro" color="muted" style={{ marginLeft: 4 }}>
                    {passwordCheck.score < 2
                      ? 'Weak'
                      : passwordCheck.score < 3
                      ? 'Fair'
                      : passwordCheck.score < 4
                      ? 'Good'
                      : 'Strong'}
                  </Txt>
                </View>
              )}
            </View>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                DATE OF BIRTH (AGE 13+)
              </Txt>
              <TextInput
                value={dob}
                onChangeText={setDob}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <Button label="Continue to profile" variant="primary" onPress={handleSignupStep1} />

            <View style={[sheet.row, { justifyContent: 'center', gap: space[2], marginTop: space[2] }]}>
              <Txt variant="body" color="muted">
                Already have an account?
              </Txt>
              <Pressable onPress={() => setMode('login')}>
                <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                  Sign in
                </Txt>
              </Pressable>
            </View>
          </View>
        )}

        {/* ------------------------------------------------ Sign Up Step 2 (Username + Avatar) */}
        {mode === 'signup_step2' && (
          <View style={{ gap: space[4] }}>
            <Txt variant="displayM">Choose your username</Txt>
            <Txt variant="body" color="muted">
              Step 2 of 2 · Your identity on Flyleaf
            </Txt>

            {/* Avatar Preview */}
            <View style={{ alignItems: 'center', marginVertical: space[3] }}>
              <View
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  backgroundColor: c.accentSoft,
                  borderWidth: 1,
                  borderColor: c.line,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Txt variant="displayM" color="accent">
                  {(username || email || 'F').charAt(0).toUpperCase()}
                </Txt>
              </View>
              <Txt variant="caption" color="muted" style={{ marginTop: space[2] }}>
                Typographic avatar
              </Txt>
            </View>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                USERNAME
              </Txt>
              <View
                style={[
                  styles.input,
                  {
                    backgroundColor: c.surface,
                    borderColor: username.length > 0 && !usernameCheck.valid ? c.critical : c.line,
                    flexDirection: 'row',
                    alignItems: 'center',
                  },
                ]}
              >
                <Txt variant="body" color="muted" style={{ marginRight: 2 }}>
                  @
                </Txt>
                <TextInput
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="username"
                  placeholderTextColor={c.muted}
                  style={{ flex: 1, color: c.ink, fontSize: 15 }}
                />
                {usernameCheck.valid && usernameStatus.state === 'checking' && (
                  <ActivityIndicator size="small" color={c.muted} />
                )}
                {usernameCheck.valid && usernameStatus.state === 'available' && (
                  <Ionicons name="checkmark-circle" size={18} color={c.positive} accessibilityLabel="Available" />
                )}
                {usernameCheck.valid && usernameStatus.state === 'unavailable' && (
                  <Ionicons name="close-circle" size={18} color={c.critical} accessibilityLabel="Not available" />
                )}
              </View>
              {username.length > 0 && !usernameCheck.valid ? (
                <Txt variant="caption" color="critical">
                  {usernameCheck.error}
                </Txt>
              ) : usernameStatus.state === 'unavailable' ? (
                <View style={{ gap: space[1] }}>
                  <Txt variant="caption" color="critical">
                    {usernameStatus.reason === 'taken' ? 'That username is taken.' : 'That username is not available.'}
                    {usernameStatus.suggestions.length > 0 ? ' Try one of these:' : ''}
                  </Txt>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                    {usernameStatus.suggestions.map((s) => (
                      <Pressable
                        key={s}
                        onPress={() => setUsername(s)}
                        accessibilityRole="button"
                        accessibilityLabel={`Use ${s}`}
                        style={{ minHeight: 44, justifyContent: 'center' }}
                      >
                        <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                          @{s}
                        </Txt>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                <Txt variant="caption" color="muted">
                  3–20 characters: letters, numbers, underscores.
                </Txt>
              )}
            </View>

            <Button
              label="Create account"
              variant="primary"
              onPress={handleSignupSubmit}
              loading={busy}
              disabled={!usernameCheck.valid || usernameStatus.state === 'unavailable'}
            />
          </View>
        )}

        {/* ------------------------------------------------ Forgot Password Mode */}
        {mode === 'forgot' && (
          <View style={{ gap: space[4] }}>
            <Txt variant="displayM">Reset password</Txt>
            <Txt variant="body" color="muted">
              Enter your registered email address and we will send you a link to reset your password.
            </Txt>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                EMAIL
              </Txt>
              <TextInput
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="name@example.com"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <Button label="Send reset link" variant="primary" onPress={handleForgotPassword} loading={busy} />

            <Button
              label="I have a reset token"
              variant="secondary"
              onPress={() => setMode('reset')}
            />
          </View>
        )}

        {/* ------------------------------------------------ Reset Password Mode */}
        {mode === 'reset' && (
          <View style={{ gap: space[4] }}>
            <Txt variant="displayM">Set new password</Txt>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                RESET TOKEN
              </Txt>
              <TextInput
                value={resetToken}
                onChangeText={setResetToken}
                autoCapitalize="none"
                placeholder="Paste token from email"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                NEW PASSWORD
              </Txt>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="Min 10 characters"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <View style={{ gap: space[1] }}>
              <Txt variant="micro" color="muted">
                CONFIRM NEW PASSWORD
              </Txt>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                placeholder="Re-enter password"
                placeholderTextColor={c.muted}
                style={[styles.input, { backgroundColor: c.surface, borderColor: c.line, color: c.ink }]}
              />
            </View>

            <Button label="Change password" variant="primary" onPress={handleResetPassword} loading={busy} />
          </View>
        )}

        {/* ------------------------------------------------ Verify Email Mode */}
        {mode === 'verify' && (
          <View style={{ gap: space[4] }}>
            <Txt variant="displayM">Check your email</Txt>
            <Txt variant="body" color="muted">
              We sent a verification link to {email || 'your email'}.
            </Txt>

            <Button
              label={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend verification email'}
              variant="secondary"
              onPress={handleResendVerification}
              disabled={cooldown > 0}
              loading={busy}
            />

            <Button
              label="Continue to Flyleaf"
              variant="primary"
              onPress={() => router.back()}
            />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: space[2],
  },
  input: {
    minHeight: 48,
    paddingHorizontal: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 15,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: space[3],
    fontSize: 15,
    minHeight: 48,
  },
  eyeButton: {
    paddingHorizontal: space[3],
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
