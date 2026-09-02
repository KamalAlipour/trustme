import * as SecureStore from 'expo-secure-store';
import { getRandomValues } from 'expo-crypto';
import { Wallet, type HDNodeWallet } from 'ethers';
import { isWebPlatform } from './platform';

export const ESCROW_MNEMONIC_KEY = 'trustcoupon.escrowMnemonic';
const options = { requireAuthentication: true, keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let webEscrowMnemonic: string | null = null;

function ensureCryptoRandomness(): void {
  const runtime = globalThis as typeof globalThis & { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } };
  if (runtime.crypto?.getRandomValues !== undefined) return;
  Object.defineProperty(runtime, 'crypto', { configurable: true, value: { getRandomValues } });
}

export function createInAppWallet(): HDNodeWallet {
  ensureCryptoRandomness();
  return Wallet.createRandom();
}

export async function saveEscrowMnemonic(mnemonic: string): Promise<void> {
  if (isWebPlatform()) {
    webEscrowMnemonic = mnemonic;
    return;
  }
  await SecureStore.setItemAsync(ESCROW_MNEMONIC_KEY, mnemonic, options);
}

export async function readEscrowMnemonic(): Promise<string | null> {
  if (isWebPlatform()) return webEscrowMnemonic;
  return SecureStore.getItemAsync(ESCROW_MNEMONIC_KEY, options);
}

export async function clearEscrowMnemonic(): Promise<void> {
  if (isWebPlatform()) {
    webEscrowMnemonic = null;
    return;
  }
  await SecureStore.deleteItemAsync(ESCROW_MNEMONIC_KEY);
}
