import { describe, expect, it } from 'vitest';
import { readIdTokenFromUrl, readSocialCallbackFromUrl, readSocialCallbackStateFromUrl } from './web-redirect';

describe('web OAuth redirect parsing', () => {
  it('reads an ID token from the fragment', () => {
    expect(readIdTokenFromUrl('https://app.example.test/#id_token=fragment-token&state=state')).toBe('fragment-token');
  });

  it('reads an ID token from the query string', () => {
    expect(readIdTokenFromUrl('https://app.example.test/?id_token=query-token')).toBe('query-token');
  });

  it('returns null when no ID token is present', () => {
    expect(readIdTokenFromUrl('https://app.example.test/')).toBeNull();
  });

  it('ignores an unrelated fragment', () => {
    expect(readIdTokenFromUrl('https://app.example.test/#welcome')).toBeNull();
  });

  it('identifies an Apple callback from its state prefix', () => {
    const url = 'https://app.example.test/#id_token=apple-token&state=apple%3Arandom';
    expect(readSocialCallbackFromUrl(url)).toEqual({ provider: 'apple', idToken: 'apple-token' });
    expect(readSocialCallbackStateFromUrl(url)).toBe('apple:random');
  });

  it('keeps callbacks without an Apple state as Google', () => {
    const url = 'https://app.example.test/?id_token=google-token&state=oauth-state';
    expect(readSocialCallbackFromUrl(url)).toEqual({ provider: 'google', idToken: 'google-token' });
    expect(readSocialCallbackStateFromUrl(url)).toBe('oauth-state');
  });

  it('keeps callbacks with no state as Google', () => {
    expect(readSocialCallbackFromUrl('https://app.example.test/#id_token=google-token')).toEqual({
      provider: 'google',
      idToken: 'google-token',
    });
    expect(readSocialCallbackStateFromUrl('https://app.example.test/#id_token=google-token')).toBeNull();
  });
});
