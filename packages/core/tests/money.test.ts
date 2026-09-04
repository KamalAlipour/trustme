import { describe, expect, it } from 'vitest';
import { couponAmountFromMicroUsdt, microUsdtFromCouponAmount } from '../src/index.js';

describe('decimal coupon amounts', () => {
  it('converts coupon amounts to exact micro-USDT', () => {
    expect(microUsdtFromCouponAmount('1')).toBe(10_000n);
    expect(microUsdtFromCouponAmount('0.5')).toBe(5_000n);
    expect(microUsdtFromCouponAmount('12.3456')).toBe(123_456n);
  });

  it('rejects invalid or non-positive coupon amounts', () => {
    for (const value of ['0.00001', '0', '-1', '1.2.3']) {
      expect(() => microUsdtFromCouponAmount(value)).toThrow();
    }
  });

  it('formats micro-USDT coupon amounts and round-trips them', () => {
    expect(couponAmountFromMicroUsdt(125_000n)).toBe('12.5');
    expect(couponAmountFromMicroUsdt(1_000_000n)).toBe('100');
    for (const value of ['1', '0.5', '12.3456']) {
      expect(couponAmountFromMicroUsdt(microUsdtFromCouponAmount(value))).toBe(value);
    }
  });
});
