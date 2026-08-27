import { describe, expect, it } from 'vitest';
import { canRequestRefund, refundableRemainder } from './refunds';

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

  it('allows another request after a partial approved refund', () => {
    const transaction = { ...base, refund: { id: 'refund', status: 'APPROVED', amountCoupons: '4' } };
    expect(refundableRemainder(transaction)).toBe('6');
    expect(canRequestRefund(transaction)).toBe(true);
  });

  it('allows another request after a partial rejected refund', () => {
    const transaction = { ...base, refund: { id: 'refund', status: 'REJECTED', amountCoupons: '4' } };
    expect(refundableRemainder(transaction)).toBe('6');
    expect(canRequestRefund(transaction)).toBe(true);
  });

  it('does not allow another request after the purchase is fully refunded', () => {
    const transaction = { ...base, refund: { id: 'refund', status: 'APPROVED', amountCoupons: '10' } };
    expect(refundableRemainder(transaction)).toBe('0');
    expect(canRequestRefund(transaction)).toBe(false);
  });
});
