export const IDENTITY_CAPTURE_STEPS = ['DOCUMENT_FRONT', 'SELFIE_NEUTRAL', 'SELFIE_TURNED', 'SELFIE_WITH_DOCUMENT'] as const;
export type IdentityCaptureStep = typeof IDENTITY_CAPTURE_STEPS[number];

export type IdentityCaptureSession = {
  id: string;
  challengeCode: string;
  expiresAt: string;
  steps: IdentityCaptureStep[];
};

export function isIdentityCaptureSessionUnavailable(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { status?: unknown; message?: unknown };
  return candidate.status === 409
    && candidate.message === 'identity capture session is expired or already used';
}

export function hasAllIdentityCaptureSteps(steps: readonly IdentityCaptureStep[]): boolean {
  return IDENTITY_CAPTURE_STEPS.every((step) => steps.includes(step)) && steps.length === IDENTITY_CAPTURE_STEPS.length;
}

export function parseIdentityCaptureSession(value: unknown): IdentityCaptureSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { id?: unknown; challengeCode?: unknown; expiresAt?: unknown; steps?: unknown };
  if (
    typeof candidate.id !== 'string'
    || !/^\d{4}$/.test(typeof candidate.challengeCode === 'string' ? candidate.challengeCode : '')
    || typeof candidate.expiresAt !== 'string'
    || Number.isNaN(Date.parse(candidate.expiresAt))
    || !Array.isArray(candidate.steps)
    || !candidate.steps.every((step): step is IdentityCaptureStep => typeof step === 'string' && IDENTITY_CAPTURE_STEPS.includes(step as IdentityCaptureStep))
    || !hasAllIdentityCaptureSteps(candidate.steps)
  ) return null;
  return {
    id: candidate.id,
    challengeCode: candidate.challengeCode as string,
    expiresAt: candidate.expiresAt,
    steps: candidate.steps,
  };
}
