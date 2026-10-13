// ST-05, PRD §8.6 [LOCKED]: set, change or remove the year's reading goal,
// opened from the ring on your own profile. Any time, downward included, no
// friction and no judgement: no confirmation, no "are you sure".

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, type GoalResponse } from '@/lib/api';
import { deviceTimeZone, parseGoalTarget } from '@/lib/statsView';
import { BottomSheet, Button, Field, Txt } from './components';
import { space } from './tokens';

const MAX_BOOKS = 10_000;
const MAX_PAGES = 10_000_000;

export function GoalSheet({
  visible,
  year,
  goal,
  onClose,
  onSaved,
}: {
  visible: boolean;
  year: number;
  goal: GoalResponse | null;
  onClose: () => void;
  onSaved: (goal: GoalResponse) => void;
}) {
  const [books, setBooks] = useState('');
  const [pages, setPages] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setBooks(goal?.goal ? String(goal.goal.target_books) : '');
    setPages(goal?.goal?.target_pages ? String(goal.goal.target_pages) : '');
    setError(null);
  }, [visible, goal]);

  const save = async () => {
    const targetBooks = parseGoalTarget(books, MAX_BOOKS);
    if (targetBooks === null) {
      setError(`A whole number of books, 1 to ${MAX_BOOKS.toLocaleString('en-GB')}.`);
      return;
    }
    let targetPages: number | null = null;
    if (pages.trim() !== '') {
      targetPages = parseGoalTarget(pages, MAX_PAGES);
      if (targetPages === null) {
        setError(`A whole number of pages, 1 to ${MAX_PAGES.toLocaleString('en-GB')}, or leave it empty.`);
        return;
      }
    }
    setBusy(true);
    try {
      onSaved(await api.setMyGoal({ year, target_books: targetBooks, target_pages: targetPages }, deviceTimeZone()));
      onClose();
    } catch {
      setError('We could not save that. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      onSaved(await api.deleteMyGoal(year));
      onClose();
    } catch {
      setError('We could not remove it. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={`Reading goal for ${year}`}>
      <View style={{ gap: space[3] }}>
        <Field label="Books" value={books} onChangeText={setBooks} keyboardType="number-pad" placeholder="24" />
        <Field label="Pages (optional)" value={pages} onChangeText={setPages} keyboardType="number-pad" />
        {error ? (
          <Txt variant="caption" color="critical">
            {error}
          </Txt>
        ) : null}
        <Button label="Save" variant="primary" onPress={() => void save()} disabled={busy} />
        {goal?.goal ? <Button label="Remove goal" variant="secondary" onPress={() => void remove()} disabled={busy} /> : null}
      </View>
    </BottomSheet>
  );
}
