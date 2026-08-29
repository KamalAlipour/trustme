import { describe, expect, it, vi } from 'vitest';
import { en } from '../i18n/en';
import { emailSuccessMessage, isValidEmail, isValidEmailCode, submitEmailAction } from './email-validation';

describe('email verification controls', () => {
  it('rejects an empty or malformed email before sending a request', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('  member@example.com  ')).toBe(true);
  });

  it('does not send an invalid email', async () => {
    const send = vi.fn(async () => undefined);
    expect(await submitEmailAction('send', 'not-an-email', send, en)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('only enables verification for exactly six digits', () => {
    expect(isValidEmailCode('')).toBe(false);
    expect(isValidEmailCode('12345')).toBe(false);
    expect(isValidEmailCode('1234567')).toBe(false);
    expect(isValidEmailCode('123456')).toBe(true);
  });

  it('uses the in-card success message for each email action', () => {
    expect(emailSuccessMessage('send', en)).toBe(en.emailCodeSentNotice);
    expect(emailSuccessMessage('verify', en)).toBe(en.emailVerified);
  });

  it('returns the send success message after a valid request', async () => {
    const send = vi.fn(async () => undefined);
    await expect(submitEmailAction('send', ' member@example.com ', send, en)).resolves.toBe(en.emailCodeSentNotice);
    expect(send).toHaveBeenCalledWith('member@example.com');
  });
});
