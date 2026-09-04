import { describe, expect, it } from 'vitest';
import { generateBarcodeId, ibanSchema, iranMobileSchema, jalaliBirthDateSchema, nationalCodeSchema } from '../src/index.js';

describe('barcode IDs', () => {
  it('generates cryptographically random Crockford IDs in the documented format', () => {
    const values = Array.from({ length: 200 }, () => generateBarcodeId());
    expect(values.every((value) => /^TC[0-9ABCDEFGHJKMNPQRSTVWXYZ]{14}$/.test(value))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    expect(values.join('')).not.toMatch(/[ILOU]/);
  });
});

function nationalCodeWithChecksum(firstNine: string): string {
  const sum = firstNine.split('').reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  return `${firstNine}${remainder < 2 ? remainder : 11 - remainder}`;
}

describe('identity schemas', () => {
  it('validates Iranian national-code checksums and rejects repeated digits', () => {
    const valid = nationalCodeWithChecksum('314159265');
    expect(nationalCodeSchema.parse(valid)).toBe(valid);
    expect(nationalCodeSchema.safeParse('3141592651').success).toBe(false);
    expect(nationalCodeSchema.safeParse('1111111111').success).toBe(false);
    expect(nationalCodeSchema.safeParse('123456789').success).toBe(false);
    expect(nationalCodeSchema.safeParse('abcdefghij').success).toBe(false);
  });

  it('normalizes supported Iranian mobile formats', () => {
    const canonical = '09123456789';
    expect(iranMobileSchema.parse(canonical)).toBe(canonical);
    expect(iranMobileSchema.parse('+989123456789')).toBe(canonical);
    expect(iranMobileSchema.parse('00989123456789')).toBe(canonical);
    expect(iranMobileSchema.parse('989123456789')).toBe(canonical);
    expect(iranMobileSchema.safeParse('0912345678').success).toBe(false);
  });

  it('normalizes and validates Iranian IBANs', () => {
    expect(ibanSchema.parse(' ir12 3456-7890 1234 5678 9012 34 ')).toBe('IR123456789012345678901234');
    expect(ibanSchema.safeParse('IR123').success).toBe(false);
    expect(ibanSchema.safeParse('XX123456789012345678901234').success).toBe(false);
  });

  it('normalizes Persian digits and separators in Jalali birth dates', () => {
    expect(jalaliBirthDateSchema.parse('۱۳۷۸/۰۱/۱۲')).toBe('1378/01/12');
    expect(jalaliBirthDateSchema.parse('1400-1-2')).toBe('1400/1/2');
    expect(jalaliBirthDateSchema.safeParse('1399/13/01').success).toBe(false);
  });
});
