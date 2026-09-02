import { describe, expect, it } from 'vitest';
import { parseIdentityRequiredCountries, requireIdentityForSpending } from '../src/identity-required-countries.js';

describe('identity-required countries', () => {
  it('normalizes, filters, and deduplicates configured country codes', () => {
    expect([...parseIdentityRequiredCountries(' ir, NO, ir, GB ')]).toEqual(['IR', 'NO', 'GB']);
    expect([...parseIdentityRequiredCountries('USA, 1A, , lowercase!')]).toEqual([]);
    expect([...parseIdentityRequiredCountries(undefined)]).toEqual([]);
  });

  it('gates only unverified members in configured countries', () => {
    const required = new Set(['IR']);
    expect(() => requireIdentityForSpending('IR', 'UNVERIFIED', required)).toThrowError(
      expect.objectContaining({ status: 403, message: 'identity_verification_required' }),
    );
    expect(() => requireIdentityForSpending('IR', 'VERIFIED', required)).not.toThrow();
    expect(() => requireIdentityForSpending('NO', 'UNVERIFIED', required)).not.toThrow();
    expect(() => requireIdentityForSpending(null, 'UNVERIFIED', required)).not.toThrow();
  });
});
