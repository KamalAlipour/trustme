export function usesNativeBiometrics(platform: string): boolean {
  return platform !== 'web';
}
