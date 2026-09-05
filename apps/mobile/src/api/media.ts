import * as FileSystem from 'expo-file-system';
import { request } from './client';
import type { MediaAsset, MediaKind } from './types';
import { isWebPlatform } from '../lib/platform';
import type { Translations } from '../i18n/en';
import { en } from '../i18n/en';
import { DEFAULT_DISPLAY_UNIT } from '../i18n/display-unit';

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
  captureSessionId?: string;
  step?: string;
}, t: Translations = en(DEFAULT_DISPLAY_UNIT)): Promise<UploadedMedia> {
  if (!isWebPlatform()) {
    const info = await FileSystem.getInfoAsync(input.uri, { size: true });
    if (info.exists && info.size !== undefined && info.size > (input.kind === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_NON_VIDEO_BYTES)) {
      throw new Error(t[input.kind === 'VIDEO' ? 'fileTooLargeVideo' : 'fileTooLarge']);
    }
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
  if (isWebPlatform()) {
    const response = await fetch(input.uri);
    const blob = await response.blob();
    if (blob.size > (input.kind === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_NON_VIDEO_BYTES)) {
      throw new Error(t[input.kind === 'VIDEO' ? 'fileTooLargeVideo' : 'fileTooLarge']);
    }
    form.append('file', new File([blob], opaqueName, { type: input.mimeType }));
  } else {
    form.append('file', { uri: input.uri, name: opaqueName, type: input.mimeType } as unknown as Blob);
  }
  if (input.captureSessionId !== undefined) form.append('captureSessionId', input.captureSessionId);
  if (input.step !== undefined) form.append('step', input.step);
  return request<UploadedMedia>('/v1/me/media', { method: 'POST', body: form });
}
