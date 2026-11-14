// Visual Share Card Preview & Native Share Sheet Modal (SH-10, PRD §6.34, §6.45, §29.1).
// Governed by:
// 1. Portrait share card with handle watermark and a strip of up to three covers.
// 2. Canonical web URL: <server>/u/{username}/shelves/{slug} (PUBLIC_BASE: the
//    server this build talks to, https://flyleaf.app in development).
// 3. Native OS Share Sheet integration via Share.share.
// 4. One-tap copy link with instant haptic confirmation.

import React, { useState } from 'react';
import {
  Alert,
  Clipboard,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Txt, Button, Cover } from './components';
import { useTheme, space, radius } from './tokens';
import { getShelfShareUrl, getShelfShareMessage } from '../lib/shelfValidation';
import { PUBLIC_BASE } from '../lib/api';
import { track } from '../lib/events';

export interface ShareShelfModalProps {
  visible: boolean;
  onClose: () => void;
  shelf: {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    is_ranked?: boolean;
    item_count?: number;
    cover_ids?: (number | null)[];
    owner: {
      id: string;
      username: string;
      displayName?: string | null;
      avatarKey?: string | null;
    };
  };
}

export function ShareShelfModal({ visible, onClose, shelf }: ShareShelfModalProps) {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const shareUrl = getShelfShareUrl(shelf, PUBLIC_BASE);
  const shareMessage = getShelfShareMessage(shelf);
  const coverIds = (shelf.cover_ids || []).filter((id): id is number => id !== null);

  const handleNativeShare = async () => {
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      track('shelf_shared', { shelf_id: shelf.id, method: 'native_share' });

      await Share.share({
        title: shelf.name,
        message: `${shareMessage}\n\n${shareUrl}`,
        url: shareUrl,
      });
    } catch {
      // Ignored / dismissed
    }
  };

  const handleCopyLink = () => {
    try {
      Clipboard.setString(shareUrl);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      track('shelf_shared', { shelf_id: shelf.id, method: 'copy_link' });
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      Alert.alert('Error', 'Unable to copy link to clipboard.');
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={[styles.backdrop, { backgroundColor: c.overlay }]}>
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityLabel="Dismiss share modal"
        />

        <View
          style={[
            styles.container,
            {
              backgroundColor: c.surface,
              paddingBottom: Math.max(insets.bottom, space[4]),
            },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Txt variant="title">Share shelf</Txt>
            <Pressable
              hitSlop={4}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close share sheet"
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={22} color={c.ink2} />
            </Pressable>
          </View>

          {/* The card as it will be shared: one object, so it sits in a card */}
          <View style={[styles.shareCard, { backgroundColor: c.ground }]}>
            <View style={styles.cardWatermarkRow}>
              <Ionicons name="book-outline" size={16} color={c.muted} />
              <Txt variant="micro" color="muted">
                A shelf on Flyleaf
              </Txt>
            </View>

            {/* A strip of covers */}
            <View style={styles.coverPreviewContainer}>
              {coverIds.length > 0 ? (
                <View style={styles.coverStrip}>
                  {coverIds.slice(0, 3).map((cid, idx) => (
                    <Cover key={idx} coverId={cid} size="s" />
                  ))}
                </View>
              ) : (
                <View style={[styles.emptyPreview, { backgroundColor: c.surface2 }]}>
                  <Ionicons name="library-outline" size={32} color={c.muted} />
                </View>
              )}
            </View>

            {/* Shelf Info */}
            <Txt variant="displayM" numberOfLines={2} style={styles.shelfTitle}>
              {shelf.name}
            </Txt>

            <Txt variant="caption" color="muted" style={styles.curatorText}>
              Curated by{' '}
              <Txt variant="caption" style={{ fontWeight: '500' }}>
                @{shelf.owner.username}
              </Txt>
            </Txt>

            <Txt variant="caption" color="muted" tabular style={styles.metaText}>
              {shelf.is_ranked ? 'Ranked · ' : ''}
              {shelf.item_count ?? 0} {shelf.item_count === 1 ? 'book' : 'books'}
            </Txt>

            {/* Card Footer URL Watermark */}
            <View style={[styles.cardFooter, { borderTopColor: c.line }]}>
              <Txt numberOfLines={1} variant="micro" color="muted">
                {shareUrl.replace(/^https?:\/\//, '')}
              </Txt>
            </View>
          </View>

          {/* Copied Feedback Toast */}
          {copied && (
            <View style={[styles.copiedToast, { backgroundColor: c.ink }]}>
              <Ionicons name="checkmark" size={16} color={c.ground} />
              <Txt variant="caption" style={{ color: c.ground, fontWeight: '500' }}>
                Link copied
              </Txt>
            </View>
          )}

          {/* One primary: share. Copy is the outlined alternative. */}
          <View style={styles.actionRow}>
            <Button
              variant="primary"
              label="Share link"
              onPress={handleNativeShare}
              style={{ flex: 1 }}
            />
            <Button
              variant="secondary"
              label={copied ? 'Copied' : 'Copy link'}
              onPress={handleCopyLink}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    flex: 1,
  },
  container: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderCurve: 'continuous',
    padding: space[4],
    maxWidth: 540,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space[4],
  },
  closeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareCard: {
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space[4],
    alignItems: 'center',
    marginBottom: space[4],
  },
  cardWatermarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginBottom: space[3],
  },
  coverPreviewContainer: {
    marginBottom: space[3],
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 84,
  },
  coverStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  emptyPreview: {
    width: 56,
    height: 84,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shelfTitle: {
    textAlign: 'center',
    marginBottom: space[1],
  },
  curatorText: {
    textAlign: 'center',
    marginBottom: space[1],
  },
  metaText: {
    textAlign: 'center',
    marginBottom: space[3],
  },
  cardFooter: {
    width: '100%',
    paddingTop: space[2],
    borderTopWidth: 1,
    alignItems: 'center',
  },
  copiedToast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingVertical: space[2],
    paddingHorizontal: space[4],
    borderRadius: radius.pill,
    alignSelf: 'center',
    marginBottom: space[3],
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
});
