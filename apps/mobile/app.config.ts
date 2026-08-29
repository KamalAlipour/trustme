import type { ExpoConfig } from 'expo/config';
import baseConfig from './app.json';

function googleReversedClientId(clientId: string | undefined): string | undefined {
  const suffix = '.apps.googleusercontent.com';
  if (clientId === undefined || !clientId.endsWith(suffix)) return undefined;
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || undefined;
const googleScheme = googleReversedClientId(iosClientId);
const plugins = [...(baseConfig.expo.plugins ?? [])];
if (!plugins.includes('expo-apple-authentication')) plugins.push('expo-apple-authentication');
const existingUrlTypes = baseConfig.expo.ios?.infoPlist?.CFBundleURLTypes;
const urlTypes = Array.isArray(existingUrlTypes) ? existingUrlTypes : [];

const config: ExpoConfig = {
  ...baseConfig.expo,
  plugins,
  ios: {
    ...baseConfig.expo.ios,
    ...(googleScheme === undefined ? {} : {
      infoPlist: {
        ...baseConfig.expo.ios?.infoPlist,
        CFBundleURLTypes: [...urlTypes, { CFBundleURLSchemes: [googleScheme] }],
      },
    }),
  },
  extra: {
    ...baseConfig.expo.extra,
    googleOAuth: {
      webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || null,
      iosClientId: iosClientId ?? null,
      androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || null,
    },
  },
};

export default config;
