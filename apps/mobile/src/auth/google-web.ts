import type { Platform } from 'react-native';

export const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined;
export const googleWebStateKey = 'trustme.googleWebState';

export function isGoogleWebSignInAvailable(platform: typeof Platform['OS'], clientId: string | undefined): boolean {
  return platform === 'web' && typeof clientId === 'string' && clientId.trim().length > 0;
}

export function buildGoogleAuthorizeUrl({
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
    ['response_type', 'id_token'],
    ['scope', 'openid email profile'],
    ['prompt', 'select_account'],
    ['nonce', nonce],
    ['state', state],
  ];
  return `https://accounts.google.com/o/oauth2/v2/auth?${parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}
