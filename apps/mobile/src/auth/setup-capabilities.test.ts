import { describe, expect, it } from 'vitest';
import { shouldEnrollBiometrics, usesNativeBiometrics } from './setup-capabilities';

describe('security setup platform behavior', () => {
  it('uses the PIN-plus-email fallback in browsers', () => {
    expect(usesNativeBiometrics('web')).toBe(false);
  });

  it('uses local biometrics on native platforms', () => {
    expect(usesNativeBiometrics('ios')).toBe(true);
    expect(usesNativeBiometrics('android')).toBe(true);
  });

  it('acknowledges setup when native biometrics are unavailable', () => {
    expect(shouldEnrollBiometrics('ios', false)).toBe(false);
    expect(shouldEnrollBiometrics('android', false)).toBe(false);
  });

  it('never enrolls biometrics in the browser', () => {
    expect(shouldEnrollBiometrics('web', true)).toBe(false);
  });
});
