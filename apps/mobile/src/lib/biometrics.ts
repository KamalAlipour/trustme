import * as LocalAuthentication from 'expo-local-authentication';
import { readPin, readRefreshToken } from './storage';

let availability: boolean | undefined;

export async function biometricAvailable(): Promise<boolean> {
  if (availability !== undefined) return availability;
  const [hardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  availability = hardware && enrolled;
  return availability;
}

export function resetBiometricAvailability(): void {
  availability = undefined;
}

export async function authenticateLocally(): Promise<boolean> {
  if (!await biometricAvailable()) return false;
  const result = await LocalAuthentication.authenticateAsync({ disableDeviceFallback: false });
  return result.success;
}

export async function unlockRefreshToken(): Promise<string | null> {
  if (!await authenticateLocally()) return null;
  return readRefreshToken();
}

export async function unlockPin(): Promise<string | null> {
  if (!await authenticateLocally()) return null;
  return readPin();
}
