// Visual Share Card Preview & Native Share Sheet Modal (SH-10, PRD §6.34, §6.45, §29.1).
// Governed by:
// 1. Portrait share card with handle watermark and 4-cover mosaic preview.
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
import { useTheme, space, radius, fontFamilies } from './tokens';
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
              borderColor: c.line,
              paddingBottom: Math.max(insets.bottom, space[4]),
            },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Txt variant="title" style={{ color: c.ink }}>
              Share shelf
            </Txt>
            <Pressable
              hitSlop={12}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close share sheet"
              style={[styles.closeBtn, { backgroundColor: c.surface2 }]}
            >
              <Ionicons name="close" size={18} color={c.ink2} />
            </Pressable>
          </View>

          {/* Visual Share Card Preview (PRD §6.45, §29.1) */}
          <View
            style={[
              styles.shareCard,
              {
                backgroundColor: c.ground,
                borderColor: c.line,
              },
            ]}
          >
            <View style={styles.cardWatermarkRow}>
              <Ionicons name="book-outline" size={16} color={c.muted} />
              <Txt variant="micro" color="muted">
                A shelf on Flyleaf
              </Txt>
            </View>

            {/* 4-Cover Mosaic Preview */}
            <View style={styles.coverPreviewContainer}>
              {coverIds.length >= 4 ? (
                <View style={styles.mosaicGrid}>
                  {coverIds.slice(0, 4).map((cid, idx) => (
                    <View key={idx} style={styles.mosaicCell}>
                      <Cover coverId={cid} size="xs" />
                    </View>
                  ))}
                </View>
              ) : coverIds.length > 0 ? (
                <View style={styles.stackRow}>
                  {coverIds.slice(0, 3).map((cid, idx) => (
                    <View
                      key={idx}
                      style={[
                        styles.stackCover,
                        { marginLeft: idx === 0 ? 0 : -space[3], zIndex: 10 - idx },
                      ]}
                    >
                      <Cover coverId={cid} size="s" />
                    </View>
                  ))}
                </View>
              ) : (
                <View style={[styles.emptyPreview, { backgroundColor: c.surface2 }]}>
                  <Ionicons name="library-outline" size={32} color={c.muted} />
                </View>
              )}
            </View>

            {/* Shelf Info */}
            <Txt numberOfLines={2} style={[styles.shelfTitle, { color: c.ink }]}>
              {shelf.name}
            </Txt>

            <Txt variant="caption" style={[styles.curatorText, { color: c.muted }]}>
              Curated by{' '}
              <Txt variant="caption" style={{ color: c.ink, fontWeight: '500' }}>
                @{shelf.owner.username}
              </Txt>
            </Txt>

            <View style={styles.metaBadgeRow}>
              <Txt variant="caption" color="muted" tabular>
                {shelf.is_ranked ? 'Ranked · ' : ''}
                {shelf.item_count ?? 0} {shelf.item_count === 1 ? 'book' : 'books'}
              </Txt>
            </View>

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
              <Txt variant="caption" style={[styles.copiedText, { color: c.ground }]}>Link copied</Txt>
            </View>
          )}

          {/* Share Action Buttons */}
          <View style={styles.actionRow}>
            <Button
              variant="primary"
              label="Share link"
              onPress={handleNativeShare}
              style={{ flex: 1, marginRight: space[2] }}
            />
            <Button
              variant="secondary"
              label={copied ? 'Copied' : 'Copy link'}
              onPress={handleCopyLink}
              style={{ flex: 1, marginLeft: space[2] }}
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
    borderWidth: 1,
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
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
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
    minHeight: 104,
  },
  mosaicGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 104,
    height: 104,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  mosaicCell: {
    width: 52,
    height: 52,
    overflow: 'hidden',
  },
  stackRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stackCover: {},
  emptyPreview: {
    width: 72,
    height: 96,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shelfTitle: {
    fontFamily: fontFamilies.displayMedium,
    fontWeight: '500',
    fontSize: 20,
    lineHeight: 26,
    textAlign: 'center',
    marginBottom: space[1],
  },
  curatorText: {
    textAlign: 'center',
    marginBottom: space[2],
  },
  metaBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
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
    borderRadius: radius.md,
    alignSelf: 'center',
    marginBottom: space[3],
  },
  copiedText: {
    fontWeight: '500',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
