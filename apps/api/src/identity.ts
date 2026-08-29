import { createHmac } from 'node:crypto';

export function hashIdentityValue(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}
