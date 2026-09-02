// Screen 4 — Profile. In Phase -1 this is just "did the loop persist?".
// The real profile leads with four favourites, then the Wall (PRD §16).
import { useCallback, useState } from 'react';
import { FlatList, Pressable, View, RefreshControl } from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { api, Read } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Cover, Empty, ProgressBar, Screen, Stars, Txt, sheet } from '@/ui/components';
import { space } from '@/ui/tokens';

export default function ProfileScreen() {
  const { user, signOut } = useSession();
  const router = useRouter();
  const [reads, setReads] = useState<Read[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try { setReads(await api.reads()); } catch {} finally { setRefreshing(false); }
  }, [user]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!user) {
    return (
      <Screen>
        <Empty
          title="Sign in to see your books."
          action={<Button label="Sign in" onPress={() => router.push('/auth')} />}
        />
      </Screen>
    );
  }

  const finished = reads.filter(r => r.status === 'finished').length;
  const reading  = reads.filter(r => r.status === 'reading');

  return (
    <Screen>
      <FlatList
        contentContainerStyle={{ padding: space[4] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        data={reads}
        keyExtractor={(r) => r.id}
        ItemSeparatorComponent={() => <View style={{ height: space[3] }} />}
        ListHeaderComponent={
          <View style={{ gap: space[4], paddingBottom: space[4] }}>
            <Txt variant="displayM">@{user.username}</Txt>
            <View style={sheet.row}>
              <Txt variant="body" color="ink2">{finished} finished</Txt>
              <Txt variant="body" color="muted">·</Txt>
              <Txt variant="body" color="ink2">{reading.length} reading</Txt>
            </View>
            <Button variant="text" label="Sign out" onPress={signOut} />
          </View>
        }
        ListEmptyComponent={
          <Empty
            title="Nothing logged yet."
            action={<Button label="Find a book" onPress={() => router.push('/')} />}
          />
        }
        renderItem={({ item }) => {
          const pct = item.page && item.page_count
            ? Math.round((item.page / item.page_count) * 100)
            : item.percent ?? null;
          return (
            <Link href={`/work/${item.work_id}`} asChild>
              <Pressable style={[sheet.row, { alignItems: 'flex-start' }]}>
                <Cover coverId={item.cover_id} size="s" />
                <View style={{ flex: 1, gap: space[1] }}>
                  <Txt variant="title" numberOfLines={2}>{item.title}</Txt>
                  <Txt variant="caption" color="muted">{item.author_name}</Txt>
                  <Txt variant="micro" color="muted">
                    {item.status.toUpperCase()}
                    {item.attempt_no > 1 ? ` · RE-READ #${item.attempt_no}` : ''}
                  </Txt>
                  {item.rating ? <Stars value={item.rating} size={16} /> : null}
                  {item.status === 'reading' && pct !== null ? (
                    <View style={{ gap: space[1] }}>
                      <ProgressBar percent={pct} />
                      <Txt variant="caption" color="muted">
                        {item.page && item.page_count ? `page ${item.page} of ${item.page_count}` : `${pct}%`}
                      </Txt>
                    </View>
                  ) : null}
                </View>
              </Pressable>
            </Link>
          );
        }}
      />
    </Screen>
  );
}
