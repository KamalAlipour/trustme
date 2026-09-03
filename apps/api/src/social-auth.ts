import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from './http-error.js';

export type SocialProvider = 'GOOGLE' | 'APPLE';
export type VerifiedSocialClaims = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
};
export type MemberIdTokenVerifier = (idToken: string, audiences: readonly string[]) => Promise<VerifiedSocialClaims>;

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

function hasAudience(claims: JWTPayload, audiences: readonly string[]): boolean {
  const claim = claims.aud;
  return (typeof claim === 'string' && audiences.includes(claim)) ||
    (Array.isArray(claim) && claim.some((value) => typeof value === 'string' && audiences.includes(value)));
}

function normalizedEmail(claims: JWTPayload): string | null {
  return typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
}

export function validateGoogleClaims(claims: JWTPayload, audiences: readonly string[]): VerifiedSocialClaims {
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new HttpError(401, 'invalid Google identity token');
  if (!hasAudience(claims, audiences)) throw new HttpError(401, 'invalid Google identity token');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new HttpError(401, 'invalid Google identity token');
  if (claims.email !== undefined && claims.email_verified !== true) throw new HttpError(401, 'invalid Google identity token');
  return { subject: claims.sub, email: normalizedEmail(claims), emailVerified: claims.email !== undefined && claims.email_verified === true };
}

export function validateAppleClaims(claims: JWTPayload, audiences: readonly string[]): VerifiedSocialClaims {
  if (claims.iss !== 'https://appleid.apple.com') throw new HttpError(401, 'invalid Apple identity token');
  if (!hasAudience(claims, audiences)) throw new HttpError(401, 'invalid Apple identity token');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new HttpError(401, 'invalid Apple identity token');
  return { subject: claims.sub, email: normalizedEmail(claims), emailVerified: claims.email !== undefined && (claims.email_verified === true || claims.email_verified === 'true') };
}

export async function verifyGoogleIdToken(idToken: string, audiences: readonly string[]): Promise<VerifiedSocialClaims> {
  try {
    const result = await jwtVerify(idToken, googleJwks as unknown as Parameters<typeof jwtVerify>[1], {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: [...audiences],
    });
    return validateGoogleClaims(result.payload, audiences);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'invalid Google identity token');
  }
}

export async function verifyAppleIdToken(idToken: string, audiences: readonly string[]): Promise<VerifiedSocialClaims> {
  try {
    const result = await jwtVerify(idToken, appleJwks as unknown as Parameters<typeof jwtVerify>[1], {
      issuer: 'https://appleid.apple.com',
      audience: [...audiences],
    });
    return validateAppleClaims(result.payload, audiences);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'invalid Apple identity token');
  }
}
