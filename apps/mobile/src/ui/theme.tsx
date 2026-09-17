// Theme provider supporting System, Light, and Dark modes (design.md §2, SL-05).
//
// Defaults to 'system' to follow OS appearance. Persists selection in
// SecureStore so night readers stay dark across app launches.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { palette, ColorName, Theme } from './tokens';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: 'light' | 'dark';
  theme: Theme;
  setMode: (mode: ThemeMode) => Promise<void>;
}

const THEME_STORE_KEY = 'flyleaf.theme_preference';

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(THEME_STORE_KEY);
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setModeState(saved);
        }
      } catch {
        // Fallback to system default if store is unavailable
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const setMode = useCallback(async (newMode: ThemeMode) => {
    setModeState(newMode);
    try {
      await SecureStore.setItemAsync(THEME_STORE_KEY, newMode);
    } catch {
      // Storage error non-fatal
    }
  }, []);

  const resolvedMode = mode === 'system' ? systemScheme : mode;

  const theme = Object.fromEntries(
    Object.entries(palette).map(([k, v]) => [k, v[resolvedMode]]),
  ) as Theme;

  return (
    <ThemeContext.Provider value={{ mode, resolvedMode, theme, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Graceful fallback for components rendered outside provider
    return {
      mode: 'system',
      resolvedMode: 'light',
      theme: Object.fromEntries(
        Object.entries(palette).map(([k, v]) => [k, v.light]),
      ) as Theme,
      setMode: async () => {},
    };
  }
  return ctx;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}
