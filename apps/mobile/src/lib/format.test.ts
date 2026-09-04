import { describe, expect, it } from 'vitest';
import { formatCouponAmount, formatCoupons, formatDate, formatMicroUsdt } from './format';

describe('localized formatting', () => {
  it('formats coupon amounts with Latin digits in English and Persian digits in Persian', () => {
    const value = '1234567';

    expect(formatCoupons(value, 'en')).toBe('1,234,567');
    expect(formatCoupons(value, 'fa')).toBe('۱,۲۳۴,۵۶۷');
  });

  it('formats decimal coupon amounts without dropping fractional digits', () => {
    expect(formatCouponAmount('1234567.5', 'en')).toBe('1,234,567.5');
    expect(formatCouponAmount('1234567.5', 'fa')).toBe('۱,۲۳۴,۵۶۷.۵');
    expect(() => formatCouponAmount('1.23456', 'en')).toThrow();
  });

  it('formats dates with the Gregorian English locale and Jalali Persian locale', () => {
    const value = '2024-01-15T12:00:00.000Z';

    expect(formatDate(value, 'en')).toBe('Jan 15, 2024');
    expect(formatDate(value, 'fa')).toContain('۱۴۰۲');
    expect(formatDate(value, 'fa')).not.toBe(formatDate(value, 'en'));
  });

  it('formats micro-USDT amounts with Latin or Persian digits', () => {
    const value = '1234567';

    expect(formatMicroUsdt(value, 'en')).toBe('1.234567');
    expect(formatMicroUsdt(value, 'fa')).toBe('۱.۲۳۴۵۶۷');
    expect(formatMicroUsdt('200000', 'en')).toBe('0.2');
    expect(formatMicroUsdt('1800000', 'en')).toBe('1.8');
  });
});
