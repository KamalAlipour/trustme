import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async () => 'refresh'),
  deleteItemAsync: vi.fn(async () => undefined),
}));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('expo-secure-store', () => secureStore);
vi.mock('react-native', () => ({ Platform: platform }));

import { clearCredentials, hasSeenManifesto, hasStoredCredentials, markManifestoSeen, readInstallationId, readPin, readRefreshToken, saveCredentials, saveCredentialsWithoutPin, saveRefreshToken } from './storage';

describe('secure credential storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    platform.OS = 'ios';
  });
  it('requires local authentication for refresh token and PIN writes', async () => {
    vi.stubGlobal('window', { localStorage: { getItem: vi.fn(), setItem: vi.fn() } });
    await saveCredentials('refresh', '2580');
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(1, 'trustcoupon.refreshToken', 'refresh', { requireAuthentication: true, keychainAccessible: 'when-unlocked' });
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
  it('stores a social session without creating an empty PIN', async () => {
    secureStore.getItemAsync.mockImplementation(async (key: string) => key === 'trustcoupon.pin' ? null : '1');
    await saveCredentialsWithoutPin('social-refresh');
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(1, 'trustcoupon.refreshToken', 'social-refresh', expect.objectContaining({ requireAuthentication: true }));
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(2, 'trustcoupon.session', '1');
    expect(secureStore.setItemAsync).not.toHaveBeenCalledWith('trustcoupon.pin', expect.anything(), expect.anything());
    expect(await hasStoredCredentials()).toBe(true);
    expect(await readPin()).toBeNull();
  });
  it('treats a legacy empty PIN as unavailable', async () => {
    secureStore.getItemAsync.mockImplementation(async (key: string) => key === 'trustcoupon.pin' ? '' : null);
    expect(await readPin()).toBeNull();
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
    platform.OS = 'web';
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
    platform.OS = 'web';
    const localStorage = { getItem: vi.fn<(key: string) => string | null>(() => null), setItem: vi.fn() };
    vi.stubGlobal('window', { localStorage });
    expect(await hasSeenManifesto()).toBe(false);
    await markManifestoSeen();
    expect(localStorage.setItem).toHaveBeenCalledWith('trustcoupon.manifestoSeen', '1');
    localStorage.getItem.mockReturnValue('1');
    expect(await hasSeenManifesto()).toBe(true);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('generates and reuses a web installation ID', async () => {
    platform.OS = 'web';
    let stored: string | null = null;
    const localStorage = {
      getItem: vi.fn<(key: string) => string | null>(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; }),
    };
    vi.stubGlobal('window', { localStorage });
    const first = await readInstallationId();
    const second = await readInstallationId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(second).toBe(first);
    expect(localStorage.setItem).toHaveBeenCalledWith('trustcoupon.installationId', first);
  });

  it('persists a native installation ID without protected storage options', async () => {
    secureStore.getItemAsync.mockImplementation(async (key: string) => key === 'trustcoupon.installationId' ? null : 'refresh');
    const installationId = await readInstallationId();
    expect(installationId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('trustcoupon.installationId', installationId);
  });
});
