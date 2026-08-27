export const MICRO_USDT_PER_COUPON = 10_000n;
export const BPS_DENOMINATOR = 10_000n;

export function couponsFromMicroUsdt(microUsdt: bigint): bigint {
  if (microUsdt < 0n) throw new Error('micro-USDT cannot be negative');
  return microUsdt / MICRO_USDT_PER_COUPON;
}

export function microUsdtFromCoupons(coupons: bigint): bigint {
  if (coupons < 0n) throw new Error('coupons cannot be negative');
  return coupons * MICRO_USDT_PER_COUPON;
}

export function roundingDustMicroUsdt(microUsdt: bigint): bigint {
  return microUsdt % MICRO_USDT_PER_COUPON;
}

export function feeMicroUsdt(grossMicroUsdt: bigint, baseFeeBps: bigint): bigint {
  if (grossMicroUsdt < 0n || baseFeeBps < 0n) throw new Error('money values cannot be negative');
  return (grossMicroUsdt * baseFeeBps) / BPS_DENOMINATOR;
}

export function withdrawalQuote(
  couponsGross: bigint,
  baseFeeBps: bigint,
  minimumWithdrawalMicroUsdt: bigint,
): { grossMicroUsdt: bigint; feeMicroUsdt: bigint; netMicroUsdt: bigint } {
  if (couponsGross <= 0n) throw new Error('withdrawal must contain coupons');
  const grossMicroUsdt = microUsdtFromCoupons(couponsGross);
  const fee = feeMicroUsdt(grossMicroUsdt, baseFeeBps);
  const netMicroUsdt = grossMicroUsdt - fee;
  if (netMicroUsdt < minimumWithdrawalMicroUsdt) throw new Error('withdrawal is below minimum');
  return { grossMicroUsdt, feeMicroUsdt: fee, netMicroUsdt };
}

export function microUsdtFromDecimal(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error('invalid USDT amount');
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
}

export function decimalFromMicroUsdt(value: bigint): string {
  if (value < 0n) throw new Error('micro-USDT cannot be negative');
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
