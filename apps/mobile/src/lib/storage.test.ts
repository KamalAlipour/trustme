import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async (): Promise<string | null> => 'refresh'),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-secure-store', () => secureStore);

import { clearCredentials, hasSeenManifesto, hasStoredCredentials, markManifestoSeen, readPin, readRefreshToken, saveCredentials, saveRefreshToken } from './storage';

describe('secure credential storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it('requires local authentication for refresh token and PIN writes', async () => {
    await saveCredentials('refresh', '2580');
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(1, 'trustcoupon.refreshToken', 'refresh', expect.objectContaining({ requireAuthentication: true }));
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(2, 'trustcoupon.pin', '2580', expect.objectContaining({ requireAuthentication: true }));
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(3, 'trustcoupon.session', '1');
  });
  it('clears both sensitive values', async () => {
    await clearCredentials();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('trustcoupon.refreshToken');
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('trustcoupon.pin');
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('trustcoupon.session');
  });
  it('checks the unprotected session marker without reading protected credentials', async () => {
    secureStore.getItemAsync.mockResolvedValueOnce('1');
    expect(await hasStoredCredentials()).toBe(true);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith('trustcoupon.session');
  });
  it('persists the manifesto flag without protected storage options', async () => {
    secureStore.getItemAsync.mockResolvedValueOnce(null);
    expect(await hasSeenManifesto()).toBe(false);
    await markManifestoSeen();
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('trustcoupon.manifestoSeen', '1');
    secureStore.getItemAsync.mockResolvedValueOnce('1');
    expect(await hasSeenManifesto()).toBe(true);
  });

  it('keeps web credentials in memory only', async () => {
    vi.stubGlobal('window', { localStorage: { getItem: vi.fn(), setItem: vi.fn() } });
    await saveCredentials('web-refresh', '2580');
    expect(await hasStoredCredentials()).toBe(true);
    expect(await readRefreshToken()).toBe('web-refresh');
    expect(await readPin()).toBe('2580');
    await saveRefreshToken('rotated-refresh');
    expect(await readRefreshToken()).toBe('rotated-refresh');
    await clearCredentials();
    expect(await hasStoredCredentials()).toBe(false);
    expect(await readRefreshToken()).toBeNull();
    expect(await readPin()).toBeNull();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('uses localStorage for the non-sensitive web manifesto flag', async () => {
    const localStorage = { getItem: vi.fn<(key: string) => string | null>(() => null), setItem: vi.fn() };
    vi.stubGlobal('window', { localStorage });
    expect(await hasSeenManifesto()).toBe(false);
    await markManifestoSeen();
    expect(localStorage.setItem).toHaveBeenCalledWith('trustcoupon.manifestoSeen', '1');
    localStorage.getItem.mockReturnValue('1');
    expect(await hasSeenManifesto()).toBe(true);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
