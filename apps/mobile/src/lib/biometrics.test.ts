import { beforeEach, describe, expect, it, vi } from 'vitest';

const localAuth = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(async () => true),
  isEnrolledAsync: vi.fn(async () => false),
  authenticateAsync: vi.fn(async () => ({ success: true })),
}));
const storage = vi.hoisted(() => ({ readPin: vi.fn(async () => '2580'), readRefreshToken: vi.fn(async () => 'refresh') }));
vi.mock('expo-local-authentication', () => localAuth);
vi.mock('./storage', () => storage);

import { biometricAvailable, resetBiometricAvailability, unlockPin } from './biometrics';

describe('biometric fallback', () => {
  beforeEach(() => {
    resetBiometricAvailability();
    localAuth.authenticateAsync.mockClear();
  });
  it('uses the PIN pad path when no biometric is enrolled', async () => {
    expect(await biometricAvailable()).toBe(false);
    expect(await unlockPin()).toBeNull();
    expect(localAuth.authenticateAsync).not.toHaveBeenCalled();
  });
});
