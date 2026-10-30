// Licences and data sources (PRD §6.43 "About / Legal", §41; owner decision
// on Phase 5 B): the credit every bundled asset and open-source package asks
// for. The asset list is written by hand (src/lib/licences.ts); the package
// list is generated from package-lock.json.

import React, { useMemo } from 'react';
import { Linking, SectionList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ASSET_CREDITS, licenceGroups } from '@/lib/licences';
import { Card, Screen, Txt } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { space, useTheme } from '@/ui/tokens';

export default function LicencesScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const sections = useMemo(
    () => licenceGroups().map((g) => ({ title: `${g.licence} (${g.packages.length})`, data: g.packages })),
    [],
  );

  return (
    <Screen>
      <ScreenHeader title="Licences" />
      <SectionList
        sections={sections}
        keyExtractor={(p) => `${p.name}@${p.version}`}
        contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[1] }}
        ListHeaderComponent={
          <View style={{ gap: space[3], marginBottom: space[4] }}>
            <Txt variant="caption" color="muted">
              Flyleaf is built on the work of others. These are the fonts, icons, emoji, data and card-drawing software it uses, and the open-source
              packages inside the app, with their licences.
            </Txt>
            {ASSET_CREDITS.map((a) => (
              <Card key={a.name} onPress={() => void Linking.openURL(a.url)} style={{ padding: space[4], gap: space[1] }}>
                <Txt variant="body" style={{ fontWeight: '500' }}>
                  {a.name}
                </Txt>
                <Txt variant="caption" color="muted">
                  {a.usedFor}
                </Txt>
                <Txt variant="caption">{a.notice}</Txt>
                <Txt variant="caption" color="accent">
                  {a.licence}
                </Txt>
              </Card>
            ))}
            <Txt variant="title" style={{ marginTop: space[4] }}>
              Open-source packages
            </Txt>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Txt variant="micro" color="muted" style={{ paddingTop: space[4], paddingBottom: space[1], backgroundColor: c.ground }}>
            {section.title}
          </Txt>
        )}
        renderItem={({ item }) => (
          <Txt variant="caption" style={{ paddingVertical: 2 }}>
            {item.name} {item.version}
          </Txt>
        )}
      />
    </Screen>
  );
}
