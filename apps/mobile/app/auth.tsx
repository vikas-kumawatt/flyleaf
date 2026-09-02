// Screen 3 — Auth. Reached from the action gate or the header, never as a wall.
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Field, Screen, Txt, sheet } from '@/ui/components';
import { space } from '@/ui/tokens';

export default function AuthScreen() {
  const { signIn, signUp } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<'in' | 'up'>('up');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'up') await signUp(email, username, password);
      else await signIn(email, password);
      router.back();
    } catch (e) {
      const a = e as ApiError;
      setErr({ message: a.message ?? 'Something went wrong.', field: a.field });
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <View style={sheet.pad}>
        <Txt variant="displayM">{mode === 'up' ? 'Create an account' : 'Welcome back'}</Txt>
        <Field label="Email" value={email} onChangeText={setEmail}
               keyboardType="email-address" error={err?.field === 'email' ? err.message : undefined} />
        {mode === 'up' && (
          <Field label="Username" value={username} onChangeText={setUsername}
                 error={err?.field === 'username' ? err.message : undefined} />
        )}
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry
               error={err?.field === 'password' ? err.message : undefined} />
        {err && !err.field ? <Txt variant="caption" color="critical">{err.message}</Txt> : null}
        <View style={{ gap: space[2] }}>
          <Button label={mode === 'up' ? 'Create account' : 'Sign in'} onPress={submit} loading={busy} />
          <Button
            variant="text"
            label={mode === 'up' ? 'I already have an account' : 'Create an account instead'}
            onPress={() => { setMode(mode === 'up' ? 'in' : 'up'); setErr(null); }}
          />
        </View>
      </View>
    </Screen>
  );
}
