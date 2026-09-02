import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
const platform = vi.hoisted(() => ({ OS: 'ios', Version: null as string | null }));
vi.mock('../lib/storage', () => ({
  clearCredentials: vi.fn(async () => undefined),
  readRefreshToken: vi.fn(async () => 'refresh'),
  saveRefreshToken: vi.fn(async () => undefined),
}));
vi.mock('react-native', () => ({ Platform: platform }));
import { ApiError } from '../api/client';
import { mapApiError } from './errors';
import { fa } from '../i18n/fa';

describe('Persian API errors', () => {
  it('maps country-scoped spending identity failures to identity guidance', () => {
    expect(mapApiError(new ApiError(403, { error: 'identity_verification_required' }), fa)).toBe(fa.identitySpendingRequired);
  });

  it('maps refund, aid, and upload failures', () => {
    expect(mapApiError(new ApiError(409, { error: 'insufficient balance for refund' }), fa)).toBe(fa.insufficientRefundBalance);
    expect(mapApiError(new ApiError(409, { error: 'insufficient charity balance' }), fa)).toBe(fa.insufficientCharityBalance);
    expect(mapApiError(new ApiError(413, { error: 'media file is too large' }), fa)).toBe(fa.mediaTooLarge);
    expect(mapApiError(new ApiError(415, { error: 'unsupported media type' }), fa)).toBe(fa.unsupportedMedia);
  });
});
