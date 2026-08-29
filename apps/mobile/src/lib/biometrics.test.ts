import { beforeEach, describe, expect, it, vi } from 'vitest';

const localAuth = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(async () => true),
  isEnrolledAsync: vi.fn(async () => false),
  authenticateAsync: vi.fn(async () => ({ success: true })),
}));
const storage = vi.hoisted(() => ({
  readPin: vi.fn<() => Promise<string | null>>(async () => '2580'),
  readRefreshToken: vi.fn<() => Promise<string | null>>(async () => 'refresh'),
}));
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
  it('returns no step-up PIN when the protected PIN is absent', async () => {
    localAuth.isEnrolledAsync.mockResolvedValue(true);
    storage.readPin.mockResolvedValue(null);
    expect(await unlockPin()).toBeNull();
    expect(localAuth.authenticateAsync).toHaveBeenCalled();
  });
});
