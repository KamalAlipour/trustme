import { describe, expect, it } from 'vitest';
import { getSetupRoute } from './setup-routing';

const setup = (remaining: Array<'email_verification' | 'biometric_enrolment'>) => ({
  emailVerified: !remaining.includes('email_verification'),
  biometricEnrolled: !remaining.includes('biometric_enrolment'),
  requiresEmailVerification: remaining.includes('email_verification'),
  remaining,
  completedAt: remaining.length === 0 ? new Date().toISOString() : null,
});

describe('security setup routing', () => {
  it('follows the server-required email step first', () => {
    expect(getSetupRoute(setup(['email_verification', 'biometric_enrolment']))).toBe('verify-email');
  });

  it('routes to biometric setup when email is complete', () => {
    expect(getSetupRoute(setup(['biometric_enrolment']))).toBe('security-setup');
  });

  it('opens the app only after setup is complete', () => {
    expect(getSetupRoute(setup([]))).toBe('tabs');
  });
});
