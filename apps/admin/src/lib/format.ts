import { LOCALE } from '../constants';

export function formatDate(value: string): string {
  return new Date(value).toLocaleString(LOCALE.intl);
}

export function formatCompactDate(value: string): string {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

export function truncateHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function truncateAddress(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function microUsdtToDecimal(value: string): string {
  const micro = BigInt(value);
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function decimalUsdtToMicro(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error('invalid USDT amount');
  const [whole = '0', fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')).toString();
}

export function bpsToPercent(value: string): string {
  const bps = BigInt(value);
  const whole = bps / 100n;
  const fraction = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}
