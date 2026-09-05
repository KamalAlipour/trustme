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
import { DEFAULT_DISPLAY_UNIT } from '../i18n/display-unit';

describe('Persian API errors', () => {
  const translations = fa(DEFAULT_DISPLAY_UNIT);

  it('maps country-scoped spending identity failures to identity guidance', () => {
    expect(mapApiError(new ApiError(403, { error: 'identity_verification_required' }), translations)).toBe(translations.identitySpendingRequired);
  });

  it('maps refund, aid, and upload failures', () => {
    expect(mapApiError(new ApiError(409, { error: 'insufficient balance for refund' }), translations)).toBe(translations.insufficientRefundBalance);
    expect(mapApiError(new ApiError(409, { error: 'insufficient charity balance' }), translations)).toBe(translations.insufficientCharityBalance);
    expect(mapApiError(new ApiError(413, { error: 'media file is too large' }), translations)).toBe(translations.mediaTooLarge);
    expect(mapApiError(new ApiError(415, { error: 'unsupported media type' }), translations)).toBe(translations.unsupportedMedia);
  });
});
