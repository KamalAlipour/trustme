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
import { postWithClient } from './ledger.js';
import { couponsFromMicroUsdt, withdrawalQuote } from './money.js';
import { evmAddressSchema, fourDigitCodeSchema } from './schemas.js';
import { withSerializableRetry } from './retry.js';
import { DomainError } from './domain-error.js';
import { assertNotRestricted, readWithdrawalAvailabilityInTransaction } from './lending.js';

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
  if (input.amountMicroUsdt <= 0n) throw new DomainError('deposit amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    const existing = await tx.transaction.findUnique({ where: { externalRef: input.externalRef } });
    if (existing) return existing;
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${input.userId}::uuid FOR UPDATE`);
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId } });
    const combinedDust = user.dustMicroUsdt + input.amountMicroUsdt;
    const coupons = couponsFromMicroUsdt(combinedDust);
    const carry = combinedDust % 10_000n;
    const transaction = await postWithClient(tx, {
      type: TransactionType.DEPOSIT,
      externalRef: input.externalRef,
      userId: input.userId,
      ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
      status: TransactionStatus.CONFIRMED,
      amountMicroUsdt: input.amountMicroUsdt,
      amountCoupons: coupons,
      roundingDustMicroUsdt: carry,
      legs: [
        { fromAccountId: input.externalOnchainAccountId, toAccountId: input.vaultAccountId, amount: input.amountMicroUsdt, asset: Asset.USDT },
        ...(coupons > 0n ? [{ fromAccountId: input.issuanceAccountId, toAccountId: input.userCouponAccountId, amount: coupons, asset: Asset.COUPON }] : []),
      ],
    });
    await tx.user.update({ where: { id: input.userId }, data: { dustMicroUsdt: carry } });
    return transaction;
  });
}

export async function transferCoupons(
  prisma: PrismaClient,
  input: { userId?: string; externalRef: string; fromAccountId: string; toAccountId: string; amountCoupons: bigint },
) {
  if (input.amountCoupons <= 0n) throw new DomainError('transfer amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    if (input.userId !== undefined) await assertNotRestricted(tx, input.userId);
    return postWithClient(tx, {
      type: TransactionType.TRANSFER,
      externalRef: input.externalRef,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      status: TransactionStatus.CONFIRMED,
      amountCoupons: input.amountCoupons,
      legs: [{ fromAccountId: input.fromAccountId, toAccountId: input.toAccountId, amount: input.amountCoupons, asset: Asset.COUPON }],
    });
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
  if (input.amountCoupons <= 0n) throw new DomainError('escrow amount must be positive');
  if (input.expiresAt <= new Date()) throw new DomainError('escrow expiry must be in the future');
  const holdId = randomUUID();
  const externalRef = input.externalRef ?? `escrow:${holdId}:hold`;
  const codeHash = await bcrypt.hash(input.code, 10);
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    const existing = await tx.escrowHold.findFirst({ where: { transaction: { externalRef } } });
    if (existing) return existing;
    await assertNotRestricted(tx, input.senderId);
    const transaction = await postWithClient(tx, {
      type: TransactionType.ESCROW_HOLD,
      externalRef,
      userId: input.senderId,
      status: TransactionStatus.CONFIRMED,
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
  });
}

async function cancelLockedHold(
  tx: Prisma.TransactionClient,
  hold: { id: string; senderId: string; amountCoupons: bigint; escrowAccountId: string; status: EscrowStatus; transactionId: string },
  senderAccountId: string,
  type: TransactionType,
  externalRef: string,
  status: EscrowStatus,
) {
  if (hold.status !== EscrowStatus.ACTIVE && hold.status !== EscrowStatus.LOCKED) throw new DomainError('escrow is not active');
  await postWithClient(tx, {
    type,
    externalRef,
    userId: hold.senderId,
    status: TransactionStatus.CONFIRMED,
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
  const result = await withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "EscrowHold" WHERE "id" = ${input.holdId}::uuid FOR UPDATE`);
    const hold = await tx.escrowHold.findUniqueOrThrow({ where: { id: input.holdId } });
    if (hold.status !== EscrowStatus.ACTIVE) throw new DomainError('escrow is not active');
    if (hold.expiresAt <= new Date()) throw new DomainError('escrow has expired');
    // Keep comparison inside the transaction so the attempt counter is atomic.
    const valid = await bcrypt.compare(input.code, hold.codeHash);
    if (!valid) {
      const wrongAttempts = hold.wrongAttempts + 1;
      await tx.escrowHold.update({
        where: { id: hold.id },
        data: { wrongAttempts, status: wrongAttempts >= 5 ? EscrowStatus.LOCKED : EscrowStatus.ACTIVE },
      });
      return { hold: null, error: wrongAttempts >= 5 ? 'escrow locked' : 'invalid escrow code' };
    }
    const release = await postWithClient(tx, {
      type: TransactionType.ESCROW_RELEASE,
      externalRef: `escrow:${hold.id}:release`,
      userId: hold.recipientId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: hold.amountCoupons,
      legs: [{ fromAccountId: hold.escrowAccountId, toAccountId: input.recipientAccountId, amount: hold.amountCoupons, asset: Asset.COUPON }],
    });
    await tx.escrowHold.update({ where: { id: hold.id }, data: { status: EscrowStatus.RELEASED, releaseTransactionId: release.id } });
    return { hold: await tx.escrowHold.findUniqueOrThrow({ where: { id: hold.id } }), error: null };
  });
  if (result.error) throw new DomainError(result.error);
  return result.hold;
}

export async function cancelEscrow(
  prisma: PrismaClient,
  input: { holdId: string; senderAccountId: string; expired?: boolean },
) {
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "EscrowHold" WHERE "id" = ${input.holdId}::uuid FOR UPDATE`);
    const hold = await tx.escrowHold.findUniqueOrThrow({ where: { id: input.holdId } });
    const expired = input.expired || hold.expiresAt <= new Date();
    return cancelLockedHold(
      tx,
      hold,
      input.senderAccountId,
      TransactionType.ESCROW_CANCEL,
      `escrow:${hold.id}:cancel`,
      expired ? EscrowStatus.EXPIRED : EscrowStatus.CANCELLED,
    );
  });
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
    cooldownHours: number;
  },
) {
  evmAddressSchema.parse(input.destinationAddress);
  const quote = withdrawalQuote(input.couponsGross, input.baseFeeBps, input.minimumWithdrawalMicroUsdt);
  const withdrawalId = randomUUID();
  const status = quote.netMicroUsdt <= input.autoApprovalLimitMicroUsdt
    ? WithdrawalStatus.APPROVED
    : WithdrawalStatus.PENDING_APPROVAL;
  const transactionStatus = status === WithdrawalStatus.APPROVED ? TransactionStatus.APPROVED : TransactionStatus.PENDING_APPROVAL;
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await assertNotRestricted(tx, input.userId);
    const availability = await readWithdrawalAvailabilityInTransaction(tx, input.userId);
    if (availability.blockers.includes('pending_code')) throw new DomainError('withdrawal blocked by pending code');
    if (availability.blockers.includes('unresolved_claim')) throw new DomainError('withdrawal blocked by unresolved claim');
    if (input.couponsGross > availability.availableToWithdrawCoupons) throw new DomainError('withdrawal exceeds available balance');
    if (input.cooldownHours < 0) throw new DomainError('withdrawal cooldown must be non-negative');
    const eligibleAt = new Date(Date.now() + input.cooldownHours * 60 * 60 * 1000);
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
        eligibleAt,
      },
    });
  });
}

type WithdrawalPostingInput = {
  withdrawalId: string;
  userAccountId: string;
  vaultAccountId: string;
  feeAccountId: string;
  pendingAccountId: string;
  issuanceAccountId: string;
  audit?: AdminAuditInput;
};

export type AdminAuditInput = {
  adminUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: string;
  newValue?: string;
};

async function createAdminAudit(tx: Prisma.TransactionClient, audit: AdminAuditInput): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminUserId: audit.adminUserId,
      action: audit.action,
      entityType: audit.entityType,
      entityId: audit.entityId,
      ...(audit.oldValue === undefined ? {} : { oldValue: audit.oldValue }),
      ...(audit.newValue === undefined ? {} : { newValue: audit.newValue }),
    },
  });
}

async function refundWithdrawalLocked(
  tx: Prisma.TransactionClient,
  input: WithdrawalPostingInput,
  finalStatus: WithdrawalStatus,
) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Withdrawal" WHERE "id" = ${input.withdrawalId}::uuid FOR UPDATE`);
  const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: input.withdrawalId } });
  if (withdrawal.chainTxHash !== null) throw new DomainError('withdrawal cannot be refunded in its current state');
  if (withdrawal.status === WithdrawalStatus.REFUNDED) return withdrawal;
  if (withdrawal.status === WithdrawalStatus.REJECTED) throw new DomainError('withdrawal cannot be refunded in its current state');
  if (
    (withdrawal.status !== WithdrawalStatus.PENDING_APPROVAL &&
      withdrawal.status !== WithdrawalStatus.APPROVED &&
      withdrawal.status !== WithdrawalStatus.FAILED)
  ) {
    throw new DomainError('withdrawal cannot be refunded in its current state');
  }
  await postWithClient(tx, {
    type: TransactionType.REFUND,
    externalRef: `withdrawal:${withdrawal.id}:refund`,
    userId: withdrawal.userId,
    status: TransactionStatus.CONFIRMED,
    amountMicroUsdt: withdrawal.grossMicroUsdt,
    amountCoupons: withdrawal.couponsGross,
    feeMicroUsdt: withdrawal.feeMicroUsdt,
    legs: [
      { fromAccountId: input.pendingAccountId, toAccountId: input.vaultAccountId, amount: withdrawal.netMicroUsdt, asset: Asset.USDT },
      ...(withdrawal.feeMicroUsdt > 0n ? [{ fromAccountId: input.feeAccountId, toAccountId: input.vaultAccountId, amount: withdrawal.feeMicroUsdt, asset: Asset.USDT }] : []),
      { fromAccountId: input.issuanceAccountId, toAccountId: input.userAccountId, amount: withdrawal.couponsGross, asset: Asset.COUPON },
    ],
  });
  return tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: finalStatus } });
}

export async function refundWithdrawal(prisma: PrismaClient, input: WithdrawalPostingInput) {
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => refundWithdrawalLocked(tx, input, WithdrawalStatus.REFUNDED));
}

export async function rejectWithdrawal(prisma: PrismaClient, input: WithdrawalPostingInput) {
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: input.withdrawalId } });
    if (withdrawal.status !== WithdrawalStatus.PENDING_APPROVAL && withdrawal.status !== WithdrawalStatus.APPROVED) {
      throw new DomainError('withdrawal cannot be rejected in its current state');
    }
    const result = await refundWithdrawalLocked(tx, input, WithdrawalStatus.REJECTED);
    await tx.transaction.update({
      where: { id: withdrawal.transactionId },
      data: { status: TransactionStatus.REJECTED },
    });
    if (input.audit !== undefined) await createAdminAudit(tx, input.audit);
    return result;
  });
}

export function calculateSolvency(input: {
  issuanceBalance: bigint;
  totalDustMicroUsdt: bigint;
  vaultBalance: bigint;
  withdrawalPendingBalance: bigint;
  feeBalance: bigint;
}) {
  const couponLiability = -input.issuanceBalance * 10_000n;
  const custodyMicroUsdt = input.vaultBalance + input.withdrawalPendingBalance + input.feeBalance;
  const obligationsMicroUsdt = couponLiability + input.totalDustMicroUsdt + input.withdrawalPendingBalance;
  return {
    custodyMicroUsdt,
    obligationsMicroUsdt,
    surplusMicroUsdt: custodyMicroUsdt - obligationsMicroUsdt,
    isSolvent: custodyMicroUsdt >= obligationsMicroUsdt,
  };
}

export async function readSolvency(prisma: PrismaClient) {
  const issuance = await prisma.ledgerAccount.findFirstOrThrow({
    where: { type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON, userId: null },
  });
  const vault = await prisma.ledgerAccount.findFirstOrThrow({
    where: { type: AccountType.SYSTEM_VAULT_USDT, asset: Asset.USDT, userId: null },
  });
  const pending = await prisma.ledgerAccount.findFirstOrThrow({
    where: { type: AccountType.SYSTEM_WITHDRAWAL_PENDING, asset: Asset.USDT, userId: null },
  });
  const fees = await prisma.ledgerAccount.findFirstOrThrow({
    where: { type: AccountType.SYSTEM_FEE_COLLECTION, asset: Asset.USDT, userId: null },
  });
  const dust = await prisma.user.aggregate({ _sum: { dustMicroUsdt: true } });
  return calculateSolvency({
    issuanceBalance: issuance.balance,
    totalDustMicroUsdt: dust._sum.dustMicroUsdt ?? 0n,
    vaultBalance: vault.balance,
    withdrawalPendingBalance: pending.balance,
    feeBalance: fees.balance,
  });
}

export { AccountType, Asset };
