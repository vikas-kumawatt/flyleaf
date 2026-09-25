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

import React, { useState } from 'react';
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
import { space, radius, useTheme } from '@/ui/tokens';

export default function ScannerScreen() {
  const c = useTheme();
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
        setScanned(false);
      }
    } catch {
      setErrorMessage(`No edition found in catalog for ISBN ${cleaned}.`);
      setScanned(false);
    } finally {
      setLoading(false);
    }
  };

  const onBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned || loading) return;
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
              onPress={() => router.replace(`/work/${warning.workId}`)}
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
                backgroundColor: c.accentSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="camera-outline" size={36} color={c.accent} />
            </View>
            <Txt variant="displayM" style={{ textAlign: 'center' }}>
              Scan Book Barcodes
            </Txt>
            <Txt
              variant="body"
              color="muted"
              style={{ textAlign: 'center', lineHeight: 22 }}
            >
              Flyleaf uses your camera to scan ISBN barcodes on the back of physical books, so you can
              instantly log, rate, and track what you read without typing.
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
              <Txt variant="title">Manual ISBN Entry</Txt>
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
                <Txt variant="caption" color="accent">
                  {errorMessage}
                </Txt>
              )}
              <Button
                label={loading ? 'Searching…' : 'Lookup ISBN'}
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
      <View style={[styles.topOverlay, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
          style={styles.iconCircle}
        >
          <Ionicons name="close" size={24} color="#FFFFFF" />
        </Pressable>

        <Txt variant="title" style={{ color: '#FFFFFF' }}>
          Scan ISBN Barcode
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
            color={torch ? '#FFD700' : '#FFFFFF'}
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
            <ActivityIndicator size="large" color={c.accent} />
          ) : (
            <View style={[styles.scanLine, { backgroundColor: c.accent }]} />
          )}
        </View>

        <Txt variant="caption" style={{ color: '#FFFFFF', marginTop: space[4], textAlign: 'center' }}>
          Center the ISBN barcode on the back cover inside the frame
        </Txt>

        {errorMessage && (
          <View
            style={{
              backgroundColor: 'rgba(0,0,0,0.85)',
              paddingHorizontal: space[3],
              paddingVertical: space[2],
              borderRadius: radius.md,
              marginTop: space[3],
            }}
          >
            <Txt variant="caption" style={{ color: '#FFB4AB' }}>
              {errorMessage}
            </Txt>
          </View>
        )}
      </View>

      {/* Bottom Manual Entry Shortcut */}
      <View style={[styles.bottomOverlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
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
              <Txt variant="title">Enter ISBN Manually</Txt>
              <Pressable
                onPress={() => {
                  setManualMode(false);
                  setScanned(false);
                }}
                hitSlop={8}
              >
                <Ionicons name="close" size={22} color={c.muted} />
              </Pressable>
            </View>

            <TextInput
              value={manualIsbn}
              onChangeText={setManualIsbn}
              placeholder="10 or 13-digit ISBN (e.g. 9780571353408)"
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
              <Txt variant="caption" color="accent">
                {errorMessage}
              </Txt>
            )}

            <Button
              label={loading ? 'Searching…' : 'Lookup Book'}
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
    backgroundColor: '#000000',
  },
  topOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 50,
    paddingBottom: space[4],
    paddingHorizontal: space[4],
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.2)',
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
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#FFFFFF',
  },
  topLeft: {
    top: -2,
    left: -2,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 16,
  },
  topRight: {
    top: -2,
    right: -2,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 16,
  },
  bottomLeft: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 16,
  },
  bottomRight: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 16,
  },
  scanLine: {
    width: '90%',
    height: 2,
    opacity: 0.8,
  },
  bottomOverlay: {
    paddingHorizontal: space[4],
    paddingBottom: 40,
    paddingTop: space[4],
  },
  manualModalOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
  },
});
