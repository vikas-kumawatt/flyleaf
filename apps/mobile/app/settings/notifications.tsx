// Settings → Notifications (LA-02; PRD §6.43, §19.2–19.4; API SO-32).
//
// The master switch, one row per live category with a Push and/or In-app
// switch (only the channels the category has), quiet hours, and the reading
// reminder. Every change is one PATCH; the server's answer is what is drawn
// afterwards, and a failure puts back what the server holds.
//
// Reading reminder (§19.2 item 14 [LOCKED]): off by default. Turning it on
// opens the picker with nothing selected; it is saved only once the reader
// has picked an hour and a minute. Off is one tap.

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UpdateNotificationPreferencesRequest } from '@flyleaf/api-client';
import { api, type NotificationPreferences } from '@/lib/api';
import { enablePush, pushPermissionGranted } from '@/lib/push';
import {
  applyPatch,
  categoryPatch,
  composeTime,
  displayTime,
  NOTIFICATIONS_SAVE_ERROR,
  notificationRows,
  quietHoursError,
  quietHoursSummary,
  reminderPatch,
  reminderSummary,
  splitTime,
  type Channel,
} from '@/lib/settings';
import { Button, EmptyState, Screen, Txt, SkeletonSettings } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { Group, NavRow, SectionTitle, SwitchRow, TimePicker } from '@/ui/SettingsRows';
import { space, useTheme } from '@/ui/tokens';

export default function NotificationSettingsScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [osPushOff, setOsPushOff] = useState(false);

  // Quiet hours being edited: which end, and its draft.
  const [editingQuiet, setEditingQuiet] = useState<'start' | 'end' | null>(null);
  const [quietDraft, setQuietDraft] = useState<{ hour: number | null; minute: number | null }>({ hour: null, minute: null });
  // The reminder picker: open, and the reader's choice so far (starts empty).
  const [pickingReminder, setPickingReminder] = useState(false);
  const [reminderDraft, setReminderDraft] = useState<{ hour: number | null; minute: number | null }>({ hour: null, minute: null });

  const load = useCallback(async () => {
    try {
      setPrefs(await api.getNotificationPreferences());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    void pushPermissionGranted().then((granted) => setOsPushOff(!granted));
  }, [load]);

  const save = async (patch: UpdateNotificationPreferencesRequest | null): Promise<boolean> => {
    if (!prefs || !patch) return false;
    setError(null);
    setPrefs(applyPatch(prefs, patch));
    try {
      setPrefs(await api.updateNotificationPreferences(patch));
      return true;
    } catch {
      setError(NOTIFICATIONS_SAVE_ERROR);
      await load();
      return false;
    }
  };

  if (!prefs) {
    return (
      <Screen style={{ flex: 1, backgroundColor: c.ground }}>
        <ScreenHeader title="Notifications" />
        <View style={{ flex: 1, justifyContent: 'center', padding: space[4] }}>
          {loadFailed ? (
            <EmptyState
              title="Could not load your notification settings"
              subtitle="Check your connection and try again."
              action={<Button label="Try again" variant="primary" onPress={() => void load()} />}
            />
          ) : (
            <View accessible accessibilityLabel="Loading notification settings" style={{ gap: space[6] }}>
              <SkeletonSettings rows={4} />
              <SkeletonSettings rows={3} />
            </View>
          )}
        </View>
      </Screen>
    );
  }

  const rows = notificationRows(prefs);
  const pushOff = !prefs.push_enabled;
  const quietTime = editingQuiet ? composeTime(quietDraft.hour, quietDraft.minute) : null;
  const quietOther = editingQuiet === 'start' ? prefs.quiet_hours.end : prefs.quiet_hours.start;
  const quietDraftError =
    editingQuiet && quietTime
      ? quietHoursError(editingQuiet === 'start' ? quietTime : quietOther, editingQuiet === 'start' ? quietOther : quietTime)
      : null;
  const reminderTime = composeTime(reminderDraft.hour, reminderDraft.minute);

  const toggle = (key: (typeof rows)[number]['key'], channel: Channel, value: boolean) =>
    void save(categoryPatch(prefs, key, channel, value));

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <ScreenHeader title="Notifications" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[2] }}>
        {error ? (
          <View accessibilityLiveRegion="polite">
            <Txt variant="caption" color="critical">
              {error}
            </Txt>
          </View>
        ) : null}

        {osPushOff ? (
          <Group>
            <NavRow
              label="Push is off on this phone"
              detail="Your phone is blocking Flyleaf's notifications. Tap to allow them."
              onPress={async () => setOsPushOff(!(await enablePush()))}
            />
          </Group>
        ) : null}

        <Group>
          <SwitchRow
            label="Push notifications"
            detail={pushOff ? 'Off for everything. The in-app list still fills.' : 'Each kind can still be turned off below.'}
            value={prefs.push_enabled}
            onValueChange={(v) => void save({ push_enabled: v })}
          />
        </Group>

        {rows.map((r) => (
          <View key={r.key} style={{ gap: space[2] }}>
            <SectionTitle>{r.title}</SectionTitle>
            <Group>
              {r.push !== null ? (
                <SwitchRow
                  label="Push"
                  detail={r.detail}
                  value={r.push}
                  disabled={pushOff}
                  onValueChange={(v) => toggle(r.key, 'push', v)}
                  accessibilityLabel={`${r.title}: push`}
                />
              ) : null}
              {r.inApp !== null ? (
                <SwitchRow
                  label="In the app"
                  detail={r.push === null ? r.detail : undefined}
                  value={r.inApp}
                  onValueChange={(v) => toggle(r.key, 'in_app', v)}
                  accessibilityLabel={`${r.title}: in the app`}
                />
              ) : null}
            </Group>
          </View>
        ))}

        <SectionTitle>Quiet hours</SectionTitle>
        <Group>
          <SwitchRow
            label="Quiet hours"
            detail={quietHoursSummary(prefs.quiet_hours)}
            value={prefs.quiet_hours.enabled}
            onValueChange={(v) => void save({ quiet_hours: { enabled: v } })}
          />
          {prefs.quiet_hours.enabled ? (
            <NavRow
              label="Starts"
              detail={displayTime(prefs.quiet_hours.start)}
              onPress={() => {
                setEditingQuiet(editingQuiet === 'start' ? null : 'start');
                setQuietDraft(splitTime(prefs.quiet_hours.start));
              }}
            />
          ) : null}
          {prefs.quiet_hours.enabled ? (
            <NavRow
              label="Ends"
              detail={displayTime(prefs.quiet_hours.end)}
              onPress={() => {
                setEditingQuiet(editingQuiet === 'end' ? null : 'end');
                setQuietDraft(splitTime(prefs.quiet_hours.end));
              }}
            />
          ) : null}
          {editingQuiet ? (
            <View style={{ paddingTop: space[3], gap: space[2] }}>
              <TimePicker
                label={editingQuiet === 'start' ? 'Quiet hours start' : 'Quiet hours end'}
                hour={quietDraft.hour}
                minute={quietDraft.minute}
                current={prefs.quiet_hours[editingQuiet]}
                onChange={(hour, minute) => setQuietDraft({ hour, minute })}
              />
              {quietDraftError ? (
                <Txt variant="caption" color="critical" style={{ paddingHorizontal: space[4] }}>
                  {quietDraftError}
                </Txt>
              ) : null}
              <View style={{ flexDirection: 'row', gap: space[2], paddingHorizontal: space[4], paddingBottom: space[3] }}>
                <Button label="Cancel" variant="tertiary" onPress={() => setEditingQuiet(null)} style={{ flex: 1 }} />
                <Button
                  label="Save"
                  variant="primary"
                  disabled={!quietTime || Boolean(quietDraftError)}
                  onPress={async () => {
                    if (!quietTime) return;
                    if (await save({ quiet_hours: { [editingQuiet]: quietTime } })) setEditingQuiet(null);
                  }}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}
        </Group>

        <SectionTitle>Reading reminder</SectionTitle>
        <Group>
          <SwitchRow
            label="Daily reading reminder"
            detail={
              pushOff && !prefs.reading_reminder.enabled
                ? 'Needs push notifications, which are off above.'
                : reminderSummary(prefs.reading_reminder)
            }
            value={prefs.reading_reminder.enabled || pickingReminder}
            // Turning it on needs push; turning it off never waits on anything (bound 6).
            disabled={pushOff && !prefs.reading_reminder.enabled && !pickingReminder}
            onValueChange={(v) => {
              if (v) {
                // Nothing pre-selected: the reader picks the time (§19.2 bound 2).
                setReminderDraft({ hour: null, minute: null });
                setPickingReminder(true);
              } else {
                setPickingReminder(false);
                if (prefs.reading_reminder.enabled) void save(reminderPatch(null));
              }
            }}
          />
          {prefs.reading_reminder.enabled && !pickingReminder ? (
            <NavRow
              label="Time"
              detail={displayTime(prefs.reading_reminder.time ?? '')}
              onPress={() => {
                setReminderDraft(splitTime(prefs.reading_reminder.time));
                setPickingReminder(true);
              }}
            />
          ) : null}
          {pickingReminder ? (
            <View style={{ paddingTop: space[3], gap: space[2] }}>
              <TimePicker
                label="Reminder"
                hour={reminderDraft.hour}
                minute={reminderDraft.minute}
                current={prefs.reading_reminder.time}
                onChange={(hour, minute) => setReminderDraft({ hour, minute })}
              />
              <View style={{ flexDirection: 'row', gap: space[2], paddingHorizontal: space[4], paddingBottom: space[3] }}>
                <Button label="Cancel" variant="tertiary" onPress={() => setPickingReminder(false)} style={{ flex: 1 }} />
                <Button
                  label={reminderTime ? `Remind me at ${displayTime(reminderTime)}` : 'Pick a time'}
                  variant="primary"
                  disabled={!reminderTime}
                  onPress={async () => {
                    if (await save(reminderPatch(reminderTime))) setPickingReminder(false);
                  }}
                  style={{ flex: 2 }}
                />
              </View>
            </View>
          ) : null}
        </Group>
        <Txt variant="caption" color="muted">
          {`Times are in ${prefs.timezone}, the zone your phone last reported. The reminder pauses by itself if you have not opened Flyleaf for 14 days.`}
        </Txt>
      </ScrollView>
    </Screen>
  );
}
