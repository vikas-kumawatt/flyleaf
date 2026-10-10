// IM-09: Real-time Import Progress Banner (PRD §24.2, §34.4, AC-9).
//
// Governed by: "The interface recedes; covers advance."
// Displays live import progress, polling GET /v1/imports/:id while queued or processing.
// Provides 1-tap navigation to the Unmatched Review Queue when unmatched books exist.

import React, { useEffect, useState, useRef } from 'react';
import { View, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type ImportResponse } from '@/lib/api';
import { startImportPolling } from '@/lib/importPolling';
import { Card, Txt, ProgressBar, Button, sheet } from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

export interface ImportProgressBannerProps {
  importId: string;
  initialData?: ImportResponse;
  onComplete?: (data: ImportResponse) => void;
  onDismiss?: () => void;
}

export function ImportProgressBanner({
  importId,
  initialData,
  onComplete,
  onDismiss,
}: ImportProgressBannerProps) {
  const c = useTheme();
  const router = useRouter();

  const [job, setJob] = useState<ImportResponse | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  // The latest callback, without restarting the polling when it changes
  // (audit 12, A-12-022: an inline onComplete restarted it on every render).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(
    () =>
      startImportPolling<ImportResponse>({
        fetch: () => api.getImport(importId),
        onUpdate: (data) => {
          setJob(data);
          setError(null);
        },
        onDone: (data) => {
          if (data.state === 'completed') onCompleteRef.current?.(data);
        },
        onError: (err: any) => setError(err?.message || 'Failed to fetch import status'),
      }),
    [importId],
  );

  if (!job) {
    return (
      <Card style={[styles.container, { borderColor: c.line }]}>
        <View style={sheet.row}>
          <ActivityIndicator size="small" color={c.accent} style={{ marginRight: space[2] }} />
          <Txt variant="caption" color="muted">
            Connecting to import service...
          </Txt>
        </View>
      </Card>
    );
  }

  const isQueued = job.state === 'queued';
  const isProcessing = job.state === 'processing';
  const isCompleted = job.state === 'completed';
  const isFailed = job.state === 'failed';

  const processedCount = job.matched + job.unmatched;
  const total = Math.max(job.total_rows, processedCount);
  const progressRatio = total > 0 ? processedCount / total : 0;
  const progressPercent = Math.round(progressRatio * 100);

  const formatSource = (src: string) => {
    switch (src) {
      case 'goodreads':
        return 'Goodreads';
      case 'storygraph':
        return 'The StoryGraph';
      case 'librarything':
        return 'LibraryThing';
      case 'calibre':
        return 'Calibre';
      case 'openlibrary':
        return 'OpenLibrary';
      case 'openreads':
        return 'OpenReads';
      default:
        return src;
    }
  };

  return (
    <Card style={[styles.container, { borderColor: isCompleted ? c.accent : c.line }]}>
      {/* Header Row */}
      <View style={sheet.rowBetween}>
        <View style={[sheet.row, { gap: space[2], flex: 1 }]}>
          {isProcessing || isQueued ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : isCompleted ? (
            <Ionicons name="checkmark-circle" size={18} color={c.accent} />
          ) : (
            <Ionicons name="alert-circle" size={18} color={c.ink} />
          )}

          <Txt variant="caption" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
            {isQueued
              ? `QUEUED · ${formatSource(job.source).toUpperCase()}`
              : isProcessing
              ? `IMPORTING · ${formatSource(job.source).toUpperCase()}`
              : isCompleted
              ? `IMPORT COMPLETE · ${formatSource(job.source).toUpperCase()}`
              : `IMPORT FAILED`}
          </Txt>
        </View>

        {onDismiss && isCompleted && (
          <Pressable
            onPress={onDismiss}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close" size={16} color={c.muted} />
          </Pressable>
        )}
      </View>

      {/* Progress Bar (visible during processing or completed) */}
      {(isProcessing || isCompleted) && (
        <View style={{ gap: space[1], marginTop: space[2] }}>
          <ProgressBar percent={progressPercent} />
          <View style={sheet.rowBetween}>
            <Txt variant="caption" color="muted" tabular style={{ fontSize: 12 }}>
              {isCompleted
                ? `${total} books processed (100%)`
                : `${processedCount} of ${total} books processed (${progressPercent}%)`}
            </Txt>
            <Txt variant="caption" color="muted" tabular style={{ fontSize: 12 }}>
              {job.matched} matched · {job.unmatched} unmatched
            </Txt>
          </View>
        </View>
      )}

      {/* Queued Message */}
      {isQueued && (
        <Txt variant="caption" color="muted" style={{ marginTop: space[2] }}>
          Your export is in queue. Processing will begin shortly...
        </Txt>
      )}

      {/* Failure Message */}
      {isFailed && (
        <Txt variant="caption" color="ink" style={{ marginTop: space[2] }}>
          {job.error || 'Import encountered an error. Please try uploading again.'}
        </Txt>
      )}

      {/* Unmatched Review CTA */}
      {job.unmatched > 0 && (
        <View style={{ marginTop: space[3], paddingTop: space[2], borderTopWidth: 1, borderTopColor: c.line }}>
          <View style={sheet.rowBetween}>
            <View style={{ flex: 1, marginRight: space[2] }}>
              <Txt variant="body" style={{ fontSize: 13, fontWeight: '600' }}>
                {job.unmatched} {job.unmatched === 1 ? 'book needs' : 'books need'} review
              </Txt>
              <Txt variant="caption" color="muted" style={{ fontSize: 11 }}>
                Ambiguous or missing matches are never guessed.
              </Txt>
            </View>

            <Button
              label="Review"
              size="sm"
              variant="primary"
              onPress={() => {
                void Haptics.selectionAsync();
                router.push({
                  pathname: '/import/unmatched' as any,
                  params: { id: job.id },
                });
              }}
            />
          </View>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space[3],
    borderRadius: radius.md,
    marginVertical: space[2],
  },
});
