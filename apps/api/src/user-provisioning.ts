import { HDNodeWallet } from 'ethers';
import {
  AccountType,
  Asset,
  Prisma,
  PrismaClient,
} from '@trustme/db';
import { generateBarcodeId, withSerializableRetry } from '@trustme/core';

export type UserProvisioningConfig = {
  depositXpub: string;
};

export type UserProvisioningInput = {
  phoneNumber?: string | null;
  barcodeId?: string;
  aliasName?: string;
  displayName?: string;
  email?: string;
  emailVerifiedAt?: Date;
  pinHash?: string;
  pinUpdatedAt?: Date;
  isDemo?: boolean;
};

export function isBarcodeUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes('barcodeId') : target === 'barcodeId';
}

export function isEmailUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes('email') : target === 'email' || target === 'User_email_key';
}

export async function createUserWithAccounts(
  tx: Prisma.TransactionClient,
  config: UserProvisioningConfig,
  input: UserProvisioningInput & { barcodeId: string },
) {
  const user = await tx.user.create({
    data: {
      phoneNumber: input.phoneNumber ?? null,
      barcodeId: input.barcodeId,
      ...(input.aliasName === undefined ? {} : { aliasName: input.aliasName }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.emailVerifiedAt === undefined ? {} : { emailVerifiedAt: input.emailVerifiedAt }),
      ...(input.pinHash === undefined ? {} : { pinHash: input.pinHash }),
      ...(input.pinUpdatedAt === undefined ? {} : { pinUpdatedAt: input.pinUpdatedAt }),
      ...(input.isDemo === undefined ? {} : { isDemo: input.isDemo }),
    },
  });
  await tx.ledgerAccount.create({ data: { type: AccountType.USER_COUPON, asset: Asset.COUPON, userId: user.id } });
  await tx.ledgerAccount.create({ data: { type: AccountType.ESCROW, asset: Asset.COUPON, userId: user.id } });
  const depositAddress = await tx.depositAddress.create({ data: { userId: user.id, address: `pending:${user.id}` } });
  const derived = HDNodeWallet.fromExtendedKey(config.depositXpub).deriveChild(depositAddress.derivationIndex);
  await tx.depositAddress.update({ where: { id: depositAddress.id }, data: { address: derived.address } });
  return user;
}

export async function provisionUser(
  prisma: PrismaClient,
  config: UserProvisioningConfig,
  input: UserProvisioningInput,
  barcodeGenerator: () => string = generateBarcodeId,
) {
  const generated = input.barcodeId === undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const barcodeId = input.barcodeId ?? barcodeGenerator();
    try {
      return await withSerializableRetry(prisma, (tx) => createUserWithAccounts(tx, config, { ...input, barcodeId }));
    } catch (error) {
      if (!generated || !isBarcodeUniqueViolation(error) || attempt === 4) throw error;
    }
  }
  throw new Error('barcode generation failed');
}
