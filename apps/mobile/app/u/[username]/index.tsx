// Profile links: https://flyleaf.app/@username and /u/username (owner
// decision on SO-5x; +native-intent rewrites /@name to here). Resolves the
// name, current or former, through the API and replaces itself with the
// profile screen. A name the reader may not see is the same "not available"
// as a name nobody has.

import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '@/lib/api';
import { Screen, Txt, Button } from '@/ui/components';
import { useTheme, space, radius } from '@/ui/tokens';

export default function UsernameLinkScreen() {
  const c = useTheme();
  const router = useRouter();
  const { username } = useLocalSearchParams<{ username: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!username) {
      setError('This link is incomplete.');
      return;
    }
    api
      .userByUsername(username)
      .then((profile) => {
        if (active) router.replace(`/user/${profile.id}` as any);
      })
      .catch(() => {
        if (active) setError('This account could not be found.');
      });
    return () => {
      active = false;
    };
  }, [username, router]);

  if (!error) {
    return (
      <Screen style={[styles.center, { backgroundColor: c.ground }]}>
        <ActivityIndicator size="large" color={c.accent} />
      </Screen>
    );
  }

  return (
    <Screen style={[styles.center, { backgroundColor: c.ground, padding: space[4] }]}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
        <Txt variant="title" style={{ textAlign: 'center', marginBottom: space[2] }}>
          Not available
        </Txt>
        <Txt color="muted" style={{ textAlign: 'center', marginBottom: space[4] }}>
          {error}
        </Txt>
        <Button variant="primary" label="Go home" onPress={() => router.replace('/' as any)} style={{ width: '100%' }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 400, padding: space[6], borderRadius: radius.lg, borderWidth: 1, alignItems: 'center' },
});
