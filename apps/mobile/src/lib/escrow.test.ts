import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn() }));
import { formatEscrowCountdown, parseUsdtAmount, pickVerificationWordIndices, shouldApproveAllowance, verifyMnemonicWords } from './escrow';

describe('escrow helpers', () => {
  it('parses decimal USDT without floating point arithmetic', () => {
    expect(parseUsdtAmount('1.25')).toBe(1_250_000n);
    expect(() => parseUsdtAmount('1.1234567')).toThrow();
    expect(() => parseUsdtAmount('0')).toThrow();
  });
  it('formats payment-code countdowns', () => {
    expect(formatEscrowCountdown(new Date(120_000).toISOString(), 0)).toBe('2:00');
    expect(formatEscrowCountdown(new Date(0).toISOString(), 120_000)).toBe('0:00');
  });
  it('decides when an approval is required', () => {
    expect(shouldApproveAllowance(1n, 2n)).toBe(true);
    expect(shouldApproveAllowance(2n, 2n)).toBe(false);
  });
  it('selects two different mnemonic words and verifies them', () => {
    const indices = pickVerificationWordIndices(12, new Uint8Array([2, 2]));
    expect(indices).toEqual([2, 3]);
    expect(verifyMnemonicWords('one two three four'.split(' '), [0, 2], ['ONE', 'three'])).toBe(true);
    expect(verifyMnemonicWords('one two three four'.split(' '), [0, 2], ['one', 'wrong'])).toBe(false);
  });
});
