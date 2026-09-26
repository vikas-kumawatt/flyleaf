import 'react-native-gesture-handler';
import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, Literata_400Regular, Literata_600SemiBold } from '@expo-google-fonts/literata';
import {
  Archivo_400Regular,
  Archivo_500Medium,
  Archivo_600SemiBold,
} from '@expo-google-fonts/archivo';
import { SessionProvider } from '@/lib/session';
import { AppQueryProvider } from '@/lib/query';
import { SyncProvider } from '@/offline/sync';
import { SyncIndicator } from '@/ui/SyncIndicator';
import { ActionGateProvider } from '@/ui/ActionGate';
import { VerifyEmailBanner, VerifyEmailProvider } from '@/ui/VerifyEmail';
import { ConfirmDobPrompt } from '@/ui/ConfirmDob';
import { ThemeProvider, useTheme, useThemeContext } from '@/ui/tokens';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { initTelemetry } from '@/lib/events';
import { initMobileSentry } from '@/lib/sentry';

function Nav() {
  const c = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <SyncIndicator />
      <VerifyEmailBanner />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.ground },
          headerTintColor: c.ink,
          headerTitleStyle: { fontSize: 17, fontWeight: '600' },
          contentStyle: { backgroundColor: c.ground },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="auth" options={{ title: 'Sign in', presentation: 'modal' }} />
        <Stack.Screen
          name="log"
          options={{ title: 'Log a book', presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen name="work/[id]" options={{ title: '' }} />
        <Stack.Screen
          name="work/[id]/editions"
          options={{ title: 'Choose Edition', presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen name="author/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="series/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="scanner"
          options={{ presentation: 'fullScreenModal', headerShown: false }}
        />
        <Stack.Screen
          name="finish/[id]"
          options={{ presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen
          name="dnf/[id]"
          options={{ presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen
          name="review/compose/[id]"
          options={{ presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen
          name="review/[id]"
          options={{ presentation: 'card', headerShown: false }}
        />
        <Stack.Screen name="diary" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="wall" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="wall/[id]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="stats" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="stats/[id]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/favourites" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="shelf/[id]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="shelf/create" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="shelf/[id]/edit" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="shelf/[id]/reorder" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="user/[id]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="read/[id]/comments" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="u/[username]/shelves/[slug]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="sync-issues" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="verify-email" options={{ title: 'Verify email' }} />
        <Stack.Screen name="reset-password" options={{ title: 'New password' }} />
      </Stack>
    </View>
  );
}

function ThemedStatusBar() {
  const { resolvedMode } = useThemeContext();
  return <StatusBar style={resolvedMode === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Literata_400Regular,
    Literata_600SemiBold,
    Archivo_400Regular,
    Archivo_500Medium,
    Archivo_600SemiBold,
  });

  useEffect(() => {
    initMobileSentry();
    const cleanup = initTelemetry();
    return cleanup;
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStatusBar />
          <AppQueryProvider>
            <SessionProvider>
              <SyncProvider>
                <ActionGateProvider>
                  <VerifyEmailProvider>
                    <Nav />
                    <ConfirmDobPrompt />
                  </VerifyEmailProvider>
                </ActionGateProvider>
              </SyncProvider>
            </SessionProvider>
          </AppQueryProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
