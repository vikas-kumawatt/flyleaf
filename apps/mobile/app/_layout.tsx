// gesture-handler must be imported before anything else touches the
// navigation tree, or swipe gestures silently do nothing on Android.
import 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '@/lib/session';
import { useTheme } from '@/ui/tokens';

function Nav() {
  const c = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.ground },
        headerTintColor: c.ink,
        headerTitleStyle: { fontSize: 17, fontWeight: '600' },
        contentStyle: { backgroundColor: c.ground },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Flyleaf' }} />
      <Stack.Screen name="auth" options={{ title: 'Sign in', presentation: 'modal' }} />
      <Stack.Screen name="work/[id]" options={{ title: '' }} />
      <Stack.Screen name="profile" options={{ title: 'You' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <Nav />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
