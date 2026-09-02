// Screen 1 — Search.
//
// Also the app's entry point, and a guest can use it fully. That is the whole
// point: the person who installed because a shared card looked good sees the
// content that convinced them, not a signup wall (PRD §4.2).

import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { api, Work } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Cover, Empty, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';
import { TextInput } from 'react-native';

export default function SearchScreen() {
  const c = useTheme();
  const router = useRouter();
  const { user, ready } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Work[]>([]);
  const [loading, setLoading] = useState(false);

  // 250ms debounce, per the §14.4 behaviour requirements.
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const id = setTimeout(async () => {
      setLoading(true);
      try { setResults(await api.search(q)); }
      catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  const header = useCallback(() => (
    <View style={{ gap: space[3], paddingBottom: space[3] }}>
      <View style={[sheet.row, { justifyContent: 'space-between' }]}>
        <Txt variant="displayM">Search</Txt>
        {ready && (
          <Pressable onPress={() => router.push(user ? '/profile' : '/auth')}>
            <Txt variant="body" color="accent">{user ? `@${user.username}` : 'Sign in'}</Txt>
          </Pressable>
        )}
      </View>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search books or authors"
        placeholderTextColor={c.muted}
        autoCorrect={false}
        accessibilityLabel="Search books or authors"
        style={{
          minHeight: 48, paddingHorizontal: space[3], borderRadius: 12,
          borderWidth: 1, borderColor: c.line, backgroundColor: c.surface,
          color: c.ink, fontSize: 15,
        }}
      />
    </View>
  ), [q, c, user, ready, router]);

  return (
    <Screen>
      <FlatList
        contentContainerStyle={{ padding: space[4] }}
        data={results}
        keyExtractor={(w) => w.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          loading ? null : q.trim().length < 2
            ? <Empty title="Find a book you've read." />
            : <Empty title={`Nothing for "${q}".`} />
        }
        ItemSeparatorComponent={() => <View style={{ height: space[3] }} />}
        renderItem={({ item }) => (
          <Link href={`/work/${item.id}`} asChild>
            <Pressable style={[sheet.row, { alignItems: 'flex-start' }]}>
              <Cover coverId={item.cover_id} size="s" />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="title" numberOfLines={2}>{item.title}</Txt>
                <Txt variant="caption" color="muted">{item.author_name}</Txt>
                {item.first_publish_year ? (
                  <Txt variant="caption" color="muted">{item.first_publish_year}</Txt>
                ) : null}
              </View>
            </Pressable>
          </Link>
        )}
      />
    </Screen>
  );
}
