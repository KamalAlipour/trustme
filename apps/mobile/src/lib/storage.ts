import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'trustcoupon.refreshToken';
const PIN_KEY = 'trustcoupon.pin';
const options = { requireAuthentication: true, keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function saveCredentials(refreshToken: string, pin: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options);
  await SecureStore.setItemAsync(PIN_KEY, pin, options);
}

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options);
}

export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, options);
}

export async function readPin(): Promise<string | null> {
  return SecureStore.getItemAsync(PIN_KEY, options);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(PIN_KEY),
  ]);
}

export async function hasStoredCredentials(): Promise<boolean> {
  return (await SecureStore.getItemAsync(REFRESH_TOKEN_KEY)) !== null;
}
