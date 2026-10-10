// Avatar picker (PRD §6.7, audit 10 A-07-032): library or camera, square
// crop, resized on the device to 512 px JPEG, then the PV-02 presigned upload
// with purpose 'avatar' and PUT /me/avatar. A failure never blocks anything:
// the generated typographic avatar stays.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useEffect, useState } from 'react';
import { api, BASE_URL, loadAccessToken } from './api';

/** The server's avatar policy (uploads/index.ts): JPEG/PNG/WebP, 2 MB. We always send JPEG. */
export const AVATAR_SIZE_PX = 512;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type AvatarSource = 'library' | 'camera';

/** Absolute URL for a profile's avatarUrl (relative to the API origin), or null. */
export function avatarImageUrl(avatarUrl: string | null | undefined): string | null {
  return avatarUrl ? `${BASE_URL}${avatarUrl}` : null;
}

/**
 * An image source for an avatar, with the bearer token: a private account's
 * avatar is served only to signed-in viewers (PRD §16.3).
 */
export function useAvatarSource(avatarUrl: string | null | undefined): { uri: string; headers?: Record<string, string> } | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    void loadAccessToken().then(setToken);
  }, [avatarUrl]);
  const uri = avatarImageUrl(avatarUrl);
  if (!uri) return null;
  return token ? { uri, headers: { authorization: `Bearer ${token}` } } : { uri };
}

/** Decodes base64 to bytes (the upload needs an exact size). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Picks, resizes and uploads. Resolves to the new avatar_url (relative), or null when
 * the user cancelled or refused permission. Throws on an upload failure so
 * the caller can say so.
 */
export async function pickAndUploadAvatar(source: AvatarSource): Promise<string | null> {
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 };
  const picked = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options);
  if (picked.canceled || !picked.assets[0]) return null;

  const resized = await manipulateAsync(
    picked.assets[0].uri,
    [{ resize: { width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX } }],
    { compress: 0.8, format: SaveFormat.JPEG, base64: true },
  );
  if (!resized.base64) throw new Error('The photo could not be read.');
  const bytes = base64ToBytes(resized.base64);
  if (bytes.length > AVATAR_MAX_BYTES) throw new Error('The photo is over 2MB. Choose a smaller one.');

  const result = await api.uploadAvatar(bytes);
  return result.avatar_url;
}
