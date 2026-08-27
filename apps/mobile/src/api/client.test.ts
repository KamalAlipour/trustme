import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  clearCredentials: vi.fn(async () => undefined),
  readRefreshToken: vi.fn(async () => 'refresh-old'),
  saveRefreshToken: vi.fn(async () => undefined),
  saveCredentials: vi.fn(async () => undefined),
}));
vi.mock('../lib/storage', () => storage);

import { LockedError, request, setAccessToken } from './client';

describe('mobile API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    storage.readRefreshToken.mockResolvedValue('refresh-old');
    storage.clearCredentials.mockClear();
    storage.saveRefreshToken.mockClear();
    setAccessToken('expired');
  });

  it('shares one refresh request across concurrent 401 responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/refresh')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ tokens: { accessToken: 'fresh', refreshToken: 'refresh-new', expiresAt: '', refreshExpiresAt: '' } }), { status: 200 });
      }
      if (url.endsWith('/resource')) {
        const calls = fetchMock.mock.calls.filter(([call]) => String(call).endsWith('/resource')).length;
        return new Response(JSON.stringify(calls <= 2 ? { error: 'expired' } : { ok: true }), { status: calls <= 2 ? 401 : 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const [first, second] = await Promise.all([request<{ ok: boolean }>('/resource'), request<{ ok: boolean }>('/resource')]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/auth/refresh'))).toHaveLength(1);
  });

  it('clears both secure-store values after a failed refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    await expect(request('/resource')).rejects.toMatchObject({ name: 'SessionExpiredError' });
    expect(storage.clearCredentials).toHaveBeenCalledOnce();
  });

  it('parses 423 retryAfter into LockedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'pin temporarily locked', retryAfter: 91 }), { status: 423 }));
    await expect(request('/resource')).rejects.toBeInstanceOf(LockedError);
    try { await request('/resource'); } catch (error) { expect(error).toMatchObject({ retryAfter: 91, status: 423 }); }
  });
});
