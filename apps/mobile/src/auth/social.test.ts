import { describe, expect, it } from 'vitest';
import { googleClientIdForPlatform, isAppleSignInAvailable, isGoogleSignInAvailable, type SocialClientIds } from './social-logic';

describe('social sign-in platform selection', () => {
  const clientIds: SocialClientIds = { web: 'web-client', ios: 'ios-client', android: 'android-client' };

  it('selects the platform-specific Google client ID', () => {
    expect(googleClientIdForPlatform('web', clientIds)).toBe('web-client');
    expect(googleClientIdForPlatform('ios', clientIds)).toBe('ios-client');
    expect(googleClientIdForPlatform('android', clientIds)).toBe('android-client');
  });

  it('only enables Apple sign-in on iOS', () => {
    expect(isAppleSignInAvailable('ios')).toBe(true);
    expect(isAppleSignInAvailable('android')).toBe(false);
    expect(isAppleSignInAvailable('web')).toBe(false);
  });

  it('reports Google availability from configured client IDs', () => {
    expect(isGoogleSignInAvailable('web', clientIds)).toBe(true);
    expect(isGoogleSignInAvailable('android', { ...clientIds, android: undefined })).toBe(false);
  });
});
