import { describe, expect, it } from 'vitest';
import { generateBarcodeId } from '../src/index.js';

describe('barcode IDs', () => {
  it('generates cryptographically random Crockford IDs in the documented format', () => {
    const values = Array.from({ length: 200 }, () => generateBarcodeId());
    expect(values.every((value) => /^TC[0-9ABCDEFGHJKMNPQRSTVWXYZ]{14}$/.test(value))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    expect(values.join('')).not.toMatch(/[ILOU]/);
  });
});
