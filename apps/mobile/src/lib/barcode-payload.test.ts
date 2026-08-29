import { describe, expect, it } from 'vitest';
import { getBarcodeQrValue } from './barcode-payload';

describe('barcode QR payload', () => {
  it('uses the bare barcode ID so scanner routing can consume it', () => {
    expect(getBarcodeQrValue('TC-123456')).toBe('TC-123456');
  });
});
