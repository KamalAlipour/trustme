import * as SecureStore from 'expo-secure-store';
import { isWebPlatform } from './platform';

const REFRESH_TOKEN_KEY = 'trustcoupon.refreshToken';
const PIN_KEY = 'trustcoupon.pin';
const SESSION_MARKER_KEY = 'trustcoupon.session';
const MANIFESTO_SEEN_KEY = 'trustcoupon.manifestoSeen';
const LANGUAGE_KEY = 'trustcoupon.language';
const INSTALLATION_ID_KEY = 'trustcoupon.installationId';
const options = { requireAuthentication: true, keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let webRefreshToken: string | null = null;
let webPin: string | null = null;
let webSessionMarker = false;
let fallbackInstallationId: string | null = null;

function generateInstallationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readManifestoFlag(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(MANIFESTO_SEEN_KEY);
  } catch {
    return null;
  }
}

export async function saveCredentials(refreshToken: string, pin: string): Promise<void> {
  if (isWebPlatform()) {
    webRefreshToken = refreshToken;
    webPin = pin;
    webSessionMarker = true;
    return;
  }
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options);
  await SecureStore.setItemAsync(PIN_KEY, pin, options);
  await SecureStore.setItemAsync(SESSION_MARKER_KEY, '1');
}

export async function saveCredentialsWithoutPin(refreshToken: string): Promise<void> {
  if (isWebPlatform()) {
    webRefreshToken = refreshToken;
    webSessionMarker = true;
    return;
  }
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options);
  await SecureStore.setItemAsync(SESSION_MARKER_KEY, '1');
}

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  if (isWebPlatform()) {
    webRefreshToken = refreshToken;
    return;
  }
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options);
}

export async function savePin(pin: string): Promise<void> {
  if (isWebPlatform()) {
    webPin = pin;
    return;
  }
  await SecureStore.setItemAsync(PIN_KEY, pin, options);
}

export async function readRefreshToken(): Promise<string | null> {
  if (isWebPlatform()) return webRefreshToken;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, options);
}

export async function readPin(): Promise<string | null> {
  const pin = isWebPlatform() ? webPin : await SecureStore.getItemAsync(PIN_KEY, options);
  return pin === '' ? null : pin;
}

export async function readInstallationId(): Promise<string> {
  if (isWebPlatform()) {
    try {
      if (typeof window === 'undefined') throw new Error('localStorage unavailable');
      const stored = window.localStorage.getItem(INSTALLATION_ID_KEY);
      if (stored !== null) return stored;
      const generated = generateInstallationId();
      window.localStorage.setItem(INSTALLATION_ID_KEY, generated);
      return generated;
    } catch {
      fallbackInstallationId ??= generateInstallationId();
      return fallbackInstallationId;
    }
  }
  const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
  if (stored !== null) return stored;
  const generated = generateInstallationId();
  await SecureStore.setItemAsync(INSTALLATION_ID_KEY, generated);
  return generated;
}

export async function clearCredentials(): Promise<void> {
  if (isWebPlatform()) {
    webRefreshToken = null;
    webPin = null;
    webSessionMarker = false;
    return;
  }
  await Promise.all([
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(PIN_KEY),
    SecureStore.deleteItemAsync(SESSION_MARKER_KEY),
  ]);
}

export async function hasStoredCredentials(): Promise<boolean> {
  if (isWebPlatform()) return webSessionMarker;
  return (await SecureStore.getItemAsync(SESSION_MARKER_KEY)) !== null;
}

export async function hasSeenManifesto(): Promise<boolean> {
  if (isWebPlatform()) return readManifestoFlag() === '1';
  return (await SecureStore.getItemAsync(MANIFESTO_SEEN_KEY)) === '1';
}

export async function markManifestoSeen(): Promise<void> {
  if (isWebPlatform()) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(MANIFESTO_SEEN_KEY, '1');
    } catch {
      return;
    }
    return;
  }
  await SecureStore.setItemAsync(MANIFESTO_SEEN_KEY, '1');
}

export type Language = 'en' | 'fa';

export async function readLanguage(): Promise<Language> {
  try {
    const value = isWebPlatform()
      ? (typeof window === 'undefined' ? null : window.localStorage.getItem(LANGUAGE_KEY))
      : await SecureStore.getItemAsync(LANGUAGE_KEY);
    return value === 'fa' ? 'fa' : 'en';
  } catch {
    return 'en';
  }
}

export async function saveLanguage(language: Language): Promise<void> {
  try {
    if (isWebPlatform()) {
      if (typeof window !== 'undefined') window.localStorage.setItem(LANGUAGE_KEY, language);
      return;
    }
    await SecureStore.setItemAsync(LANGUAGE_KEY, language);
  } catch {
    return;
  }
}
