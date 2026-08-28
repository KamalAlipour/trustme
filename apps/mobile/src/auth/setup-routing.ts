import type { SecuritySetup } from '../api/types';

export type SetupRoute = 'verify-email' | 'security-setup' | 'tabs';

export function getSetupRoute(setup: SecuritySetup): SetupRoute {
  if (setup.remaining.includes('email_verification')) return 'verify-email';
  if (setup.remaining.includes('biometric_enrolment')) return 'security-setup';
  return 'tabs';
}
