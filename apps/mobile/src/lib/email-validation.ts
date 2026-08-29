import type { Translations } from '../i18n/en';

export type EmailAction = 'send' | 'verify';

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isValidEmailCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export function emailSuccessMessage(action: EmailAction, translations: Translations): string {
  return action === 'send' ? translations.emailCodeSentNotice : translations.emailVerified;
}

export async function submitEmailAction(
  action: EmailAction,
  value: string,
  send: (value: string) => Promise<void>,
  translations: Translations,
): Promise<string | null> {
  const valid = action === 'send' ? isValidEmail(value) : isValidEmailCode(value);
  if (!valid) return null;
  await send(action === 'send' ? value.trim() : value);
  return emailSuccessMessage(action, translations);
}
