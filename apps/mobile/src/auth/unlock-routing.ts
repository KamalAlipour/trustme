export type RefreshState = 'pending' | 'success' | 'local-failure' | 'server-rejected' | 'other-failure';
export type UnlockScreen = 'loading' | 'login' | 'unlock' | 'tabs';
export type UnlockDecision = {
  screen: UnlockScreen;
  attemptUnlock: boolean;
  authentication: 'biometric' | 'device-passcode' | 'none';
};

export function getUnlockDecision(input: {
  storedSession: boolean;
  pinAvailable?: boolean;
  platform: 'web' | 'native';
  biometricAvailable: boolean;
  refreshState: RefreshState;
}): UnlockDecision {
  if (!input.storedSession) return { screen: 'login', attemptUnlock: false, authentication: 'none' };

  if (input.platform === 'web') {
    if (input.refreshState === 'pending') return { screen: 'loading', attemptUnlock: false, authentication: 'none' };
    if (input.refreshState === 'success') return { screen: 'tabs', attemptUnlock: false, authentication: 'none' };
    return { screen: 'login', attemptUnlock: false, authentication: 'none' };
  }

  const authentication = input.biometricAvailable ? 'biometric' : 'device-passcode';
  if (input.refreshState === 'pending') return { screen: 'unlock', attemptUnlock: true, authentication };
  if (input.refreshState === 'success') return { screen: 'tabs', attemptUnlock: false, authentication };
  if (input.refreshState === 'server-rejected') return { screen: 'login', attemptUnlock: false, authentication: 'none' };
  return { screen: 'unlock', attemptUnlock: false, authentication };
}
