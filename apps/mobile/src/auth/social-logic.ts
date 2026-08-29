export type SocialPlatform = 'web' | 'ios' | 'android' | 'windows' | 'macos' | 'native';

export type SocialClientIds = {
  web: string | undefined;
  ios: string | undefined;
  android: string | undefined;
};

export function googleClientIdForPlatform(platform: SocialPlatform, clientIds: SocialClientIds): string | undefined {
  if (platform === 'web') return clientIds.web;
  if (platform === 'ios') return clientIds.ios;
  if (platform === 'android') return clientIds.android;
  return undefined;
}

export function isGoogleSignInAvailable(platform: SocialPlatform, clientIds: SocialClientIds): boolean {
  return googleClientIdForPlatform(platform, clientIds) !== undefined;
}

export function isAppleSignInAvailable(platform: SocialPlatform): boolean {
  return platform === 'ios';
}
