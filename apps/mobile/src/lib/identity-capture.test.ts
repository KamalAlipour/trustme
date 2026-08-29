import { describe, expect, it } from 'vitest';
import { hasAllIdentityCaptureSteps, IDENTITY_CAPTURE_STEPS, isIdentityCaptureSessionUnavailable, parseIdentityCaptureSession } from './identity-capture';

describe('identity capture steps', () => {
  it('requires exactly one frame for each server-required step', () => {
    expect(hasAllIdentityCaptureSteps(IDENTITY_CAPTURE_STEPS)).toBe(true);
    expect(hasAllIdentityCaptureSteps(IDENTITY_CAPTURE_STEPS.slice(0, 3))).toBe(false);
    expect(hasAllIdentityCaptureSteps([...IDENTITY_CAPTURE_STEPS, 'DOCUMENT_FRONT'])).toBe(false);
  });

  it('accepts only a complete server capture session payload', () => {
    const payload = {
      id: 'session-id',
      challengeCode: '1234',
      expiresAt: '2026-08-29T18:00:00.000Z',
      steps: [...IDENTITY_CAPTURE_STEPS].reverse(),
    };
    expect(parseIdentityCaptureSession(payload)).toEqual(payload);
    expect(parseIdentityCaptureSession({ ...payload, challengeCode: '123' })).toBeNull();
    expect(parseIdentityCaptureSession({ ...payload, steps: payload.steps.slice(1) })).toBeNull();
  });

  it('identifies an expired or consumed capture session response', () => {
    expect(isIdentityCaptureSessionUnavailable({
      status: 409,
      message: 'identity capture session is expired or already used',
    })).toBe(true);
    expect(isIdentityCaptureSessionUnavailable({
      status: 409,
      message: 'identity review already pending',
    })).toBe(false);
    expect(isIdentityCaptureSessionUnavailable({
      status: 400,
      message: 'identity capture session is expired or already used',
    })).toBe(false);
  });
});
