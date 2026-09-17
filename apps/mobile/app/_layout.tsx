// Root layout: initializes fonts, gesture handler, theme, queries, offline sync, and session (SL-01, SL-02, SL-03, SL-05, SL-14).

import 'react-native-gesture-handler';
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
import { ThemeProvider, useTheme, useThemeContext } from '@/ui/tokens';

function Nav() {
  const c = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <SyncIndicator />
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
        <Stack.Screen name="profile" options={{ headerShown: false }} />
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

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        <AppQueryProvider>
          <SessionProvider>
            <SyncProvider>
              <Nav />
            </SyncProvider>
          </SessionProvider>
        </AppQueryProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
