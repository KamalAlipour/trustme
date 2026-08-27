import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'trustcoupon.refreshToken';
const PIN_KEY = 'trustcoupon.pin';
const SESSION_MARKER_KEY = 'trustcoupon.session';
const MANIFESTO_SEEN_KEY = 'trustcoupon.manifestoSeen';
const options = { requireAuthentication: true, keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function saveCredentials(refreshToken: string, pin: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options);
  await SecureStore.setItemAsync(PIN_KEY, pin, options);
  await SecureStore.setItemAsync(SESSION_MARKER_KEY, '1');
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
    SecureStore.deleteItemAsync(SESSION_MARKER_KEY),
  ]);
}

export async function hasStoredCredentials(): Promise<boolean> {
  return (await SecureStore.getItemAsync(SESSION_MARKER_KEY)) !== null;
}

export async function hasSeenManifesto(): Promise<boolean> {
  return (await SecureStore.getItemAsync(MANIFESTO_SEEN_KEY)) === '1';
}

export async function markManifestoSeen(): Promise<void> {
  await SecureStore.setItemAsync(MANIFESTO_SEEN_KEY, '1');
}
