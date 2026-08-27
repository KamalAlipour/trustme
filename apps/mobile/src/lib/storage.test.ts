import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => 'refresh'),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-secure-store', () => secureStore);

import { clearCredentials, saveCredentials } from './storage';

describe('secure credential storage', () => {
  beforeEach(() => vi.clearAllMocks());
  it('requires local authentication for refresh token and PIN writes', async () => {
    await saveCredentials('refresh', '2580');
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(1, 'trustcoupon.refreshToken', 'refresh', expect.objectContaining({ requireAuthentication: true }));
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(2, 'trustcoupon.pin', '2580', expect.objectContaining({ requireAuthentication: true }));
  });
  it('clears both sensitive values', async () => {
    await clearCredentials();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('trustcoupon.refreshToken');
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('trustcoupon.pin');
  });
});
