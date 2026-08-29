import { describe, expect, it } from 'vitest';
import { readIdTokenFromUrl } from './web-redirect';

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
});
