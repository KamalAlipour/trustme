import { describe, expect, it } from 'vitest';
import { usesNativeBiometrics } from './setup-capabilities';

describe('security setup platform behavior', () => {
  it('uses the PIN-plus-email fallback in browsers', () => {
    expect(usesNativeBiometrics('web')).toBe(false);
  });

  it('uses local biometrics on native platforms', () => {
    expect(usesNativeBiometrics('ios')).toBe(true);
    expect(usesNativeBiometrics('android')).toBe(true);
  });
});
