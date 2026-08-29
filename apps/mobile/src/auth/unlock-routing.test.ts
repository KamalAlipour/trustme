import { describe, expect, it } from 'vitest';
import { getUnlockDecision } from './unlock-routing';

describe('session unlock routing', () => {
  it('opens the native unlock gate for a stored biometric session', () => {
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'native',
      biometricAvailable: true,
      refreshState: 'pending',
    })).toEqual({ screen: 'unlock', attemptUnlock: true, authentication: 'biometric' });
  });

  it('keeps the native gate when biometrics are unavailable so device authentication can still protect the session', () => {
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'native',
      biometricAvailable: false,
      refreshState: 'pending',
    })).toEqual({ screen: 'unlock', attemptUnlock: true, authentication: 'device-passcode' });
  });

  it('keeps the native unlock gate without clearing credentials after a local authentication failure', () => {
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'native',
      biometricAvailable: true,
      refreshState: 'local-failure',
    })).toEqual({ screen: 'unlock', attemptUnlock: false, authentication: 'biometric' });
  });

  it('returns to login after the server rejects the refresh token', () => {
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'native',
      biometricAvailable: true,
      refreshState: 'server-rejected',
    })).toEqual({ screen: 'login', attemptUnlock: false, authentication: 'none' });
  });

  it('keeps the web behavior free of a device lock screen', () => {
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'web',
      biometricAvailable: false,
      refreshState: 'pending',
    })).toEqual({ screen: 'loading', attemptUnlock: false, authentication: 'none' });
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'web',
      biometricAvailable: false,
      refreshState: 'success',
    })).toEqual({ screen: 'tabs', attemptUnlock: false, authentication: 'none' });
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: true,
      platform: 'web',
      biometricAvailable: true,
      refreshState: 'local-failure',
    })).toEqual({ screen: 'login', attemptUnlock: false, authentication: 'none' });
  });

  it('shows login when no session is stored', () => {
    expect(getUnlockDecision({
      storedSession: false,
      pinAvailable: false,
      platform: 'native',
      biometricAvailable: true,
      refreshState: 'pending',
    })).toEqual({ screen: 'login', attemptUnlock: false, authentication: 'none' });
  });

  it('keeps the native unlock gate for a social session without a stored PIN', () => {
    expect(getUnlockDecision({
      storedSession: true,
      pinAvailable: false,
      platform: 'native',
      biometricAvailable: true,
      refreshState: 'pending',
    })).toEqual({ screen: 'unlock', attemptUnlock: true, authentication: 'biometric' });
  });
});
