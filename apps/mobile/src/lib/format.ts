import type { Language } from './storage';

const persianDigits = '۰۱۲۳۴۵۶۷۸۹';

function localizeDigits(value: string, language: Language): string {
  return language === 'fa'
    ? value.replace(/\d/g, (digit) => persianDigits[Number(digit)] ?? digit)
    : value;
}

export function formatCoupons(coupons: string, language: Language): string {
  if (!/^\d+$/.test(coupons)) throw new Error('invalid coupon amount');
  const grouped = coupons.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return localizeDigits(grouped, language);
}

export function formatDate(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language === 'fa' ? 'fa-IR' : 'en-US', { dateStyle: 'medium' }).format(new Date(value));
}

export function formatMicroUsdt(value: string, language: Language): string {
  const micro = BigInt(value);
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return localizeDigits(fraction ? `${whole}.${fraction}` : whole.toString(), language);
}
