// Push on the device, mounted once under the session (SO-30, SO-33).
//
//   - registers the push token on sign-in and on each return to the
//     foreground (at most hourly; PRD §19.5 "tokens refresh on app launch");
//   - a tapped push marks its notification read and opens its screen with a
//     synthesised back stack (PRD §35.3), cold start included;
//   - the reading reminder's "Turn off" action turns it off (PRD §19.2 item
//     14 bound 6) and opens nothing.

import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';
import { useRootNavigationState, useRouter, type Href } from 'expo-router';
import { api } from '@/lib/api';
import { track } from '@/lib/events';
import { useSession } from '@/lib/session';
import { HOME, actionForResponse } from '@/lib/notifications';
import { Notifications, configurePush, refreshPushToken } from '@/lib/push';

export function PushBridge() {
  const router = useRouter();
  const navReady = Boolean(useRootNavigationState()?.key);
  const { user, ready } = useSession();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    void configurePush();
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshPushToken(true);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPushToken();
    });
    return () => sub.remove();
  }, [user?.id]);

  useEffect(() => {
    // Wait for the session and the navigator: a cold-start tap arrives first.
    if (!response || !ready || !navReady) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (handled.current === key) return;
    handled.current = key;

    const action = actionForResponse(response.actionIdentifier, response.notification.request.content.data);
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});

    if (action.kind === 'turn_off_reminder') {
      void Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => {});
      if (!user) return;
      api
        .updateNotificationPreferences({ reading_reminder: { time: null } })
        .then(() => Alert.alert('Reading reminder off', 'You can turn it back on in Settings.'))
        .catch(() => Alert.alert('Could not turn the reminder off', 'Check your connection and try again.'));
      return;
    }

    track('notification_tapped', { type: action.type ?? 'unknown', source: 'push' });
    if (action.markRead && user) void api.markNotificationsRead([action.markRead]).catch(() => {});
    // Signed out (or signed in as someone else since): Home, never another account's screen.
    const stack = user ? action.stack : [HOME];
    router.dismissAll?.();
    router.replace(stack[0] as Href);
    for (const href of stack.slice(1)) router.push(href as Href);
  }, [response, ready, navReady, user, router]);

  return null;
}
