import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn() }));

import { randomFourDigitCode } from './code';

describe('secure four-digit codes', () => {
  it('rejects the modulo-bias tail and uses accepted bytes', async () => {
    const code = await randomFourDigitCode(async () => new Uint8Array([250, 251, 7, 18, 29, 40, 51]));
    expect(code).toBe('7890');
  });

  it('uses only decimal digits', async () => {
    const code = await randomFourDigitCode(async () => new Uint8Array([1, 2, 3, 4]));
    expect(code).toMatch(/^\d{4}$/);
  });

  it('fails when the secure source cannot provide bytes', async () => {
    await expect(randomFourDigitCode(async () => new Uint8Array())).rejects.toThrow('secure randomness unavailable');
  });
});
