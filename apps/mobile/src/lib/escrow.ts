import { getRandomBytesAsync } from 'expo-crypto';
import { Mnemonic } from 'ethers';

const MICRO_USDT = 1_000_000n;
const POL_CENT = 10_000_000_000_000_000n;
const MINIMUM_POL = 5n * POL_CENT;

export type WalletConnectAttempt = { done: Promise<void>; cancel: (error: Error) => void };

export function withWalletConnectDeadline(
  connect: () => Promise<unknown>,
  timeoutMs: number,
  timeoutError: () => Error,
): WalletConnectAttempt {
  let cancel: (error: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => { cancel = reject; });
  guard.catch(() => {});
  const timer = setTimeout(() => cancel(timeoutError()), timeoutMs);
  const done = Promise.race([connect().then(() => undefined), guard]).finally(() => clearTimeout(timer));
  return { done, cancel };
}

export function parseUsdtAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^(?:\d+)(?:\.\d{1,6})?$/.test(normalized)) throw new Error('invalid amount');
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole ?? '0') * MICRO_USDT + BigInt(fraction.padEnd(6, '0') || '0');
  if (amount <= 0n) throw new Error('amount must be positive');
  return amount;
}

export function formatEscrowCountdown(expiresAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function shouldApproveAllowance(allowance: bigint, amount: bigint): boolean {
  return allowance < amount;
}

export function estimateRequiredPol(gasUnits: bigint, maxFeePerGas: bigint): bigint {
  if (gasUnits < 0n || maxFeePerGas < 0n) throw new Error('gas values must be non-negative');
  const bufferedWei = (gasUnits * maxFeePerGas * 3n + 1n) / 2n;
  const minimumWei = bufferedWei > MINIMUM_POL ? bufferedWei : MINIMUM_POL;
  return ((minimumWei + POL_CENT - 1n) / POL_CENT) * POL_CENT;
}

export function formatPolAmount(wei: bigint): string {
  const cents = wei / POL_CENT;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export function pickVerificationWordIndices(wordCount: number, randomBytes: Uint8Array): [number, number] {
  if (wordCount < 2 || randomBytes.length < 2) throw new Error('secure randomness unavailable');
  const first = randomBytes[0]! % wordCount;
  let second = randomBytes[1]! % wordCount;
  if (second === first) second = (second + 1) % wordCount;
  return first < second ? [first, second] : [second, first];
}

export async function randomVerificationWordIndices(wordCount: number): Promise<[number, number]> {
  return pickVerificationWordIndices(wordCount, await getRandomBytesAsync(2));
}

export function verifyMnemonicWords(words: string[], indices: [number, number], answers: [string, string]): boolean {
  return indices.every((index, position) => words[index]?.toLowerCase() === answers[position]?.trim().toLowerCase());
}

export function normalizeRecoveryPhrase(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function isValidRecoveryPhrase(value: string): boolean {
  return Mnemonic.isValidMnemonic(normalizeRecoveryPhrase(value));
}

export function parseRecoveryPhrase(value: string): string {
  const phrase = normalizeRecoveryPhrase(value);
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('invalid recovery phrase');
  return phrase;
}
