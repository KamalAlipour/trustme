import { describe, expect, it } from 'vitest';
import { payLink } from './links';

describe('app links', () => {
  it('builds a seller payment link from a barcode ID', () => {
    expect(payLink('TC123')).toBe('https://app-trustcoupon.komasi.as/pay?barcodeId=TC123');
  });
});
