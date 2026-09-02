import { describe, expect, it } from 'vitest';
import { decodeUtf8, encodeUtf8 } from './utf8';

describe('UTF-8 helpers', () => {
  it.each(['Trust Coupon', 'سلام', 'Trust Coupon 🪙'])('matches the platform UTF-8 implementation for %s', (value) => {
    const expectedBytes = new TextEncoder().encode(value);
    const encoded = encodeUtf8(value);
    expect(Array.from(encoded)).toEqual(Array.from(expectedBytes));
    expect(decodeUtf8(encoded)).toBe(new TextDecoder().decode(expectedBytes));
  });
});
