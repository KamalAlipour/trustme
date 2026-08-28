import { describe, expect, it } from 'vitest';
import { isWeakPin } from './pin';
import { formatCoupons } from './format';

describe('PIN and coupon helpers', () => {
  it.each(['0000', '1111', '0123', '1234', '3210', '4321'])('rejects weak PIN %s', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
  });

  it.each(['2580', '9072', '2468'])('accepts strong PIN %s', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });

  it('formats coupons without converting through Number', () => {
    const value = '900719925474099312345678901';
    const formatted = formatCoupons(value, 'fa');
    expect(formatted).toBe('۹۰۰,۷۱۹,۹۲۵,۴۷۴,۰۹۹,۳۱۲,۳۴۵,۶۷۸,۹۰۱');
    expect(formatted).not.toContain('9007199254740992');
  });
});
