import { describe, expect, it } from 'vitest';
import { identityPolicyFor } from '../src/index.js';

describe('identity policy derivation', () => {
  it('uses manual with no provider for unknown countries', () => {
    expect(identityPolicyFor('XX', { shahkar: true })).toMatchObject({ country: 'XX', mode: 'MANUAL', provider: null, plannedProviderLabel: null });
  });
  it('uses manual and names planned providers', () => {
    expect(identityPolicyFor('NO', { shahkar: true })).toMatchObject({ mode: 'MANUAL', provider: null, plannedProviderLabel: 'BankID' });
  });
  it('falls back to manual when the implemented provider is unavailable', () => {
    expect(identityPolicyFor('IR', { shahkar: false })).toMatchObject({ mode: 'MANUAL', provider: null, plannedProviderLabel: 'Shahkar' });
  });
  it('uses the automated implemented provider when access exists', () => {
    expect(identityPolicyFor('IR', { shahkar: true })).toMatchObject({ mode: 'AUTOMATED', provider: 'SHAHKAR', providerLabel: 'Shahkar', plannedProviderLabel: null });
  });
});
