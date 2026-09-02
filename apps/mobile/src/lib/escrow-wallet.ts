import * as SecureStore from 'expo-secure-store';
import { getRandomValues } from 'expo-crypto';
import { Wallet, type HDNodeWallet } from 'ethers';

export const ESCROW_MNEMONIC_KEY = 'trustcoupon.escrowMnemonic';

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
  await SecureStore.setItemAsync(ESCROW_MNEMONIC_KEY, mnemonic, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function readEscrowMnemonic(): Promise<string | null> {
  return SecureStore.getItemAsync(ESCROW_MNEMONIC_KEY, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearEscrowMnemonic(): Promise<void> {
  await SecureStore.deleteItemAsync(ESCROW_MNEMONIC_KEY);
}
