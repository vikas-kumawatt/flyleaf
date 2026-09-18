// Visual Share Card Preview & Native Share Sheet Modal (SH-10, PRD §6.34, §6.45, §29.1).
// Governed by:
// 1. Portrait share card with handle watermark and 4-cover mosaic preview.
// 2. Canonical web URL: https://flyleaf.app/u/{username}/shelves/{slug}.
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

  const shareUrl = getShelfShareUrl(shelf);
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
      <View style={styles.backdrop}>
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityLabel="Dismiss share modal"
        />

        <View
          style={[
            styles.container,
            {
              backgroundColor: c.ground,
              borderColor: c.line,
              paddingBottom: Math.max(insets.bottom, space[4]),
            },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Txt variant="title" style={{ color: c.ink }}>
              Share Shelf
            </Txt>
            <Pressable
              hitSlop={12}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close share sheet"
              style={[styles.closeBtn, { backgroundColor: c.surface }]}
            >
              <Ionicons name="close" size={20} color={c.ink} />
            </Pressable>
          </View>

          {/* Visual Share Card Preview (PRD §6.45, §29.1) */}
          <View
            style={[
              styles.shareCard,
              {
                backgroundColor: c.surface,
                borderColor: c.line,
              },
            ]}
          >
            <View style={styles.cardWatermarkRow}>
              <Ionicons name="book" size={14} color={c.accent} />
              <Txt variant="micro" style={[styles.brandTag, { color: c.accent }]}>
                FLYLEAF CURATION
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
              <Txt variant="caption" style={{ color: c.ink, fontWeight: '600' }}>
                @{shelf.owner.username}
              </Txt>
            </Txt>

            <View style={styles.metaBadgeRow}>
              {shelf.is_ranked && (
                <View style={[styles.badge, { backgroundColor: c.accent + '20' }]}>
                  <Ionicons name="reorder-four" size={12} color={c.accent} />
                  <Txt variant="caption" style={{ color: c.accent, fontWeight: '600', marginLeft: 4 }}>
                    Ranked
                  </Txt>
                </View>
              )}
              <View style={[styles.badge, { backgroundColor: c.line }]}>
                <Txt variant="caption" style={{ color: c.muted, fontWeight: '500' }}>
                  {shelf.item_count ?? 0} {shelf.item_count === 1 ? 'book' : 'books'}
                </Txt>
              </View>
            </View>

            {/* Card Footer URL Watermark */}
            <View style={[styles.cardFooter, { borderTopColor: c.line }]}>
              <Txt numberOfLines={1} variant="caption" style={{ color: c.muted, fontSize: 11 }}>
                flyleaf.app/u/{shelf.owner.username}/shelves/{shelf.slug}
              </Txt>
            </View>
          </View>

          {/* Copied Feedback Toast */}
          {copied && (
            <View style={[styles.copiedToast, { backgroundColor: c.accent }]}>
              <Ionicons name="checkmark-circle" size={16} color="#12100e" />
              <Txt style={styles.copiedText}>Link copied to clipboard!</Txt>
            </View>
          )}

          {/* Share Action Buttons */}
          <View style={styles.actionRow}>
            <Button
              variant="primary"
              label="Share Link"
              onPress={handleNativeShare}
              style={{ flex: 1, marginRight: space[2] }}
            />
            <Button
              variant="secondary"
              label={copied ? 'Copied' : 'Copy Link'}
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
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'flex-end',
  },
  scrim: {
    flex: 1,
  },
  container: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
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
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space[4],
    alignItems: 'center',
    marginBottom: space[4],
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
  },
  cardWatermarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: space[3],
  },
  brandTag: {
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  coverPreviewContainer: {
    marginBottom: space[3],
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 90,
  },
  mosaicGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 104,
    height: 104,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
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
  stackCover: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  emptyPreview: {
    width: 72,
    height: 96,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shelfTitle: {
    fontFamily: 'Literata_600SemiBold',
    fontSize: 20,
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
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
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
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    alignSelf: 'center',
    marginBottom: space[3],
  },
  copiedText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#12100e',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
