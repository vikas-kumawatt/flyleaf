// Barcode Scanner Screen (PRD §6.23, design.md §10, SL-44).
//
// Features:
// - expo-camera CameraView with barcode scanning
// - Pre-permission rationale view before triggering OS prompt
// - Laser/framing guide reticle overlay
// - Torch toggle
// - Instant ISBN resolution via api.lookupIsbn(isbn)
// - Manual ISBN entry fallback
// - Content interstitial for an explicit work the viewer's search filter
//   hides (PRD §7.8): shown before the book opens, never blocks it

import React, { useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { FlyleafApiError } from '@flyleaf/api-client';
import {
  View,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api } from '@/lib/api';
import {
  Button,
  Card,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { palette, space, radius, useTheme } from '@/ui/tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The viewfinder sits over a live camera feed, so it always uses the dark
// values whatever the app theme is.
const cam = {
  ground: palette.ground.dark,
  ink: palette.ink.dark,
  ink2: palette.ink2.dark,
  raised: palette.surface2.dark,
  line: palette.lineStrong.dark,
  scrim: palette.scrim.dark,
  accent: palette.accent.dark,
  critical: palette.critical.dark,
};

export default function ScannerScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();

  const [torch, setTorch] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when the scanned work is explicit and search hides it from this
  // viewer (the API's content_warning). The book still opens, after this.
  const [warning, setWarning] = useState<{ workId: string; title: string } | null>(null);

  // Manual fallback state
  const [manualMode, setManualMode] = useState(false);
  const [manualIsbn, setManualIsbn] = useState('');
  // A code that just missed stays in view: without this it was looked up
  // again on every camera frame (audit 08).
  const lastMiss = useRef<{ code: string; at: number } | null>(null);

  const handleLookupIsbn = async (isbn: string) => {
    const cleaned = isbn.replace(/[^0-9X]/gi, '');
    if (cleaned.length < 10) {
      setErrorMessage('Please enter a valid 10 or 13-digit ISBN.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await api.lookupIsbn(cleaned);
      if (res && res.work) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (res.content_warning) {
          setWarning({ workId: res.work.id, title: res.work.title });
        } else {
          router.replace(`/work/${res.work.id}`);
        }
      } else {
        setErrorMessage(`No edition found in catalog for ISBN ${cleaned}.`);
        lastMiss.current = { code: isbn, at: Date.now() };
        setScanned(false);
      }
    } catch (err) {
      // Only a 404 means "not in the catalog"; offline or a server error is
      // not the book's fault and should say so.
      setErrorMessage(
        err instanceof FlyleafApiError && err.status === 404
          ? `No edition found in catalog for ISBN ${cleaned}.`
          : err instanceof FlyleafApiError && err.status === 422
            ? 'That barcode is not a valid ISBN.'
            : 'Could not look that up. Check your connection and try again.',
      );
      lastMiss.current = { code: isbn, at: Date.now() };
      setScanned(false);
    } finally {
      setLoading(false);
    }
  };

  const onBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned || loading) return;
    if (lastMiss.current && lastMiss.current.code === data && Date.now() - lastMiss.current.at < 3000) return;
    setScanned(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void handleLookupIsbn(data);
  };

  // 0. Content interstitial (PRD §7.8 [LOCKED]): "a user is never blocked
  // from recording a book they actually read", so it only asks, once per scan.
  if (warning) {
    return (
      <Screen>
        <View style={{ flex: 1, padding: space[6], justifyContent: 'center', gap: space[6] }}>
          <View style={{ alignItems: 'center', gap: space[3] }}>
            <Ionicons name="eye-off-outline" size={36} color={c.accent} />
            <Txt variant="displayM" style={{ textAlign: 'center' }}>
              Explicit content
            </Txt>
            <Txt variant="body" color="muted" style={{ textAlign: 'center', lineHeight: 22 }}>
              {warning.title} is marked explicit. Your content settings hide it from search, but you
              can still open it and log it.
            </Txt>
          </View>
          <View style={{ gap: space[3] }}>
            <Button
              label="Continue to book"
              variant="primary"
              onPress={() => {
                // Asked once: the book page does not ask again for this work.
                void SecureStore.setItemAsync(`explicit_ack_${warning.workId}`, '1').catch(() => {});
                router.replace(`/work/${warning.workId}`);
              }}
            />
            <Button
              label="Scan another"
              variant="secondary"
              onPress={() => {
                setWarning(null);
                setScanned(false);
              }}
            />
          </View>
        </View>
      </Screen>
    );
  }

  // 1. Permission Rationale View (PRD §6.23: "Rationale shown before the OS prompt")
  if (!permission || !permission.granted) {
    return (
      <Screen>
        <View style={{ flex: 1, padding: space[6], justifyContent: 'center', gap: space[6] }}>
          <View style={{ alignItems: 'center', gap: space[3] }}>
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                backgroundColor: c.surface2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="barcode-outline" size={32} color={c.ink2} />
            </View>
            <Txt variant="displayM" style={{ textAlign: 'center' }}>
              Scan a barcode
            </Txt>
            <Txt
              variant="body"
              color="muted"
              style={{ textAlign: 'center' }}
            >
              Flyleaf uses the camera to read the ISBN barcode on the back of a book, so you can log it
              without typing.
            </Txt>
          </View>

          <View style={{ gap: space[3] }}>
            <Button
              label="Enable camera access"
              variant="primary"
              onPress={requestPermission}
            />
            <Button
              label="Enter ISBN manually instead"
              variant="secondary"
              onPress={() => setManualMode(true)}
            />
            <Button
              label="Go back"
              variant="tertiary"
              onPress={() => router.back()}
            />
          </View>

          {manualMode && (
            <Card style={{ gap: space[3], marginTop: space[4] }}>
              <Txt variant="title">Enter an ISBN</Txt>
              <TextInput
                value={manualIsbn}
                onChangeText={setManualIsbn}
                placeholder="e.g. 9780571353408"
                placeholderTextColor={c.muted}
                keyboardType="numeric"
                style={{
                  minHeight: 48,
                  borderWidth: 1,
                  borderColor: c.line,
                  borderRadius: radius.md,
                  paddingHorizontal: space[3],
                  color: c.ink,
                  backgroundColor: c.surface,
                }}
              />
              {errorMessage && (
                <Txt variant="caption" color="critical">
                  {errorMessage}
                </Txt>
              )}
              <Button
                label={loading ? 'Searching…' : 'Look up'}
                variant="primary"
                disabled={loading || manualIsbn.length < 10}
                onPress={() => handleLookupIsbn(manualIsbn)}
              />
            </Card>
          )}
        </View>
      </Screen>
    );
  }

  // 2. Active Scanner Viewfinder
  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        enableTorch={torch}
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'qr'],
        }}
        onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
      />

      {/* Top Controls Overlay */}
      <View style={[styles.topOverlay, { paddingTop: insets.top + space[2] }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
          style={styles.iconCircle}
        >
          <Ionicons name="close" size={24} color={cam.ink} />
        </Pressable>

        <Txt variant="title" style={{ color: cam.ink }}>
          Scan a barcode
        </Txt>

        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            setTorch(!torch);
          }}
          accessibilityRole="button"
          accessibilityLabel={torch ? 'Turn off torch' : 'Turn on torch'}
          style={styles.iconCircle}
        >
          <Ionicons
            name={torch ? 'flash' : 'flash-outline'}
            size={22}
            color={cam.ink}
          />
        </Pressable>
      </View>

      {/* Center Viewfinder Framing Reticle */}
      <View style={styles.reticleContainer}>
        <View style={styles.reticleBox}>
          {/* Corner accents */}
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />

          {loading ? (
            <ActivityIndicator color={cam.ink} />
          ) : (
            <View style={[styles.scanLine, { backgroundColor: cam.accent }]} />
          )}
        </View>

        <Txt variant="caption" style={{ color: cam.ink, marginTop: space[4], textAlign: 'center' }}>
          Fit the barcode on the back cover inside the frame
        </Txt>

        {errorMessage && (
          <View
            style={{
              backgroundColor: cam.scrim,
              paddingHorizontal: space[3],
              paddingVertical: space[2],
              borderRadius: radius.md,
              marginTop: space[3],
            }}
          >
            <Txt variant="caption" style={{ color: cam.critical }}>
              {errorMessage}
            </Txt>
          </View>
        )}
      </View>

      {/* Bottom Manual Entry Shortcut */}
      <View style={[styles.bottomOverlay, { paddingBottom: insets.bottom + space[6] }]}>
        <Button
          label="Enter ISBN manually"
          variant="secondary"
          onPress={() => {
            setManualMode(true);
            setScanned(true);
          }}
        />
      </View>

      {/* Manual Input Dialog when triggered */}
      {manualMode && (
        <View style={styles.manualModalOverlay}>
          <Card style={{ gap: space[3], width: '90%', maxWidth: 400 }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="title">Enter an ISBN</Txt>
              <Pressable
                onPress={() => {
                  setManualMode(false);
                  setScanned(false);
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={22} color={c.muted} />
              </Pressable>
            </View>

            <TextInput
              value={manualIsbn}
              onChangeText={setManualIsbn}
              placeholder="10 or 13 digits"
              placeholderTextColor={c.muted}
              keyboardType="numeric"
              autoFocus
              style={{
                minHeight: 48,
                borderWidth: 1,
                borderColor: c.line,
                borderRadius: radius.md,
                paddingHorizontal: space[3],
                color: c.ink,
                backgroundColor: c.surface,
              }}
            />

            {errorMessage && (
              <Txt variant="caption" color="critical">
                {errorMessage}
              </Txt>
            )}

            <Button
              label={loading ? 'Searching…' : 'Look up'}
              variant="primary"
              disabled={loading || manualIsbn.length < 10}
              onPress={() => handleLookupIsbn(manualIsbn)}
            />
          </Card>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: cam.ground,
  },
  topOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: space[4],
    backgroundColor: cam.scrim,
    paddingHorizontal: space[4],
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: cam.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[6],
  },
  reticleBox: {
    width: 280,
    height: 180,
    borderWidth: 1,
    borderColor: cam.line,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: cam.ink,
  },
  topLeft: {
    top: -2,
    left: -2,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: radius.lg,
  },
  topRight: {
    top: -2,
    right: -2,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: radius.lg,
  },
  bottomLeft: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: radius.lg,
  },
  bottomRight: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: radius.lg,
  },
  scanLine: {
    width: '90%',
    height: 2,
    opacity: 0.8,
  },
  bottomOverlay: {
    paddingHorizontal: space[4],
    paddingTop: space[4],
    backgroundColor: cam.scrim,
  },
  manualModalOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: cam.scrim,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
  },
});
