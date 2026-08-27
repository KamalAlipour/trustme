const persianDigits = '۰۱۲۳۴۵۶۷۸۹';

export function formatCoupons(coupons: string): string {
  if (!/^\d+$/.test(coupons)) throw new Error('invalid coupon amount');
  const grouped = coupons.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return grouped.replace(/\d/g, (digit) => persianDigits[Number(digit)] ?? digit);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(value));
}
