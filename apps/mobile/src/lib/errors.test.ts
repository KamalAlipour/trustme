import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('../lib/storage', () => ({
  clearCredentials: vi.fn(async () => undefined),
  readRefreshToken: vi.fn(async () => 'refresh'),
  saveRefreshToken: vi.fn(async () => undefined),
}));
import { ApiError } from '../api/client';
import { mapApiError } from './errors';

describe('Persian API errors', () => {
  it('maps refund, aid, and upload failures', () => {
    expect(mapApiError(new ApiError(409, { error: 'insufficient balance for refund' }))).toBe('موجودی کوپن برای بازپرداخت کافی نیست.');
    expect(mapApiError(new ApiError(409, { error: 'insufficient charity balance' }))).toBe('موجودی خیریه کافی نیست.');
    expect(mapApiError(new ApiError(413, { error: 'media file is too large' }))).toContain('بیش از حد');
    expect(mapApiError(new ApiError(415, { error: 'unsupported media type' }))).toContain('پشتیبانی');
  });
});
