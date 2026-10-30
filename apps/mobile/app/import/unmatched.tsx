// IM-09: Unmatched Review Queue Screen (PRD §34.4, §5141, AC-9, Architecture §3.7).
//
// Governed by: "The interface recedes; covers advance."
// "Ambiguous matches go to an unmatched list, never guessed."
// Allows users to inspect raw unparsed rows, search the Flyleaf catalog,
// and manually resolve or skip books with real-time feedback.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  api,
  type ImportRowItem,
  type ImportResponse,
  type Work,
} from '@/lib/api';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  Txt,
  sheet, SkeletonList} from '@/ui/components';
import { fontFamilies, space, radius, useTheme } from '@/ui/tokens';

export default function UnmatchedReviewScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [importJob, setImportJob] = useState<ImportResponse | null>(null);
  const [rows, setRows] = useState<ImportRowItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Active search per rowNo: { [rowNo]: { query: string, results: Work[], loading: boolean } }
  const [searchStates, setSearchStates] = useState<
    Record<number, { query: string; results: Work[]; loading: boolean }>
  >({});

  const [resolvingRow, setResolvingRow] = useState<number | null>(null);
  const [skippingRow, setSkippingRow] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const [jobRes, rowsRes] = await Promise.all([
        api.getImport(id),
        api.getImportRows(id, { state: 'unmatched', limit: 100 }),
      ]);
      setImportJob(jobRes);
      setRows(rowsRes.rows);

      // Initialize search state for each row with its raw title
      const initialSearch: Record<number, { query: string; results: Work[]; loading: boolean }> = {};
      for (const r of rowsRes.rows) {
        const raw = r.raw as Record<string, string>;
        const title = raw.Title || raw.title || raw['Book Title'] || '';
        initialSearch[r.row_no] = {
          query: title,
          results: [],
          loading: false,
        };
      }
      setSearchStates(initialSearch);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load unmatched items.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Execute catalog search for a specific row
  const handleSearch = async (rowNo: number, q: string) => {
    const trimmed = q.trim();
    setSearchStates((prev) => ({
      ...prev,
      [rowNo]: {
        query: q,
        results: prev[rowNo]?.results ?? [],
        loading: true,
      },
    }));

    if (trimmed.length < 2) {
      setSearchStates((prev) => ({
        ...prev,
        [rowNo]: {
          query: q,
          results: [],
          loading: false,
        },
      }));
      return;
    }

    try {
      const results = await api.search(trimmed);
      setSearchStates((prev) => ({
        ...prev,
        [rowNo]: {
          query: q,
          results: results.slice(0, 5),
          loading: false,
        },
      }));
    } catch {
      setSearchStates((prev) => ({
        ...prev,
        [rowNo]: {
          query: q,
          results: [],
          loading: false,
        },
      }));
    }
  };

  // Resolve row with chosen work
  const handleResolve = async (rowNo: number, work: Work) => {
    if (!id) return;
    try {
      setResolvingRow(rowNo);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      await api.resolveImportRow(id, rowNo, { work_id: work.id });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Remove row from list
      setRows((prev) => prev.filter((r) => r.row_no !== rowNo));
      // Update counts
      if (importJob) {
        setImportJob({
          ...importJob,
          matched: importJob.matched + 1,
          unmatched: Math.max(0, importJob.unmatched - 1),
        });
      }
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not match', err.message || 'Could not resolve book.');
    } finally {
      setResolvingRow(null);
    }
  };

  // Skip row
  const handleSkip = async (rowNo: number) => {
    if (!id) return;
    try {
      setSkippingRow(rowNo);
      void Haptics.selectionAsync();

      await api.skipImportRow(id, rowNo);

      // Remove row from list
      setRows((prev) => prev.filter((r) => r.row_no !== rowNo));
      // Update counts
      if (importJob) {
        setImportJob({
          ...importJob,
          unmatched: Math.max(0, importJob.unmatched - 1),
        });
      }
    } catch (err: any) {
      Alert.alert('Could not skip', err.message || 'Could not skip book.');
    } finally {
      setSkippingRow(null);
    }
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + space[2],
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          backgroundColor: c.ground,
        }}
      >
        <View style={sheet.rowBetween}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Ionicons name="arrow-back" size={24} color={c.ink} />
          </Pressable>

          <View style={{ alignItems: 'center' }}>
            <Txt variant="title">Unmatched books</Txt>
            {importJob && (
              <Txt variant="micro" color="muted" tabular>
                {rows.length} remaining · {importJob.matched} matched
              </Txt>
            )}
          </View>

          <View style={{ minWidth: 44 }} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4] }}>
        {loading ? (
          <SkeletonList lead="cover" rows={4} style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Every book is sorted"
            subtitle="Each book from this export is matched or skipped, so your diary and library are up to date."
            action={
              <Button
                label="Back to library"
                variant="primary"
                onPress={() => router.replace('/(tabs)/profile')}
              />
            }
          />
        ) : (
          rows.map((row) => {
            const raw = row.raw as Record<string, string>;
            const rawTitle = raw.Title || raw.title || raw['Book Title'] || 'Untitled';
            const rawAuthor = raw.Author || raw.author || raw['Author l-f'] || 'Unknown author';
            const rawRating = raw['My Rating'] || raw.rating || raw['User Rating'] || null;
            const rawShelf = raw['Exclusive Shelf'] || raw.bookshelves || raw.shelf || null;

            const isResolving = resolvingRow === row.row_no;
            const isSkipping = skippingRow === row.row_no;
            const sState = searchStates[row.row_no] || { query: rawTitle, results: [], loading: false };

            return (
              <Card key={row.row_no} style={[styles.rowCard, { borderColor: c.line }]}>
                {/* Row Header & Reason */}
                <View style={sheet.rowBetween}>
                  <Txt variant="micro" color="muted" tabular>
                    Row {row.row_no}
                  </Txt>

                  <Txt variant="micro" color={row.failure_reason === 'ambiguous_match' ? 'ink2' : 'muted'}>
                    {row.failure_reason === 'ambiguous_match' ? 'Several possible matches' : 'Not in the catalog'}
                  </Txt>
                </View>

                {/* Raw Book Metadata */}
                <View style={{ gap: space[1] }}>
                  <Txt variant="bodyL" style={{ fontWeight: '500' }}>
                    {rawTitle}
                  </Txt>
                  <Txt variant="caption" color="muted">
                    by {rawAuthor}
                    {rawRating && rawRating !== '0' ? ` · Rated ${rawRating} of 5` : ''}
                    {rawShelf ? ` · Shelf: ${rawShelf}` : ''}
                  </Txt>
                </View>

                {/* Search in Catalog Input */}
                <View style={{ gap: space[2], marginTop: space[2] }}>
                  <View style={[styles.searchInputWrapper, { backgroundColor: c.surface2, borderColor: c.line }]}>
                    <Ionicons name="search-outline" size={16} color={c.muted} style={{ marginLeft: space[3] }} />
                    <TextInput
                      value={sState.query}
                      onChangeText={(text) => handleSearch(row.row_no, text)}
                      placeholder="Search the catalog"
                      placeholderTextColor={c.muted}
                      style={[styles.searchInput, { color: c.ink }]}
                    />
                    {sState.loading && (
                      <ActivityIndicator size="small" color={c.muted} style={{ marginRight: space[2] }} />
                    )}
                  </View>

                  {/* Catalog Candidates List */}
                  {sState.results.length > 0 && (
                    <View style={{ gap: space[2], marginTop: space[1] }}>
                      <Txt variant="micro" color="muted">
                        Possible matches
                      </Txt>

                      {sState.results.map((candidate) => (
                        <Pressable
                          key={candidate.id}
                          onPress={() => handleResolve(row.row_no, candidate)}
                          disabled={isResolving}
                          style={[
                            styles.candidateRow,
                            { backgroundColor: c.surface, borderColor: c.line },
                          ]}
                        >
                          <Cover
                            coverId={candidate.cover_id}
                            title={candidate.title}
                            size="xs"
                          />

                          <View style={{ flex: 1, gap: 2 }}>
                            <Txt variant="bodyL" numberOfLines={1} style={{ fontSize: 15, lineHeight: 22 }}>
                              {candidate.title}
                            </Txt>
                            <Txt variant="caption" color="muted" numberOfLines={1}>
                              {candidate.author_name}
                            </Txt>
                          </View>

                          <Button
                            label="Match"
                            size="sm"
                            variant="primary"
                            loading={isResolving}
                            disabled={isResolving}
                            onPress={() => handleResolve(row.row_no, candidate)}
                          />
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>

                {/* Footer Action: Skip */}
                <View style={[sheet.rowBetween, { marginTop: space[2], paddingTop: space[3], borderTopWidth: 1, borderTopColor: c.line }]}>
                  <Txt variant="caption" color="muted" style={{ flex: 1 }}>
                    Not in the catalog? Skip it
                  </Txt>

                  <Button
                    label="Skip book"
                    size="sm"
                    variant="text"
                    loading={isSkipping}
                    disabled={isSkipping || isResolving}
                    onPress={() => handleSkip(row.row_no)}
                  />
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowCard: {
    padding: space[4],
    borderRadius: radius.lg,
    gap: space[3],
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    height: 44,
    paddingHorizontal: space[2],
    fontSize: 15,
    fontFamily: fontFamilies.uiRegular,
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    padding: space[2],
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
