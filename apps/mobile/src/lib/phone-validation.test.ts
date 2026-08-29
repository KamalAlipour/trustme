import { describe, expect, it } from 'vitest';
import { isPlausiblePhoneNumber } from './phone-validation';

describe('phone number validation', () => {
  it('accepts plausible international and Iranian numbers', () => {
    expect(isPlausiblePhoneNumber('+1555000008')).toBe(true);
    expect(isPlausiblePhoneNumber('09000000001')).toBe(true);
    expect(isPlausiblePhoneNumber(' +1555000008 ')).toBe(true);
  });

  it('rejects incomplete and malformed numbers', () => {
    expect(isPlausiblePhoneNumber('')).toBe(false);
    expect(isPlausiblePhoneNumber('12345')).toBe(false);
    expect(isPlausiblePhoneNumber('phone-number')).toBe(false);
  });
});
