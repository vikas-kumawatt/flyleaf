// Milestone moments (ST-10; PRD §18.4), mounted once inside the session and
// the sync provider. It asks the server for moments not yet shown when the app
// opens, when it comes back to the foreground, and when the offline queue has
// drained after a finish or a review, then shows them one at a time: a full
// moment as a modal with an optional Share, a subtle one as a short banner.
// Each is marked seen when shown, so it never comes back. Never a push.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { api } from '@/lib/api';
import { track } from '@/lib/events';
import { useSession } from '@/lib/session';
import { useOfflineSync } from '@/offline/sync';
import { LONGEST_YET, momentFor, onMilestoneRequest, takePendingReads, type Moment } from '@/lib/milestones';
import { encodeShareOptions } from '@/lib/shareCard';
import { Button, Txt } from './components';
import { radius, space, useTheme } from './tokens';

export function MilestoneBridge() {
  const c = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const { unsyncedCount, isSyncing } = useOfflineSync();
  const [queue, setQueue] = useState<Moment[]>([]);
  const checking = useRef(false);
  const userId = user?.id ?? null;

  const check = useCallback(async () => {
    if (!userId || checking.current) return;
    checking.current = true;
    try {
      const found: Moment[] = [];
      const reads = takePendingReads();
      const { milestones } = await api.milestones();
      for (const m of milestones) {
        const moment = momentFor(m, userId);
        if (moment) found.push(moment);
      }
      for (const readId of reads) {
        const r = await api.milestones(readId).catch(() => null);
        if (r?.longest_yet) found.push(LONGEST_YET);
      }
      // Shown now: never again, whichever way the moment is closed.
      if (milestones.length > 0) await api.markMilestonesSeen(milestones.map((m) => m.key)).catch(() => undefined);
      if (found.length > 0) setQueue((q) => [...q, ...found]);
    } catch {
      // Offline: the next check finds them.
    } finally {
      checking.current = false;
    }
  }, [userId]);

  // On open, on return to the foreground, and when asked.
  useEffect(() => {
    void check();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void check());
    const off = onMilestoneRequest(() => void check());
    return () => {
      sub.remove();
      off();
    };
  }, [check]);

  // After the queue drains, the finish or review is on the server.
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = unsyncedCount > 0 || isSyncing;
    if (wasBusy.current && !busy) void check();
    wasBusy.current = busy;
  }, [unsyncedCount, isSyncing, check]);

  const current = queue[0] ?? null;
  const next = () => setQueue((q) => q.slice(1));

  useEffect(() => {
    if (!current) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (current.key.startsWith('goal_')) track('goal_reached', { year: current.key.slice(5) });
    if (current.style !== 'subtle') return;
    const t = setTimeout(next, 3500);
    return () => clearTimeout(t);
  }, [current]);

  if (!current) return null;
  if (current.style === 'subtle') {
    return (
      <Pressable
        onPress={next}
        accessibilityRole="alert"
        style={{
          position: 'absolute', left: space[4], right: space[4], bottom: space[16], padding: space[3],
          borderRadius: radius.md, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent,
        }}
      >
        <Txt variant="body" style={{ fontWeight: '700' }}>
          {current.title}
        </Txt>
        <Txt variant="caption" color="ink2">
          {current.body}
        </Txt>
      </Pressable>
    );
  }
  return (
    <Modal visible animationType="fade" transparent onRequestClose={next}>
      <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: space[6] }}>
        <View style={{ backgroundColor: c.surface, borderRadius: radius.lg, padding: space[6], gap: space[3] }} accessibilityViewIsModal>
          <Txt variant="displayM">{current.title}</Txt>
          <Txt variant="bodyL" color="ink2">
            {current.body}
          </Txt>
          <View style={{ flexDirection: 'row', gap: space[3], marginTop: space[3] }}>
            {current.share && (
              <Button
                label="Share"
                onPress={() => {
                  const card = current.share!;
                  next();
                  router.push(`/share?options=${encodeURIComponent(encodeShareOptions([{ label: 'Card', card }]))}` as any);
                }}
              />
            )}
            <Button label="Close" variant="secondary" onPress={next} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
