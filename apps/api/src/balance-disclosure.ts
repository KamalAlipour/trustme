import { createHmac, timingSafeEqual } from 'node:crypto';

const CODE_LENGTH = 6;
const CODE_LIMIT = 1_000_000;

export function disclosureCodeHash(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}

export function recoverDisclosureCode(hash: string, pepper: string): string | null {
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== 32) return null;
  for (let value = 0; value < CODE_LIMIT; value += 1) {
    const code = value.toString().padStart(CODE_LENGTH, '0');
    const candidate = Buffer.from(disclosureCodeHash(code, pepper), 'hex');
    if (timingSafeEqual(expected, candidate)) return code;
  }
  return null;
}
