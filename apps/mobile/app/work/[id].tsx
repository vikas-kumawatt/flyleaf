// Screen 2 — Book detail. Carries the whole core loop in Phase -1:
// status → progress → finish → rate.
//
// This screen exists mainly to answer two Phase -1 questions (phases.md):
//   1. Is the work/edition split workable in a real UI?
//   2. Does an append-only progress stream feel right, or over-engineered?

import { useEffect, useState } from 'react';
import { ScrollView, View, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { api, Work } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import {
  Button, Card, Cover, ProgressBar, Screen, Stars, Txt, sheet,
} from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

const STATUSES: { key: string; label: string }[] = [
  { key: 'want',     label: 'Want to read' },
  { key: 'reading',  label: 'Reading' },
  { key: 'finished', label: 'Finished' },
  { key: 'dnf',      label: 'Stopped' },
];

const formatLabel = (f?: string | null) =>
  f ? f.charAt(0).toUpperCase() + f.slice(1) : null;

export default function WorkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { isSaved, addBook, removeBook } = useGuestShelf();
  const router = useRouter();
  const c = useTheme();

  const [work, setWork] = useState<Work | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageInput, setPageInput] = useState('');

  const load = async () => { if (id) setWork(await api.work(id)); };
  useEffect(() => { load().catch(() => {}); }, [id, user?.id]);

  if (!work) return <Screen><View style={sheet.pad}><Txt color="muted">Loading…</Txt></View></Screen>;

  const edition = work.editions?.[0];
  const total = edition?.page_count ?? null;
  const page = work.your_read?.page ?? null;
  const percent = total && page ? Math.round((page / total) * 100)
                : work.your_read?.percent ?? null;
  const savedInGuestShelf = !user && isSaved(work.id);

  const setStatus = async (status: string) => {
    if (!user) {
      if (status === 'want') {
        if (savedInGuestShelf) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await removeBook(work.id);
        } else {
          const res = await addBook({
            id: work.id,
            title: work.title,
            author_name: work.author_name,
            cover_id: work.cover_id,
            first_publish_year: work.first_publish_year,
            format: edition?.format,
          });
          if (!res.success && res.reason === 'cap_reached') {
            promptAuth({
              title: 'Sign up to save more than 20 books',
              subtitle: 'Your device shelf is full. Create an account to save unlimited books and sync them everywhere.',
            });
          } else {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }
        return;
      }

      // Guest attempting to log as reading, finished, or stopped
      promptAuth({
        title: `Sign up to log ${work.title}`,
        subtitle: `Keep track of ${work.title}, record your daily progress, and build your private library.`,
      });
      return;
    }

    setBusy(true);
    try { await api.setStatus(work.id, status); await load(); }
    finally { setBusy(false); }
  };

  const rate = async (rating: number) => {
    if (!user) {
      promptAuth({
        title: `Sign up to rate ${work.title}`,
        subtitle: 'Share your thoughts, rate books with half-stars, and remember what you loved.',
      });
      return;
    }
    setBusy(true);
    try { await api.setStatus(work.id, work.your_read?.status ?? 'finished', rating); await load(); }
    finally { setBusy(false); }
  };

  const submitProgress = async () => {
    const n = parseInt(pageInput, 10);
    if (!work.your_read || Number.isNaN(n)) return;
    setBusy(true);
    try {
      await api.addProgress(work.your_read.id, n, total ? (n / total) * 100 : null);
      setPageInput('');
      await load();
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={sheet.pad}>
        <View style={{ alignItems: 'center', gap: space[3] }}>
          <Cover coverId={work.cover_id} size="xl" />
          <Txt variant="displayM" style={{ textAlign: 'center' }}>{work.title}</Txt>
          <Txt variant="body" color="ink2">{work.author_name}</Txt>
          {/* "1975 · Paperback · 368 pages". The format sat last and
              lowercase, which read as a stray word rather than a fact
              about the edition. */}
          <Txt variant="caption" color="muted">
            {[work.first_publish_year, formatLabel(edition?.format), total ? `${total} pages` : null]
              .filter(Boolean).join(' · ')}
          </Txt>
        </View>

        {/* The status control is the largest element after the cover. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {STATUSES.map(s => {
            const active = s.key === 'want'
              ? (user ? work.your_read?.status === 'want' : savedInGuestShelf)
              : work.your_read?.status === s.key;
            const label = !user && s.key === 'want' && savedInGuestShelf
              ? 'Saved to Want to read ✓'
              : s.label;
            return (
              <Button
                key={s.key}
                label={label}
                variant={active ? 'primary' : 'secondary'}
                disabled={busy}
                onPress={() => setStatus(s.key)}
              />
            );
          })}
        </View>

        <Card>
          <Txt variant="micro" color="muted">YOUR RATING</Txt>
          <Stars value={work.your_read?.rating ?? null} onChange={rate} />
          {/* Optional by design. Never blocks a finish (PRD §9.3). */}
          <Txt variant="caption" color="muted">Optional — you can finish a book without rating it.</Txt>
        </Card>

        {work.your_read?.status === 'reading' && (
          <Card>
            <Txt variant="micro" color="muted">PROGRESS</Txt>
            <ProgressBar percent={percent ?? 0} />
            <Txt variant="caption" color="ink2">
              {page && total ? `page ${page} of ${total}` : percent ? `${percent}%` : 'Not started'}
            </Txt>
            <View style={sheet.row}>
              <TextInput
                value={pageInput}
                onChangeText={setPageInput}
                keyboardType="number-pad"
                placeholder="Page"
                placeholderTextColor={c.muted}
                accessibilityLabel="Current page"
                style={{
                  flex: 1, minHeight: 48, paddingHorizontal: space[3], borderRadius: 12,
                  borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, color: c.ink,
                }}
              />
              <Button label="Save" onPress={submitProgress} disabled={busy || !pageInput} />
            </View>
          </Card>
        )}

        {work.editions && work.editions.length > 1 && (
          <Card>
            <Txt variant="micro" color="muted">EDITIONS</Txt>
            {work.editions.map(e => (
              <Txt key={e.id} variant="caption" color="ink2">
                {[e.format, e.page_count ? `${e.page_count}p` : null, e.isbn13]
                  .filter(Boolean).join(' · ')}
              </Txt>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
