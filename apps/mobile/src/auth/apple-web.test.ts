import { describe, expect, it } from 'vitest';
import { buildAppleAuthorizeUrl, isAppleWebSignInAvailable } from './apple-web';

describe('Apple web sign-in', () => {
  it('is available only for web with a non-empty Services ID', () => {
    expect(isAppleWebSignInAvailable('web', 'com.example.web')).toBe(true);
    expect(isAppleWebSignInAvailable('web', '   ')).toBe(false);
    expect(isAppleWebSignInAvailable('ios', 'com.example.web')).toBe(false);
    expect(isAppleWebSignInAvailable('web', undefined)).toBe(false);
  });

  it('builds the fragment-mode Apple authorization URL', () => {
    const url = buildAppleAuthorizeUrl({
      clientId: 'com.example.web',
      redirectUri: 'https://app.example.test/',
      state: 'apple:random value',
      nonce: 'nonce/value',
    });
    expect(url).toBe(
      'https://appleid.apple.com/auth/authorize?client_id=com.example.web&redirect_uri=https%3A%2F%2Fapp.example.test%2F&response_type=code%20id_token&response_mode=fragment&state=apple%3Arandom%20value&nonce=nonce%2Fvalue',
    );
    const parsed = new URL(url);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      client_id: 'com.example.web',
      redirect_uri: 'https://app.example.test/',
      response_type: 'code id_token',
      response_mode: 'fragment',
      state: 'apple:random value',
      nonce: 'nonce/value',
    });
  });
});
