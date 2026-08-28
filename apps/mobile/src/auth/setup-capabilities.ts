export function usesNativeBiometrics(platform: string): boolean {
  return platform !== 'web';
}

export function shouldEnrollBiometrics(platform: string, available: boolean): boolean {
  return usesNativeBiometrics(platform) && available;
}
