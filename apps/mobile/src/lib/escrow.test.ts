import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn() }));
import { formatEscrowCountdown, isValidRecoveryPhrase, parseRecoveryPhrase, parseUsdtAmount, pickVerificationWordIndices, selectBuyerSettlementConfirmation, shouldApproveAllowance, verifyMnemonicWords, withWalletConnectDeadline } from './escrow';

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

  it('validates and normalizes recovery phrases without storing them', async () => {
    const { Mnemonic } = await import('ethers');
    const phrase = Mnemonic.fromEntropy(new Uint8Array(16)).phrase;
    expect(isValidRecoveryPhrase(`  ${phrase}  `)).toBe(true);
    expect(parseRecoveryPhrase(`  ${phrase}  `)).toBe(phrase);
    expect(isValidRecoveryPhrase('not a recovery phrase')).toBe(false);
    expect(() => parseRecoveryPhrase('not a recovery phrase')).toThrow('invalid recovery phrase');
  });

  it('selects an instant buyer confirmation for any non-failed settlement', () => {
    const selected = selectBuyerSettlementConfirmation([
      { id: 'failed', status: 'FAILED', amount: '2', buyerId: 'buyer', merchantId: 'merchant', role: 'BUYER', createdAt: new Date(2_000).toISOString(), confirmedAt: null },
      { id: 'pending', status: 'PENDING_CHAIN', amount: '1', buyerId: 'buyer', merchantId: 'merchant', role: 'BUYER', createdAt: new Date(3_000).toISOString(), confirmedAt: null },
    ], 2_500);
    expect(selected?.id).toBe('pending');
  });
});

describe('wallet connection deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the connection resolves', async () => {
    const attempt = withWalletConnectDeadline(() => Promise.resolve('connected'), 1_000, () => new Error('timed out'));
    await expect(attempt.done).resolves.toBeUndefined();
  });

  it('rejects with the timeout error after the deadline', async () => {
    vi.useFakeTimers();
    const timeoutError = new Error('wallet connection timed out');
    const attempt = withWalletConnectDeadline(() => new Promise(() => {}), 1_000, () => timeoutError);

    const result = expect(attempt.done).rejects.toBe(timeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
  });

  it('rejects with the caller error when cancelled before connecting', async () => {
    let resolveConnection!: () => void;
    const connect = new Promise<void>((resolve) => { resolveConnection = resolve; });
    const attempt = withWalletConnectDeadline(() => connect, 1_000, () => new Error('timed out'));
    const callerError = new Error('wallet connection cancelled');

    const result = expect(attempt.done).rejects.toBe(callerError);
    attempt.cancel(callerError);
    await result;
    resolveConnection();
  });

  it('clears the deadline after a successful connection', async () => {
    vi.useFakeTimers();
    const attempt = withWalletConnectDeadline(() => Promise.resolve(), 1_000, () => new Error('timed out'));

    await expect(attempt.done).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
  });
});
