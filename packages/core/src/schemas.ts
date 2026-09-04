import { randomBytes } from 'node:crypto';
import { getAddress } from 'ethers';
import { z } from 'zod';
import { ISO_ALPHA2_CODES } from './countries.js';
import { microUsdtFromCouponAmount } from './money.js';

export const evmAddressSchema = z.string().refine((value) => {
  try {
    return /^0x[0-9a-fA-F]{40}$/.test(value) && getAddress(value) === value;
  } catch {
    return false;
  }
}, 'address must be a valid EIP-55 checksummed EVM address');

export const positiveBigIntSchema = z.bigint().positive();
export const phoneNumberSchema = z.string().min(1).max(32);
function hasValidIranianNationalCode(value: string): boolean {
  if (/^(\d)\1{9}$/.test(value)) return false;
  const sum = value.slice(0, 9).split('').reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  const expected = remainder < 2 ? remainder : 11 - remainder;
  return Number(value[9]) === expected;
}

export const nationalCodeSchema = z.string()
  .regex(/^\d{10}$/, 'national code must be exactly 10 digits')
  .refine(hasValidIranianNationalCode, 'national code checksum is invalid');

export const couponAmountSchema = z.string()
  .trim()
  .transform((value) => value.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٫,]/g, '.'))
  .refine((value) => /^(0|[1-9]\d*)(\.\d{1,4})?$/.test(value), 'amount must be a decimal coupon amount')
  .refine((value) => {
    try {
      return microUsdtFromCouponAmount(value) > 0n;
    } catch {
      return false;
    }
  }, 'amount must be positive');

export const ibanSchema = z.string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
  .refine((value) => /^IR\d{24}$/.test(value), 'iban must be an Iranian IBAN (IR + 24 digits)');
export const jalaliBirthDateSchema = z.string()
  .trim()
  .transform((value) => value.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/-/g, '/'))
  .refine((value) => /^1[34]\d{2}\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/.test(value), 'birth date must be Jalali YYYY/M/D');

export const iranMobileSchema = z.string()
  .refine((value) => /^09\d{9}$/.test(value) || /^\+989\d{9}$/.test(value) || /^00989\d{9}$/.test(value) || /^989\d{9}$/.test(value), 'mobile must be a valid Iranian mobile number')
  .transform((value) => {
    if (value.startsWith('09')) return value;
    if (value.startsWith('+98')) return `0${value.slice(3)}`;
    if (value.startsWith('0098')) return `0${value.slice(4)}`;
    return `0${value.slice(2)}`;
  });
export const countrySchema = z.string().trim().transform((value) => value.toUpperCase()).refine((value) => ISO_ALPHA2_CODES.has(value), 'country must be an ISO 3166-1 alpha-2 code');
export const barcodeIdSchema = z.string().min(1).max(128);
export const fourDigitCodeSchema = z.string().regex(/^\d{4}$/, 'code must be exactly four digits');

const BARCODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateBarcodeId(): string {
  const characters: string[] = [];
  while (characters.length < 14) {
    const bytes = randomBytes(14 - characters.length);
    for (const byte of bytes) {
      if (byte >= 256 - (256 % BARCODE_ALPHABET.length)) continue;
      characters.push(BARCODE_ALPHABET[byte % BARCODE_ALPHABET.length]!);
      if (characters.length === 14) break;
    }
  }
  return `TC${characters.join('')}`;
}

export const internalTransferInputSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amountCoupons: positiveBigIntSchema,
});

export const escrowInputSchema = z.object({
  senderId: z.string().uuid(),
  recipientId: z.string().uuid(),
  senderAccountId: z.string().uuid(),
  escrowAccountId: z.string().uuid(),
  amountCoupons: positiveBigIntSchema,
  code: fourDigitCodeSchema,
  expiresAt: z.coerce.date(),
});

export const withdrawalInputSchema = z.object({
  userId: z.string().uuid(),
  userAccountId: z.string().uuid(),
  destinationAddress: evmAddressSchema,
  couponsGross: positiveBigIntSchema,
});

export type InternalTransferInput = z.infer<typeof internalTransferInputSchema>;
export type EscrowInput = z.infer<typeof escrowInputSchema>;
export type WithdrawalInput = z.infer<typeof withdrawalInputSchema>;
