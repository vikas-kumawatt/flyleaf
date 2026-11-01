import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, Newsreader_400Regular, Newsreader_500Medium } from '@expo-google-fonts/newsreader';
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
} from '@expo-google-fonts/instrument-sans';
import { SessionProvider } from '@/lib/session';
import { AppQueryProvider } from '@/lib/query';
import { SyncProvider } from '@/offline/sync';
import { SyncIndicator } from '@/ui/SyncIndicator';
import { ActionGateProvider } from '@/ui/ActionGate';
import { VerifyEmailBanner, VerifyEmailProvider } from '@/ui/VerifyEmail';
import { ConfirmDobPrompt } from '@/ui/ConfirmDob';
import { PushBridge } from '@/ui/PushBridge';
import { MilestoneBridge } from '@/ui/MilestoneBridge';
import { ThemeProvider, fontFamilies, useTheme, useThemeContext } from '@/ui/tokens';
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
          headerTitleStyle: { fontSize: 17, fontFamily: fontFamilies.uiMedium },
          headerShadowVisible: false,
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
          options={{ title: 'Choose edition', presentation: 'modal', headerShown: false }}
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
        <Stack.Screen name="shelf/deleted" options={{ title: 'Recently deleted' }} />
        <Stack.Screen name="shelf/[id]/edit" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="shelf/[id]/reorder" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="user/[id]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="onboarding/follow" options={{ presentation: 'card', headerShown: false, gestureEnabled: true }} />
        <Stack.Screen name="read/[id]/comments" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="notifications" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="u/[username]/shelves/[slug]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="sync-issues" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="verify-email" options={{ title: 'Verify email' }} />
        <Stack.Screen name="reset-password" options={{ title: 'New password' }} />
        {/* LA-02 Settings: each screen draws its own header (ScreenHeader). */}
        <Stack.Screen name="settings/index" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="settings/account" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="settings/privacy" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="settings/notifications" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="settings/appearance" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="settings/about" options={{ presentation: 'card', headerShown: false }} />
        {/* Screens that draw their own ScreenHeader; without an entry the stack adds a second header named after the route. */}
        <Stack.Screen name="import/index" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="import/unmatched" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="licences" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="moderation/[id]" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/blocked" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/content" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/delete-account" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/muted" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/reports" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="profile/requests" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="share" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="u/[username]/index" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="user/[id]/followers" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="user/[id]/following" options={{ presentation: 'card', headerShown: false }} />
        <Stack.Screen name="year-in-review" options={{ presentation: 'card', headerShown: false }} />
      </Stack>
    </View>
  );
}

// Until the fonts are in, the screen is the bare background. Rendering text
// earlier lets Android measure it in the fallback face and then draw it in
// Instrument Sans, which is wider, so labels lose their last letters.
function FontPending() {
  const c = useTheme();
  return <View style={{ flex: 1, backgroundColor: c.ground }} />;
}

function ThemedStatusBar() {
  const { resolvedMode } = useThemeContext();
  return <StatusBar style={resolvedMode === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Newsreader_400Regular,
    Newsreader_500Medium,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
  });

  useEffect(() => {
    initMobileSentry();
    const cleanup = initTelemetry();
    return cleanup;
  }, []);

  // Every gesture in the app (feed-card swipes, the progress slider) needs this
  // at the root, or react-native-gesture-handler ignores them.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <SafeAreaProvider>
          <ThemeProvider>
            <ThemedStatusBar />
            <AppQueryProvider>
              <SessionProvider>
                <SyncProvider>
                  <ActionGateProvider>
                    <VerifyEmailProvider>
                      {/* A font that fails to load falls back to the system face rather than blocking the app. */}
                      {fontsLoaded || fontError ? (
                        <>
                          <Nav />
                          <PushBridge />
                          <MilestoneBridge />
                          <ConfirmDobPrompt />
                        </>
                      ) : (
                        <FontPending />
                      )}
                    </VerifyEmailProvider>
                  </ActionGateProvider>
                </SyncProvider>
              </SessionProvider>
            </AppQueryProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
