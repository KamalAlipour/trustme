import * as FileSystem from 'expo-file-system';
import { request } from './client';
import type { MediaAsset, MediaKind } from './types';
import { isWebPlatform } from '../lib/platform';

const MAX_NON_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export type UploadedMedia = MediaAsset;

export class BrowserFileSystemUnavailableError extends Error {
  public constructor() {
    super('File system operations are unavailable on web');
    this.name = 'BrowserFileSystemUnavailableError';
  }
}

export async function uploadMedia(input: {
  uri: string;
  kind: MediaKind;
  mimeType: string;
}): Promise<UploadedMedia> {
  if (isWebPlatform()) throw new BrowserFileSystemUnavailableError();
  const info = await FileSystem.getInfoAsync(input.uri, { size: true });
  if (info.exists && info.size !== undefined) {
    const maximum = input.kind === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_NON_VIDEO_BYTES;
    if (info.size > maximum) throw new Error(input.kind === 'VIDEO' ? 'ویدئو نمی‌تواند بیشتر از ۵۰ مگابایت باشد.' : 'فایل نمی‌تواند بیشتر از ۱۰ مگابایت باشد.');
  }
  const opaqueName = input.kind === 'VIDEO'
    ? 'evidence.mp4'
    : input.kind === 'AUDIO'
      ? 'evidence.m4a'
      : input.kind === 'DOCUMENT'
        ? 'evidence.pdf'
        : input.mimeType === 'image/png' ? 'evidence.png' : 'evidence.jpg';
  const form = new FormData();
  form.append('kind', input.kind);
  form.append('file', { uri: input.uri, name: opaqueName, type: input.mimeType } as unknown as Blob);
  return request<UploadedMedia>('/v1/me/media', { method: 'POST', body: form });
}
