import { HttpError } from './http-error.js';

export function parseIdentityRequiredCountries(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((country) => country.trim().toUpperCase())
      .filter((country) => /^[A-Z]{2}$/.test(country)),
  );
}

export function requireIdentityForSpending(
  country: string | null,
  identityVerificationStatus: string,
  requiredCountries: Set<string>,
): void {
  if (country !== null && requiredCountries.has(country) && identityVerificationStatus !== 'VERIFIED') {
    throw new HttpError(403, 'identity_verification_required');
  }
}
