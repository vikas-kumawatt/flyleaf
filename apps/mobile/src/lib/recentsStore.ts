// Recent searches on this device (SL-40, audit 08). The list was seeded
// with four invented queries and kept only in memory.

import * as SecureStore from 'expo-secure-store';
import { MAX_RECENTS } from './searchState';

const RECENTS_KEY = 'recent_searches_v1';

export async function loadRecents(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export async function saveRecents(recents: string[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
  } catch {
    // Recents are a convenience; losing them is not an error to show.
  }
}
