import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystem = vi.hoisted(() => ({ getInfoAsync: vi.fn(async () => ({ exists: true, size: 100 })) }));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('expo-file-system', () => fileSystem);
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('../lib/storage', () => ({
  clearCredentials: vi.fn(async () => undefined),
  readRefreshToken: vi.fn(async () => 'refresh'),
  saveRefreshToken: vi.fn(async () => undefined),
}));

import { ApiError, setAccessToken } from './client';
import { uploadMedia } from './media';

describe('authenticated media upload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAccessToken('member-token');
    fileSystem.getInfoAsync.mockResolvedValue({ exists: true, size: 100 });
    class FakeFormData {
      private readonly values = new Map<string, unknown>();
      append(name: string, value: unknown): void { this.values.set(name, value); }
      get(name: string): unknown { return this.values.get(name); }
    }
    vi.stubGlobal('FormData', FakeFormData);
  });

  it('assembles multipart form data without a JSON content type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'media-id', kind: 'IMAGE', mimeType: 'image/jpeg', byteSize: 100 }), { status: 201 }));
    await uploadMedia({ uri: 'file:///private/path/photo.jpg', kind: 'IMAGE', mimeType: 'image/jpeg' });
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(init.headers).toEqual({ accept: 'application/json', authorization: 'Bearer member-token', 'x-device-label': 'iOS app' });
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('kind')).toBe('IMAGE');
    expect(form.get('file')).toMatchObject({ name: 'evidence.jpg', type: 'image/jpeg', uri: 'file:///private/path/photo.jpg' });
  });

  it('preserves HTTP 413 for oversized media', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'media file is too large' }), { status: 413 }));
    await expect(uploadMedia({ uri: 'file:///video.mp4', kind: 'VIDEO', mimeType: 'video/mp4' })).rejects.toMatchObject({ status: 413 });
  });

  it('preserves HTTP 415 for unsupported media', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'unsupported media type' }), { status: 415 }));
    await expect(uploadMedia({ uri: 'file:///photo.jpg', kind: 'IMAGE', mimeType: 'image/jpeg' })).rejects.toEqual(expect.any(ApiError));
  });
});
