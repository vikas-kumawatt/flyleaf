// Author Detail Screen (PRD §6.29, design.md §10, SL-43).
//
// Features:
// - Author header: Name, avatar, collapsible biography
// - Books read by this author counter ("X of Y books read")
// - Bibliography list of works with covers and reading statuses, most
//   logged first, 50 at a time
//
// Audit 08: this used to search for the author's NAME as a title, and fill
// the gaps with an invented bio, invented books and a hard-coded series. It
// now reads GET /authors/:id, which lists the works credited to the author.

import React, { useState } from 'react';
import {
  ScrollView,
  View,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Work } from '@/lib/api';
import { useRemote } from '@/lib/useRemote';
import { RemoteStatus } from '@/ui/RemoteStatus';
import {
  Button,
  Card,
  Cover,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { fontFamilies, space, useTheme } from '@/ui/tokens';

const STATUS_LABEL: Record<string, string> = {
  want: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
  dnf: 'Stopped',
};

export default function AuthorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useTheme();

  const [bioExpanded, setBioExpanded] = useState(false);
  const [more, setMore] = useState<Work[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const remote = useRemote(id ? () => api.author(id) : null, [id]);

  if (remote.state !== 'ready') {
    return <RemoteStatus remote={remote} noun="author" onRetry={() => void remote.reload()} />;
  }
  const author = remote.data;
  const works = [...author.works, ...more];

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await api.author(author.id, { offset: works.length });
      setMore((prev) => [...prev, ...page.works]);
    } catch {
      // The button stays; the next tap tries again.
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Screen>
      {/* Header bar with Back button */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: space[4],
          paddingTop: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[3],
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </Pressable>
        <Txt variant="title" numberOfLines={1}>
          Author
        </Txt>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[16],
          gap: space[6],
        }}
      >
        {/* Author Profile Header */}
        <View style={{ alignItems: 'center', gap: space[3], paddingTop: space[2] }}>
          {/* Avatar / Portrait placeholder */}
          <View
            style={{
              width: 88,
              height: 88,
              borderRadius: 44,
              backgroundColor: c.surface2,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: c.line,
            }}
          >
            <Txt variant="displayM" color="ink2">
              {author.name.charAt(0).toUpperCase()}
            </Txt>
          </View>

          <View style={{ alignItems: 'center', gap: space[1] }}>
            <Txt variant="displayL" style={{ textAlign: 'center' }}>{author.name}</Txt>
            <Txt variant="caption" color="muted" tabular>
              {author.read_count.toLocaleString()} of {author.works_count.toLocaleString()} books read
            </Txt>
          </View>
        </View>

        {/* Biography (Collapsible per PRD §6.29) */}
        {author.bio && (
          <Card style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              Biography
            </Txt>
            <Txt
              variant="body"
              color="ink"
              numberOfLines={bioExpanded ? undefined : 3}
            >
              {author.bio}
            </Txt>
            <Pressable
              onPress={() => setBioExpanded(!bioExpanded)}
              accessibilityRole="button"
              accessibilityLabel={bioExpanded ? 'Show less bio' : 'Read full bio'}
              hitSlop={8}
            >
              <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                {bioExpanded ? 'Show less' : 'Read more'}
              </Txt>
            </Pressable>
          </Card>
        )}

        {/* Bibliography List */}
        <View style={{ gap: space[3] }}>
          <Txt variant="title">Bibliography</Txt>
          <View style={{ gap: space[3] }}>
            {works.length === 0 ? (
              <Txt color="muted">No books by this author in the catalog yet</Txt>
            ) : null}
            {works.map((work) => (
              <Card
                key={work.id}
                onPress={() => router.push(`/work/${work.id}`)}
                style={{ padding: space[3] }}
              >
                <View style={sheet.rowTop}>
                  <Cover coverId={work.cover_id} title={work.title} size="s" />
                  <View
                    style={{
                      flex: 1,
                      marginLeft: space[3],
                      justifyContent: 'space-between',
                      gap: space[1],
                    }}
                  >
                    <View>
                      <Txt variant="title" style={{ fontFamily: fontFamilies.displayMedium }} numberOfLines={2}>
                        {work.title}
                      </Txt>
                      {work.first_publish_year ? (
                        <Txt variant="caption" color="muted" tabular>
                          First published {work.first_publish_year}
                        </Txt>
                      ) : null}
                    </View>

                    <View style={[sheet.row, { justifyContent: 'space-between', marginTop: space[1] }]}>
                      <Txt variant="micro" color="muted" tabular>
                        {work.log_count.toLocaleString()} {work.log_count === 1 ? 'reader' : 'readers'}
                      </Txt>
                      {work.your_read && (
                        <Txt variant="micro" color="ink2">
                          {STATUS_LABEL[work.your_read.status] ?? work.your_read.status}
                        </Txt>
                      )}
                    </View>
                  </View>
                </View>
              </Card>
            ))}
            {works.length < author.works_count ? (
              <Button
                label={`Show more (${author.works_count - works.length})`}
                variant="secondary"
                loading={loadingMore}
                onPress={() => void loadMore()}
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
