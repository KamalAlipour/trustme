import { describe, expect, it } from 'vitest';
import { validateAppleClaims, validateGoogleClaims } from '../src/social-auth.js';

describe('social identity claim validation', () => {
  it('accepts Google claims with a configured audience and verified email', () => {
    expect(validateGoogleClaims({
      iss: 'https://accounts.google.com',
      aud: 'google-client',
      sub: 'google-subject',
      email: 'Member@Example.com',
      email_verified: true,
    }, ['google-client'])).toEqual({ subject: 'google-subject', email: 'member@example.com' });
  });

  it('accepts the alternate Google issuer and audience arrays', () => {
    expect(validateGoogleClaims({
      iss: 'accounts.google.com',
      aud: ['other-client', 'google-client'],
      sub: 'google-subject',
    }, ['google-client'])).toEqual({ subject: 'google-subject', email: null });
  });

  it('rejects wrong issuers, unknown audiences, and missing subjects', () => {
    expect(() => validateGoogleClaims({ iss: 'https://issuer.invalid', aud: 'google-client', sub: 'subject' }, ['google-client'])).toThrow();
    expect(() => validateGoogleClaims({ iss: 'accounts.google.com', aud: 'unknown', sub: 'subject' }, ['google-client'])).toThrow();
    expect(() => validateGoogleClaims({ iss: 'accounts.google.com', aud: 'google-client' }, ['google-client'])).toThrow();
  });

  it('requires Google email verification whenever an email is present', () => {
    expect(() => validateGoogleClaims({ iss: 'accounts.google.com', aud: 'google-client', sub: 'subject', email: 'a@example.com', email_verified: false }, ['google-client'])).toThrow();
    expect(() => validateGoogleClaims({ iss: 'accounts.google.com', aud: 'google-client', sub: 'subject', email: 'a@example.com' }, ['google-client'])).toThrow();
  });

  it('allows Apple claims without an email', () => {
    expect(validateAppleClaims({ iss: 'https://appleid.apple.com', aud: 'as.komasi.trustcoupon', sub: 'apple-subject' }, ['as.komasi.trustcoupon'])).toEqual({ subject: 'apple-subject', email: null });
  });

  it('validates Apple issuer and audience', () => {
    expect(() => validateAppleClaims({ iss: 'accounts.google.com', aud: 'as.komasi.trustcoupon', sub: 'subject' }, ['as.komasi.trustcoupon'])).toThrow();
    expect(() => validateAppleClaims({ iss: 'https://appleid.apple.com', aud: 'unknown', sub: 'subject' }, ['as.komasi.trustcoupon'])).toThrow();
  });
});
