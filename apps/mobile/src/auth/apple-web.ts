import type { Platform } from 'react-native';

export const appleWebClientId = process.env.EXPO_PUBLIC_APPLE_WEB_CLIENT_ID || undefined;
export const appleWebStateKey = 'trustme.appleWebState';

export function isAppleWebSignInAvailable(platform: typeof Platform['OS'], clientId: string | undefined): boolean {
  return platform === 'web' && typeof clientId === 'string' && clientId.trim().length > 0;
}

export function buildAppleAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  nonce,
}: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  const parameters: Array<[string, string]> = [
    ['client_id', clientId],
    ['redirect_uri', redirectUri],
    ['response_type', 'code id_token'],
    ['response_mode', 'fragment'],
    ['state', state],
    ['nonce', nonce],
  ];
  return `https://appleid.apple.com/auth/authorize?${parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}
