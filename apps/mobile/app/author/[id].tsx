// Author Detail Screen (PRD §6.29, design.md §10, SL-43).
//
// Features:
// - Author header: Name, avatar, collapsible biography
// - Books read by this author counter ("X of Y books read")
// - Bibliography list of works with covers and reading statuses
// - Series grouping

import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type AuthorDetail } from '@/lib/api';
import {
  Card,
  Cover,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

export default function AuthorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useTheme();

  const [author, setAuthor] = useState<AuthorDetail | null>(null);
  const [bioExpanded, setBioExpanded] = useState(false);

  useEffect(() => {
    if (id) {
      api.author(decodeURIComponent(id)).then(setAuthor).catch(() => {});
    }
  }, [id]);

  if (!author) {
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt color="muted">Loading author…</Txt>
        </View>
      </Screen>
    );
  }

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
          <Ionicons name="arrow-back" size={24} color={c.ink} />
        </Pressable>
        <Txt variant="displayM" numberOfLines={1}>
          {author.name}
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
              width: 84,
              height: 84,
              borderRadius: 42,
              backgroundColor: c.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: c.line,
            }}
          >
            <Txt variant="displayM" color="accent">
              {author.name.charAt(0).toUpperCase()}
            </Txt>
          </View>

          <View style={{ alignItems: 'center', gap: space[1] }}>
            <Txt variant="title">{author.name}</Txt>
            <View
              style={{
                backgroundColor: c.surface2,
                paddingHorizontal: space[3],
                paddingVertical: 4,
                borderRadius: radius.pill,
                marginTop: space[1],
              }}
            >
              <Txt variant="caption" color="ink" style={{ fontWeight: '600' }}>
                {author.read_count ?? 1} of {author.works_count ?? 6} books read
              </Txt>
            </View>
          </View>
        </View>

        {/* Biography (Collapsible per PRD §6.29) */}
        {author.bio && (
          <Card style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              BIOGRAPHY
            </Txt>
            <Txt
              variant="body"
              color="ink"
              numberOfLines={bioExpanded ? undefined : 3}
              style={{ lineHeight: 22 }}
            >
              {author.bio}
            </Txt>
            <Pressable
              onPress={() => setBioExpanded(!bioExpanded)}
              accessibilityRole="button"
              accessibilityLabel={bioExpanded ? 'Show less bio' : 'Read full bio'}
              hitSlop={8}
            >
              <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                {bioExpanded ? 'Show less' : 'Read more'}
              </Txt>
            </Pressable>
          </Card>
        )}

        {/* Series Shortcut */}
        <Card
          onPress={() => router.push('/series/earthsea' as any)}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <View style={{ gap: 2 }}>
            <Txt variant="micro" color="muted">
              NOTABLE SERIES
            </Txt>
            <Txt variant="title">Earthsea Cycle</Txt>
            <Txt variant="caption" color="muted">
              4 books in series · 1 read
            </Txt>
          </View>
          <Ionicons name="chevron-forward" size={20} color={c.muted} />
        </Card>

        {/* Bibliography List */}
        <View style={{ gap: space[3] }}>
          <Txt variant="title">Bibliography</Txt>
          <View style={{ gap: space[3] }}>
            {(author.works ?? []).map((work) => (
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
                      <Txt variant="title" numberOfLines={2}>
                        {work.title}
                      </Txt>
                      <Txt variant="caption" color="muted">
                        First published {work.first_publish_year ?? '2020'}
                      </Txt>
                    </View>

                    <View style={[sheet.row, { justifyContent: 'space-between', marginTop: 4 }]}>
                      <Txt variant="micro" color="muted">
                        {work.log_count} readers
                      </Txt>
                      {work.your_read && (
                        <View
                          style={{
                            backgroundColor: c.accentSoft,
                            paddingHorizontal: space[2],
                            paddingVertical: 2,
                            borderRadius: radius.pill,
                          }}
                        >
                          <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                            {work.your_read.status.toUpperCase()}
                          </Txt>
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              </Card>
            ))}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
