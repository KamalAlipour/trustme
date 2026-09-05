import { describe, expect, it, vi } from 'vitest';
import { en } from '../i18n/en';
import { DEFAULT_DISPLAY_UNIT } from '../i18n/display-unit';
import { emailSuccessMessage, isValidEmail, isValidEmailCode, submitEmailAction } from './email-validation';

describe('email verification controls', () => {
  const translations = en(DEFAULT_DISPLAY_UNIT);

  it('rejects an empty or malformed email before sending a request', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('  member@example.com  ')).toBe(true);
  });

  it('does not send an invalid email', async () => {
    const send = vi.fn(async () => undefined);
    expect(await submitEmailAction('send', 'not-an-email', send, translations)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('only enables verification for exactly six digits', () => {
    expect(isValidEmailCode('')).toBe(false);
    expect(isValidEmailCode('12345')).toBe(false);
    expect(isValidEmailCode('1234567')).toBe(false);
    expect(isValidEmailCode('123456')).toBe(true);
  });

  it('uses the in-card success message for each email action', () => {
    expect(emailSuccessMessage('send', translations)).toBe(translations.emailCodeSentNotice);
    expect(emailSuccessMessage('verify', translations)).toBe(translations.emailVerified);
  });

  it('returns the send success message after a valid request', async () => {
    const send = vi.fn(async () => undefined);
    await expect(submitEmailAction('send', ' member@example.com ', send, translations)).resolves.toBe(translations.emailCodeSentNotice);
    expect(send).toHaveBeenCalledWith('member@example.com');
  });
});
