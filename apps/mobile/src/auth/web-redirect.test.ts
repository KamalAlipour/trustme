import { describe, expect, it } from 'vitest';
import {
  getWebRedirectHandlingMode,
  readIdTokenFromUrl,
  readSocialCallbackFromUrl,
  readSocialCallbackStateFromUrl,
  validateWebRedirectState,
} from './web-redirect';
import { googleWebStateKey } from './google-web';

describe('web OAuth redirect parsing', () => {
  it('handles callbacks immediately without an opener', () => {
    expect(getWebRedirectHandlingMode(true, false)).toBe('immediate');
  });

  it('defers callbacks with an opener for popup liveness', () => {
    expect(getWebRedirectHandlingMode(true, true)).toBe('deferred');
  });

  it('does not handle URLs without a callback', () => {
    expect(getWebRedirectHandlingMode(false, false)).toBeNull();
    expect(getWebRedirectHandlingMode(false, true)).toBeNull();
  });

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

  it('identifies a Google callback from its state prefix', () => {
    const url = 'https://app.example.test/#id_token=google-token&state=google%3Arandom';
    expect(readSocialCallbackFromUrl(url)).toEqual({ provider: 'google', idToken: 'google-token' });
    expect(readSocialCallbackStateFromUrl(url)).toBe('google:random');
  });

  it('validates and consumes the Google web state', () => {
    const storage = {
      getItem: (key: string) => key === googleWebStateKey ? 'google:random' : null,
      removeItem: (key: string) => {
        expect(key).toBe(googleWebStateKey);
      },
    };
    expect(validateWebRedirectState('google', 'google:random', storage)).toBe(true);
  });

  it('rejects a mismatched Google web state and still consumes it', () => {
    const removed: string[] = [];
    const storage = {
      getItem: () => 'google:expected',
      removeItem: (key: string) => {
        removed.push(key);
      },
    };
    expect(validateWebRedirectState('google', 'google:actual', storage)).toBe(false);
    expect(removed).toEqual([googleWebStateKey]);
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
