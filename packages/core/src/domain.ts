import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  AccountType,
  Asset,
  EscrowStatus,
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
  WithdrawalStatus,
} from '@trustme/db';
import { postTransaction, postWithClient } from './ledger.js';
import { couponsFromMicroUsdt, roundingDustMicroUsdt, withdrawalQuote } from './money.js';
import { evmAddressSchema, fourDigitCodeSchema } from './schemas.js';

export async function postDeposit(
  prisma: PrismaClient,
  input: {
    externalRef: string;
    userId: string;
    userCouponAccountId: string;
    externalOnchainAccountId: string;
    vaultAccountId: string;
    issuanceAccountId: string;
    amountMicroUsdt: bigint;
    txHash?: string;
  },
) {
  if (input.amountMicroUsdt <= 0n) throw new Error('deposit amount must be positive');
  const coupons = couponsFromMicroUsdt(input.amountMicroUsdt);
  if (coupons <= 0n) throw new Error('deposit must contain at least one coupon');
  return postTransaction(prisma, {
    type: TransactionType.DEPOSIT,
    externalRef: input.externalRef,
    userId: input.userId,
    ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
    amountMicroUsdt: input.amountMicroUsdt,
    amountCoupons: coupons,
    roundingDustMicroUsdt: roundingDustMicroUsdt(input.amountMicroUsdt),
    legs: [
      { fromAccountId: input.externalOnchainAccountId, toAccountId: input.vaultAccountId, amount: input.amountMicroUsdt, asset: Asset.USDT },
      { fromAccountId: input.issuanceAccountId, toAccountId: input.userCouponAccountId, amount: coupons, asset: Asset.COUPON },
    ],
  });
}

export async function transferCoupons(
  prisma: PrismaClient,
  input: { userId?: string; externalRef: string; fromAccountId: string; toAccountId: string; amountCoupons: bigint },
) {
  if (input.amountCoupons <= 0n) throw new Error('transfer amount must be positive');
  return postTransaction(prisma, {
    type: TransactionType.TRANSFER,
    externalRef: input.externalRef,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    amountCoupons: input.amountCoupons,
    legs: [{ fromAccountId: input.fromAccountId, toAccountId: input.toAccountId, amount: input.amountCoupons, asset: Asset.COUPON }],
  });
}

export async function createEscrowHold(
  prisma: PrismaClient,
  input: {
    senderId: string;
    recipientId: string;
    senderAccountId: string;
    escrowAccountId: string;
    amountCoupons: bigint;
    code: string;
    expiresAt: Date;
    externalRef?: string;
  },
) {
  fourDigitCodeSchema.parse(input.code);
  if (input.amountCoupons <= 0n) throw new Error('escrow amount must be positive');
  if (input.expiresAt <= new Date()) throw new Error('escrow expiry must be in the future');
  const holdId = randomUUID();
  const externalRef = input.externalRef ?? `escrow:${holdId}:hold`;
  const codeHash = await bcrypt.hash(input.code, 12);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.escrowHold.findFirst({ where: { transaction: { externalRef } } });
    if (existing) return existing;
    const transaction = await postWithClient(tx, {
      type: TransactionType.ESCROW_HOLD,
      externalRef,
      userId: input.senderId,
      amountCoupons: input.amountCoupons,
      legs: [{ fromAccountId: input.senderAccountId, toAccountId: input.escrowAccountId, amount: input.amountCoupons, asset: Asset.COUPON }],
    });
    return tx.escrowHold.create({
      data: {
        id: holdId,
        senderId: input.senderId,
        recipientId: input.recipientId,
        escrowAccountId: input.escrowAccountId,
        transactionId: transaction.id,
        amountCoupons: input.amountCoupons,
        codeHash,
        expiresAt: input.expiresAt,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function cancelLockedHold(
  tx: Prisma.TransactionClient,
  hold: { id: string; senderId: string; amountCoupons: bigint; escrowAccountId: string; status: EscrowStatus; transactionId: string },
  senderAccountId: string,
  type: TransactionType,
  externalRef: string,
  status: EscrowStatus,
) {
  if (hold.status !== EscrowStatus.ACTIVE && hold.status !== EscrowStatus.LOCKED) {
    return tx.escrowHold.findUniqueOrThrow({ where: { id: hold.id } });
  }
  await postWithClient(tx, {
    type,
    externalRef,
    userId: hold.senderId,
    amountCoupons: hold.amountCoupons,
    legs: [{ fromAccountId: hold.escrowAccountId, toAccountId: senderAccountId, amount: hold.amountCoupons, asset: Asset.COUPON }],
  });
  await tx.escrowHold.update({ where: { id: hold.id }, data: { status } });
  return tx.escrowHold.findUniqueOrThrow({ where: { id: hold.id } });
}

export async function releaseEscrow(
  prisma: PrismaClient,
  input: { holdId: string; recipientAccountId: string; code: string },
) {
  fourDigitCodeSchema.parse(input.code);
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "EscrowHold" WHERE "id" = ${input.holdId}::uuid FOR UPDATE`);
    const hold = await tx.escrowHold.findUniqueOrThrow({ where: { id: input.holdId } });
    if (hold.status !== EscrowStatus.ACTIVE) throw new Error('escrow is not active');
    if (hold.expiresAt <= new Date()) throw new Error('escrow has expired');
    const valid = await bcrypt.compare(input.code, hold.codeHash);
    if (!valid) {
      const wrongAttempts = hold.wrongAttempts + 1;
      await tx.escrowHold.update({
        where: { id: hold.id },
        data: { wrongAttempts, status: wrongAttempts >= 5 ? EscrowStatus.LOCKED : EscrowStatus.ACTIVE },
      });
      return { hold: null, error: wrongAttempts >= 5 ? 'escrow locked' : 'invalid escrow code' };
    }
    await postWithClient(tx, {
      type: TransactionType.ESCROW_RELEASE,
      externalRef: `escrow:${hold.id}:release`,
      userId: hold.recipientId,
      amountCoupons: hold.amountCoupons,
      legs: [{ fromAccountId: hold.escrowAccountId, toAccountId: input.recipientAccountId, amount: hold.amountCoupons, asset: Asset.COUPON }],
    });
    await tx.escrowHold.update({ where: { id: hold.id }, data: { status: EscrowStatus.RELEASED } });
    return { hold: await tx.escrowHold.findUniqueOrThrow({ where: { id: hold.id } }), error: null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.error) throw new Error(result.error);
  return result.hold;
}

export async function cancelEscrow(
  prisma: PrismaClient,
  input: { holdId: string; senderAccountId: string; expired?: boolean },
) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const hold = await tx.escrowHold.findUniqueOrThrow({ where: { id: input.holdId } });
    const expired = input.expired || hold.expiresAt <= new Date();
    return cancelLockedHold(
      tx,
      hold,
      input.senderAccountId,
      expired ? TransactionType.ESCROW_CANCEL : TransactionType.ESCROW_CANCEL,
      `escrow:${hold.id}:cancel`,
      expired ? EscrowStatus.EXPIRED : EscrowStatus.CANCELLED,
    );
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function quoteWithdrawalForUsdt(
  couponsGross: bigint,
  baseFeeBps: bigint,
  minimumWithdrawalMicroUsdt: bigint,
) {
  return withdrawalQuote(couponsGross, baseFeeBps, minimumWithdrawalMicroUsdt);
}

export async function requestWithdrawal(
  prisma: PrismaClient,
  input: {
    userId: string;
    userAccountId: string;
    destinationAddress: string;
    couponsGross: bigint;
    baseFeeBps: bigint;
    minimumWithdrawalMicroUsdt: bigint;
    autoApprovalLimitMicroUsdt: bigint;
    vaultAccountId: string;
    feeAccountId: string;
    pendingAccountId: string;
    issuanceAccountId: string;
  },
) {
  evmAddressSchema.parse(input.destinationAddress);
  const quote = withdrawalQuote(input.couponsGross, input.baseFeeBps, input.minimumWithdrawalMicroUsdt);
  const withdrawalId = randomUUID();
  const status = quote.netMicroUsdt <= input.autoApprovalLimitMicroUsdt
    ? WithdrawalStatus.APPROVED
    : WithdrawalStatus.PENDING_APPROVAL;
  const transactionStatus = status === WithdrawalStatus.APPROVED ? TransactionStatus.APPROVED : TransactionStatus.PENDING_APPROVAL;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const transaction = await postWithClient(tx, {
      type: TransactionType.WITHDRAWAL,
      externalRef: `withdrawal:${withdrawalId}:burn`,
      userId: input.userId,
      status: transactionStatus,
      amountMicroUsdt: quote.grossMicroUsdt,
      amountCoupons: input.couponsGross,
      feeMicroUsdt: quote.feeMicroUsdt,
      legs: [
        { fromAccountId: input.userAccountId, toAccountId: input.issuanceAccountId, amount: input.couponsGross, asset: Asset.COUPON },
        ...(quote.feeMicroUsdt > 0n ? [{ fromAccountId: input.vaultAccountId, toAccountId: input.feeAccountId, amount: quote.feeMicroUsdt, asset: Asset.USDT }] : []),
        { fromAccountId: input.vaultAccountId, toAccountId: input.pendingAccountId, amount: quote.netMicroUsdt, asset: Asset.USDT },
      ],
    });
    return tx.withdrawal.create({
      data: {
        id: withdrawalId,
        userId: input.userId,
        transactionId: transaction.id,
        destinationAddress: input.destinationAddress,
        couponsGross: input.couponsGross,
        grossMicroUsdt: quote.grossMicroUsdt,
        feeMicroUsdt: quote.feeMicroUsdt,
        netMicroUsdt: quote.netMicroUsdt,
        status,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function refundWithdrawal(
  prisma: PrismaClient,
  input: {
    withdrawalId: string;
    userAccountId: string;
    vaultAccountId: string;
    feeAccountId: string;
    pendingAccountId: string;
    issuanceAccountId: string;
  },
) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: input.withdrawalId } });
    if (withdrawal.status === WithdrawalStatus.REFUNDED) return withdrawal;
    if (withdrawal.status === WithdrawalStatus.COMPLETED) throw new Error('completed withdrawal cannot be refunded');
    await postWithClient(tx, {
      type: TransactionType.REFUND,
      externalRef: `withdrawal:${withdrawal.id}:refund`,
      userId: withdrawal.userId,
      status: TransactionStatus.REFUNDED,
      amountMicroUsdt: withdrawal.grossMicroUsdt,
      amountCoupons: withdrawal.couponsGross,
      feeMicroUsdt: withdrawal.feeMicroUsdt,
      legs: [
        { fromAccountId: input.pendingAccountId, toAccountId: input.vaultAccountId, amount: withdrawal.netMicroUsdt, asset: Asset.USDT },
        ...(withdrawal.feeMicroUsdt > 0n ? [{ fromAccountId: input.feeAccountId, toAccountId: input.vaultAccountId, amount: withdrawal.feeMicroUsdt, asset: Asset.USDT }] : []),
        { fromAccountId: input.issuanceAccountId, toAccountId: input.userAccountId, amount: withdrawal.couponsGross, asset: Asset.COUPON },
      ],
    });
    return tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: WithdrawalStatus.REFUNDED } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export { AccountType, Asset };
