export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (new Set(pin).size === 1) return true;
  const ascending = pin.split('').every((digit, index, values) => index === 0 || Number(digit) === Number(values[index - 1]) + 1);
  const descending = pin.split('').every((digit, index, values) => index === 0 || Number(digit) === Number(values[index - 1]) - 1);
  return ascending || descending;
}

const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
export function formatCoupons(coupons: string): string {
  if (!/^\d+$/.test(coupons)) throw new Error('invalid coupon amount');
  const grouped = coupons.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return grouped.replace(/\d/g, (digit) => persianDigits[Number(digit)] ?? digit);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(value));
}
