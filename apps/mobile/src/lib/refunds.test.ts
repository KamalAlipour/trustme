import { describe, expect, it } from 'vitest';
import { canRequestRefund } from './refunds';

const base = {
  id: 'entry',
  transactionId: 'transaction',
  refundableTransactionId: 'release',
  direction: 'out' as const,
  amountCoupons: '10',
  counterparty: {},
  refund: null,
  transaction: { type: 'ESCROW_RELEASE', status: 'POSTED', createdAt: '2025-01-01T00:00:00Z' },
};

describe('refund row action', () => {
  it('allows only outgoing rows with a refundable transaction and no pending request', () => {
    expect(canRequestRefund(base)).toBe(true);
    expect(canRequestRefund({ ...base, direction: 'in' })).toBe(false);
    expect(canRequestRefund({ ...base, refundableTransactionId: null })).toBe(false);
    expect(canRequestRefund({ ...base, refund: { id: 'refund', status: 'PENDING', amountCoupons: '10' } })).toBe(false);
  });
});
