import { describe, expect, it } from 'vitest';
import { buildGoogleAuthorizeUrl, isGoogleWebSignInAvailable } from './google-web';

describe('Google web sign-in', () => {
  it('is available only for web with a non-empty web client ID', () => {
    expect(isGoogleWebSignInAvailable('web', 'client.apps.googleusercontent.com')).toBe(true);
    expect(isGoogleWebSignInAvailable('web', '   ')).toBe(false);
    expect(isGoogleWebSignInAvailable('android', 'client.apps.googleusercontent.com')).toBe(false);
    expect(isGoogleWebSignInAvailable('web', undefined)).toBe(false);
  });

  it('builds the implicit ID-token authorization URL', () => {
    const url = buildGoogleAuthorizeUrl({
      clientId: 'client.apps.googleusercontent.com',
      redirectUri: 'https://app.example.test',
      state: 'google:random value',
      nonce: 'nonce/value',
    });
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      client_id: 'client.apps.googleusercontent.com',
      redirect_uri: 'https://app.example.test',
      response_type: 'id_token',
      scope: 'openid email profile',
      prompt: 'select_account',
      nonce: 'nonce/value',
      state: 'google:random value',
    });
    expect(url).toContain('state=google%3Arandom%20value');
  });
});
