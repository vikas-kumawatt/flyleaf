// IM-09: Import Screen (PRD §6.8, §24.2, §34.4, AC-9, Architecture §3.7).
//
// Governed by: "The interface recedes; covers advance."
// Allows users to select an external reading platform (Goodreads, StoryGraph, LibraryThing,
// Calibre, OpenLibrary, OpenReads), upload or paste an export CSV, track live progress
// via ImportProgressBanner, and access the Unmatched Review Queue.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  api,
  type ImportSource,
  type ImportResponse,
  type ExportResponse,
  type ExportFormat,
} from '@/lib/api';
import * as Linking from 'expo-linking';
import { useSession } from '@/lib/session';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { ImportProgressBanner } from '@/ui/ImportProgressBanner';
import { space, radius, useTheme } from '@/ui/tokens';

const PLATFORMS: { id: ImportSource; name: string; desc: string; icon: string }[] = [
  { id: 'goodreads', name: 'Goodreads', desc: 'goodreads_library_export.csv', icon: 'book-outline' },
  { id: 'storygraph', name: 'The StoryGraph', desc: 'the-storygraph-export.csv', icon: 'stats-chart-outline' },
  { id: 'librarything', name: 'LibraryThing', desc: 'LibraryThing export (.csv)', icon: 'library-outline' },
  { id: 'calibre', name: 'Calibre', desc: 'calibre library catalog (.csv)', icon: 'desktop-outline' },
  { id: 'openlibrary', name: 'OpenLibrary', desc: 'openlibrary reading log', icon: 'globe-outline' },
  { id: 'openreads', name: 'OpenReads', desc: 'openreads export (.csv)', icon: 'bookmark-outline' },
];

export default function ImportScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();

  const [selectedSource, setSelectedSource] = useState<ImportSource>('goodreads');
  const [inputMode, setInputMode] = useState<'paste' | 'file'>('paste');
  const [csvText, setCsvText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [pastImports, setPastImports] = useState<ImportResponse[]>([]);
  const [loadingPast, setLoadingPast] = useState(true);

  // Exports state
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [requestingExport, setRequestingExport] = useState(false);
  const [pastExports, setPastExports] = useState<ExportResponse[]>([]);
  const [loadingExports, setLoadingExports] = useState(true);

  // Load user's previous and active imports
  const loadImports = useCallback(async () => {
    if (!user) {
      setLoadingPast(false);
      return;
    }
    try {
      setLoadingPast(true);
      const res = await api.listImports();
      setPastImports(res.imports || []);

      // If an import is currently processing or queued, display its banner
      const active = res.imports.find(
        (i) => i.state === 'processing' || i.state === 'queued',
      );
      if (active) {
        setActiveImportId(active.id);
      }

      // Also load exports
      setLoadingExports(true);
      const expRes = await api.listExports();
      setPastExports(expRes.exports || []);
    } catch {
      // Offline fallback
    } finally {
      setLoadingPast(false);
      setLoadingExports(false);
    }
  }, [user]);

  useEffect(() => {
    void loadImports();
  }, [loadImports]);

  // Pasted text goes straight to object storage (PV-03), then the import is
  // started from the completed upload. On a duplicate, "Import anyway"
  // reuses that upload rather than sending the file again.
  const startImport = async (uploadId: string, force: boolean) => {
    const result = await api.createImport({
      upload_id: uploadId,
      source: selectedSource,
      ...(force ? { force: true } : {}),
    });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCsvText('');
    setActiveImportId(result.id);
    void loadImports();
  };

  const handleUpload = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }

    const trimmed = csvText.trim();
    if (!trimmed) {
      Alert.alert('Empty Content', 'Please paste your CSV export text before importing.');
      return;
    }

    let uploadId: string | null = null;
    try {
      setUploading(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const upload = await api.uploadFile(trimmed, {
        contentType: 'text/csv',
        filename: `${selectedSource}_export.csv`,
        onProgress: (sent, total) => setUploadProgress(total > 0 ? Math.round((sent / total) * 100) : null),
      });
      uploadId = upload.id;
      await startImport(upload.id, false);
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const refused = uploadId;
      if (err.code === 'duplicate_import' && refused) {
        Alert.alert(
          'Duplicate File',
          'An identical file has already been imported into your library. Would you like to import it anyway?',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Import Anyway',
              onPress: async () => {
                try {
                  setUploading(true);
                  await startImport(refused, true);
                } catch (retryErr: any) {
                  Alert.alert('Import Failed', retryErr.message || 'Could not start the import.');
                } finally {
                  setUploading(false);
                }
              },
            },
          ],
        );
      } else if (err instanceof TypeError || err?.code === 'network_error') {
        // Uploads are online-only: a presigned URL expires, so they are never
        // queued (PV-03). The pasted text stays in the box.
        Alert.alert('You are offline', 'Importing needs an internet connection. Your text is still here; try again when you are back online.');
      } else {
        Alert.alert('Import Failed', err.message || 'Could not upload import file.');
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const handleRequestExport = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }

    try {
      setRequestingExport(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      await api.requestExport({ format: exportFormat });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Export Requested',
        `Your ${exportFormat.toUpperCase()} export is being generated. A secure download link will be emailed to your account address once ready.`,
      );
      void loadImports();
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Export Failed', err.message || 'Could not request data export.');
    } finally {
      setRequestingExport(false);
    }
  };

  const handleWebFileSelect = (e: any) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setCsvText(content);
        setInputMode('paste');
      }
    };
    reader.readAsText(file);
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Navigation Header */}
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

          <Txt variant="title" style={{ fontWeight: '700', fontSize: 17 }}>
            Import Library
          </Txt>

          <View style={{ minWidth: 44 }} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4] }}>
        {/* Active Import Live Progress Banner */}
        {activeImportId && (
          <View>
            <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5, marginBottom: space[1] }}>
              ACTIVE IMPORT
            </Txt>
            <ImportProgressBanner
              importId={activeImportId}
              onComplete={() => {
                void loadImports();
              }}
              onDismiss={() => setActiveImportId(null)}
            />
          </View>
        )}

        {/* 1. SOURCE PLATFORM SELECTOR */}
        <View style={{ gap: space[2] }}>
          <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
            1. SELECT SOURCE PLATFORM
          </Txt>

          <View style={styles.platformGrid}>
            {PLATFORMS.map((p) => {
              const isSelected = selectedSource === p.id;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setSelectedSource(p.id);
                  }}
                  style={[
                    styles.platformCard,
                    {
                      backgroundColor: isSelected ? c.surface : 'transparent',
                      borderColor: isSelected ? c.accent : c.line,
                    },
                  ]}
                >
                  <Ionicons
                    name={p.icon as any}
                    size={22}
                    color={isSelected ? c.accent : c.muted}
                  />
                  <Txt
                    variant="body"
                    style={{
                      fontWeight: isSelected ? '700' : '500',
                      fontSize: 13,
                      color: isSelected ? c.accent : c.ink,
                    }}
                  >
                    {p.name}
                  </Txt>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* 2. CSV PAYLOAD INPUT */}
        <View style={{ gap: space[2] }}>
          <View style={sheet.rowBetween}>
            <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
              2. EXPORT FILE
            </Txt>
            <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
              {csvText.length > 0 ? `${csvText.length.toLocaleString()} chars` : 'CSV / UTF-8'}
            </Txt>
          </View>

          {/* Web file picker shortcut when running on web */}
          {Platform.OS === 'web' && (
            <View style={{ marginBottom: space[2] }}>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleWebFileSelect}
                style={{
                  color: c.ink,
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              />
            </View>
          )}

          <TextInput
            value={csvText}
            onChangeText={setCsvText}
            placeholder={`Paste your ${selectedSource} CSV contents here...\nExample:\nTitle,Author,My Rating,Exclusive Shelf\nDune,Frank Herbert,5,read`}
            placeholderTextColor={c.muted}
            multiline
            numberOfLines={6}
            style={[
              styles.csvInput,
              { backgroundColor: c.surface, borderColor: c.line, color: c.ink },
            ]}
          />

          <Button
            label={
              uploading
                ? uploadProgress !== null
                  ? `Uploading ${uploadProgress}%...`
                  : 'Uploading & Enqueueing...'
                : 'Start Library Import'
            }
            variant="primary"
            loading={uploading}
            disabled={uploading || csvText.trim().length === 0}
            onPress={handleUpload}
          />
        </View>

        {/* 3. PREVIOUS IMPORTS HISTORY */}
        <View style={{ gap: space[2], marginTop: space[3] }}>
          <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
            IMPORT HISTORY
          </Txt>

          {loadingPast ? (
            <ActivityIndicator size="small" color={c.accent} style={{ padding: space[4] }} />
          ) : pastImports.length === 0 ? (
            <Card style={{ padding: space[4], alignItems: 'center' }}>
              <Txt variant="caption" color="muted">
                No previous imports found.
              </Txt>
            </Card>
          ) : (
            pastImports.map((imp) => {
              const dateStr = new Date(imp.created_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              });

              return (
                <Card key={imp.id} style={{ padding: space[3], gap: space[2] }}>
                  <View style={sheet.rowBetween}>
                    <View style={{ gap: 2 }}>
                      <Txt variant="body" style={{ fontWeight: '700', fontSize: 14 }}>
                        {imp.source.toUpperCase()}
                      </Txt>
                      <Txt variant="caption" color="muted">
                        {dateStr} · {imp.filename || 'export.csv'}
                      </Txt>
                    </View>

                    <View
                      style={[
                        styles.statusBadge,
                        {
                          backgroundColor:
                            imp.state === 'completed'
                              ? c.surface
                              : imp.state === 'failed'
                              ? '#ffebee'
                              : c.surface,
                          borderColor:
                            imp.state === 'completed'
                              ? c.accent
                              : imp.state === 'failed'
                              ? '#d32f2f'
                              : c.line,
                        },
                      ]}
                    >
                      <Txt
                        variant="caption"
                        style={{
                          fontWeight: '700',
                          fontSize: 11,
                          color:
                            imp.state === 'completed'
                              ? c.accent
                              : imp.state === 'failed'
                              ? '#d32f2f'
                              : c.ink,
                        }}
                      >
                        {imp.state.toUpperCase()}
                      </Txt>
                    </View>
                  </View>

                  <View style={sheet.rowBetween}>
                    <Txt variant="caption" color="muted">
                      {imp.matched} matched · {imp.unmatched} unmatched · {imp.total_rows} total
                    </Txt>

                    {imp.unmatched > 0 && (
                      <Pressable
                        onPress={() => {
                          void Haptics.selectionAsync();
                          router.push({
                            pathname: '/import/unmatched' as any,
                            params: { id: imp.id },
                          });
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Txt variant="caption" color="accent" style={{ fontWeight: '700' }}>
                          Review ({imp.unmatched}) →
                        </Txt>
                      </Pressable>
                    )}
                  </View>
                </Card>
              );
            })
          )}
        </View>

        {/* 4. EXPORT LIBRARY DATA (IM-10) */}
        <View style={{ gap: space[3], marginTop: space[3], paddingTop: space[3], borderTopWidth: 1, borderTopColor: c.line }}>
          <View style={{ gap: 2 }}>
            <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
              EXPORT LIBRARY DATA
            </Txt>
            <Txt variant="caption" color="muted">
              Download your complete reading history, reviews, and shelves.
            </Txt>
          </View>

          <SegmentedControl
            options={[
              { value: 'csv', label: 'CSV (Spreadsheet)' },
              { value: 'json', label: 'JSON (Full Archive)' },
            ]}
            value={exportFormat}
            onChange={(val) => setExportFormat(val as ExportFormat)}
          />

          <Button
            label={requestingExport ? 'Requesting Export...' : `Request ${exportFormat.toUpperCase()} Export`}
            variant="secondary"
            loading={requestingExport}
            disabled={requestingExport}
            onPress={handleRequestExport}
          />

          {/* Past Exports List */}
          {pastExports.length > 0 && (
            <View style={{ gap: space[2], marginTop: space[1] }}>
              <Txt variant="caption" color="muted" style={{ fontWeight: '600', fontSize: 11 }}>
                PREVIOUS EXPORTS:
              </Txt>

              {pastExports.map((exp) => {
                const dateStr = new Date(exp.created_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                });
                const sizeKb = exp.file_size_bytes ? `${Math.round(exp.file_size_bytes / 1024)} KB` : null;

                return (
                  <Card key={exp.id} style={{ padding: space[3] }}>
                    <View style={sheet.rowBetween}>
                      <View style={{ gap: 2 }}>
                        <Txt variant="body" style={{ fontWeight: '700', fontSize: 13 }}>
                          {exp.format.toUpperCase()} Export
                        </Txt>
                        <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                          {dateStr} {sizeKb ? `· ${sizeKb}` : ''} · {exp.state}
                        </Txt>
                      </View>

                      {exp.download_url && (
                        <Button
                          label="Download"
                          size="sm"
                          variant="outline"
                          onPress={() => {
                            if (exp.download_url) {
                              void Linking.openURL(exp.download_url);
                            }
                          }}
                        />
                      )}
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  platformGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  platformCard: {
    width: '48.5%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1.5,
  },
  csvInput: {
    height: 140,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space[3],
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    textAlignVertical: 'top',
  },
  statusBadge: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
});
