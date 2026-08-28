import { existsSync } from 'node:fs';

export function assertActiveNode(markerPath: string): void {
  if (existsSync(markerPath)) {
    throw new Error(`failover marker exists at ${markerPath}; refusing to start API`);
  }
}

export function assertEmailVerificationDelivery(requireEmailVerification: boolean, emailDelivery: 'none' | 'log' | 'smtp'): void {
  if (requireEmailVerification && emailDelivery === 'none') {
    throw new Error('REQUIRE_EMAIL_VERIFICATION=true conflicts with EMAIL_DELIVERY=none');
  }
}
