import { describe, expect, it } from 'vitest';
import { kycStatusLabel } from './kyc-status';

const labels = {
  kycUnverified: 'Not verified',
  kycPending: 'Under review',
  kycVerified: 'Verified',
  kycRejected: 'Rejected',
};

describe('kycStatusLabel', () => {
  it('maps known statuses and preserves unknown values', () => {
    expect(kycStatusLabel('UNVERIFIED', labels)).toBe('Not verified');
    expect(kycStatusLabel('PENDING', labels)).toBe('Under review');
    expect(kycStatusLabel('VERIFIED', labels)).toBe('Verified');
    expect(kycStatusLabel('REJECTED', labels)).toBe('Rejected');
    expect(kycStatusLabel('FUTURE_STATUS', labels)).toBe('FUTURE_STATUS');
  });
});
