import { describe, expect, it } from 'vitest';
import { greaterThan, nextInstallmentAmount } from './coupons';

describe('coupon arithmetic', () => {
  it('compares decimal strings with BigInt beyond the safe integer range', () => {
    expect(greaterThan('900719925474099312345678901', '900719925474099312345678900')).toBe(true);
    expect(greaterThan('900719925474099312345678900', '900719925474099312345678901')).toBe(false);
  });

  it('returns the remaining amount of the next partially paid installment', () => {
    expect(nextInstallmentAmount({
      outstandingCoupons: '900719925474099312345678901',
      installments: [
        { amountCoupons: '10', paidCoupons: '10' },
        { amountCoupons: '900719925474099312345678901', paidCoupons: '900719925474099312345678000' },
      ],
    })).toBe('901');
  });

  it('rejects non-numeric coupon values', () => {
    expect(() => greaterThan('10x', '1')).toThrow('invalid coupon amount');
  });
});
