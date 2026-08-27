import { LOCALE } from '../constants';

export function formatDate(value: string): string {
  return new Date(value).toLocaleString(LOCALE.intl);
}

export function truncateHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
