import { Platform } from 'react-native';
import {
  googleClientIdForPlatform as selectGoogleClientId,
  isAppleSignInAvailable as checkAppleSignInAvailable,
  isGoogleSignInAvailable as checkGoogleSignInAvailable,
  type SocialClientIds,
  type SocialPlatform,
} from './social-logic';

export type { SocialClientIds, SocialPlatform } from './social-logic';

export const socialClientIds: SocialClientIds = {
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined,
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || undefined,
  android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || undefined,
};

export function googleClientIdForPlatform(
  platform: typeof Platform.OS = Platform.OS,
  clientIds: SocialClientIds = socialClientIds,
): string | undefined {
  return selectGoogleClientId(platform as SocialPlatform, clientIds);
}

export function isGoogleSignInAvailable(
  platform: typeof Platform.OS = Platform.OS,
  clientIds: SocialClientIds = socialClientIds,
): boolean {
  return checkGoogleSignInAvailable(platform as SocialPlatform, clientIds);
}

export function isAppleSignInAvailable(platform: typeof Platform.OS = Platform.OS): boolean {
  return checkAppleSignInAvailable(platform as SocialPlatform);
}
