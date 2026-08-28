const persianDigits = '۰۱۲۳۴۵۶۷۸۹';

export function formatCoupons(coupons: string): string {
  if (!/^\d+$/.test(coupons)) throw new Error('invalid coupon amount');
  const grouped = coupons.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return grouped.replace(/\d/g, (digit) => persianDigits[Number(digit)] ?? digit);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(value));
}

export function formatMicroUsdt(value: string): string {
  const micro = BigInt(value);
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
