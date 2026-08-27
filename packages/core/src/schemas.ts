import { getAddress } from 'ethers';
import { z } from 'zod';

export const evmAddressSchema = z.string().refine((value) => {
  try {
    return /^0x[0-9a-fA-F]{40}$/.test(value) && getAddress(value) === value;
  } catch {
    return false;
  }
}, 'address must be a valid EIP-55 checksummed EVM address');

export const positiveBigIntSchema = z.bigint().positive();
export const phoneNumberSchema = z.string().min(1).max(32);
export const barcodeIdSchema = z.string().min(1).max(128);
export const fourDigitCodeSchema = z.string().regex(/^\d{4}$/, 'code must be exactly four digits');

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
