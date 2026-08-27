type Installment = { amountCoupons: string; paidCoupons: string };

function parseCouponAmount(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('invalid coupon amount');
  return BigInt(value);
}

export function greaterThan(left: string, right: string): boolean {
  return parseCouponAmount(left) > parseCouponAmount(right);
}

export function subtractCoupons(left: string, right: string): string {
  return (parseCouponAmount(left) - parseCouponAmount(right)).toString();
}

export function nextInstallmentAmount(loan: { installments: Installment[]; outstandingCoupons: string }): string {
  const installment = loan.installments.find((row) => row.paidCoupons !== row.amountCoupons);
  return installment ? subtractCoupons(installment.amountCoupons, installment.paidCoupons) : loan.outstandingCoupons;
}
