// Push on the device (SO-30, SO-33): permission, token, channel, the
// reminder's "Turn off" action, and what a tap does. expo-notifications is a
// native module: this needs a development build with it compiled in.
//
// PRD §35.3: permission is asked for in context (after the first follow, or
// from the notification centre), never on first launch. PRD §19.5: the token
// is refreshed on every app open, which is also what the server reads as
// "the app was opened" (the reading reminder pauses after 14 days without).

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import { api, onBeforeLogout } from './api';
import { REMINDER_CATEGORY, TURN_OFF_ACTION, shouldRefreshToken } from './notifications';

const ASKED_KEY = 'flyleaf.push.asked';
const TOKEN_KEY = 'flyleaf.push.token';
const CHANNEL = 'default';

let configured = false;
let lastRegisteredAt: number | null = null;

/** Once per process: how a notification shows while the app is open, the Android channel, the reminder's action. */
export async function configurePush(): Promise<void> {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Notifications',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    // PRD §19.2 item 14 bound 6: one tap to turn the reminder off, from the
    // notification itself. It opens the app, which sends the change.
    await Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY, [
      { identifier: TURN_OFF_ACTION, buttonTitle: 'Turn off', options: { opensAppToForeground: true } },
    ]);
  } catch {
    // A build without the native module (Expo Go): push is simply absent.
  }
  onBeforeLogout(unregisterPush);
}

function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function tokenAndRegister(): Promise<string | null> {
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  await api.registerPushToken({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android', timezone: deviceTimezone() });
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  lastRegisteredAt = Date.now();
  return token;
}

/**
 * On sign-in and each time the app comes to the foreground (at most hourly):
 * register the token if permission was already given. Never asks.
 */
export async function refreshPushToken(force = false): Promise<void> {
  if (!force && !shouldRefreshToken(lastRegisteredAt, Date.now())) return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') await tokenAndRegister();
  } catch {
    // Offline, an emulator without Play services, or no native module: next open.
  }
}

/**
 * Asks once, in context (after the first follow). Returns whether push is on.
 * A "no" is remembered: the app does not ask again; the centre offers it.
 */
export async function askForPushOnce(): Promise<boolean> {
  try {
    if ((await SecureStore.getItemAsync(ASKED_KEY)) === '1') return false;
    await SecureStore.setItemAsync(ASKED_KEY, '1');
    return await enablePush();
  } catch {
    return false;
  }
}

/** The centre's "Turn on push": asks (the OS may refuse to show the prompt again) and registers. */
export async function enablePush(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    const status = current.status === 'granted' ? current.status : (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return false;
    await tokenAndRegister();
    return true;
  } catch {
    return false;
  }
}

export async function pushPermissionGranted(): Promise<boolean> {
  try {
    return (await Notifications.getPermissionsAsync()).status === 'granted';
  } catch {
    return false;
  }
}

/** Sign-out: this device stops receiving the account's pushes. */
export async function unregisterPush(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  try {
    await api.unregisterPushToken(token);
  } finally {
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    lastRegisteredAt = null;
  }
}

export { Notifications };
