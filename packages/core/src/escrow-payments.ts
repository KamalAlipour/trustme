import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  AccountType,
  Asset,
  EscrowEventKind,
  EscrowSettlementStatus,
  EscrowUnloadStatus,
  PayCodeStatus,
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '@trustme/db';
import { postDepositCouponCredit } from './domain.js';
import { postWithClient } from './ledger.js';
import { couponsFromMicroUsdt } from './money.js';
import { withSerializableRetry } from './retry.js';
import { evmAddressSchema, fourDigitCodeSchema } from './schemas.js';
import { DomainError } from './domain-error.js';

export type EscrowBalanceValue = { lockedMicroUsdt: bigint; reservedMicroUsdt: bigint };

export function availableEscrowMicroUsdt(balance: EscrowBalanceValue): bigint {
  const available = balance.lockedMicroUsdt - balance.reservedMicroUsdt;
  return available > 0n ? available : 0n;
}

export function escrowReference(prefix: 'settlement' | 'unload', id: string): string {
  return keccak256(toUtf8Bytes(`${prefix}:${id}`));
}

async function lockBalance(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "userId" FROM "EscrowBalance" WHERE "userId" = ${userId}::uuid FOR UPDATE`);
  return tx.escrowBalance.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

async function userCouponAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}

async function issuanceAccount(tx: Prisma.TransactionClient) {
  return tx.ledgerAccount.findFirstOrThrow({ where: { userId: null, type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON } });
}

export async function createPayCode(
  prisma: PrismaClient,
  input: { buyerId: string; code: string; maxAmountMicroUsdt: bigint; expiresAt: Date },
) {
  fourDigitCodeSchema.parse(input.code);
  if (input.maxAmountMicroUsdt <= 0n) throw new DomainError('pay code amount must be positive');
  if (input.expiresAt <= new Date()) throw new DomainError('pay code expiry must be in the future');
  const id = randomUUID();
  const codeHash = await bcrypt.hash(input.code, 10);
  return withSerializableRetry(prisma, async (tx) => {
    const balance = await lockBalance(tx, input.buyerId);
    if (input.maxAmountMicroUsdt > availableEscrowMicroUsdt(balance)) throw new DomainError('pay code exceeds available escrow');
    await tx.payCode.updateMany({ where: { buyerId: input.buyerId, status: PayCodeStatus.ACTIVE }, data: { status: PayCodeStatus.CANCELLED } });
    return tx.payCode.create({
      data: { id, buyerId: input.buyerId, codeHash, maxAmountMicroUsdt: input.maxAmountMicroUsdt, expiresAt: input.expiresAt },
    });
  });
}

export async function settleWithPayCode(
  prisma: PrismaClient,
  input: { merchantId: string; buyerBarcodeId: string; code: string; amountMicroUsdt: bigint; externalRef?: string },
) {
  fourDigitCodeSchema.parse(input.code);
  if (input.amountMicroUsdt <= 0n) throw new DomainError('settlement amount must be positive');
  const result = await withSerializableRetry(prisma, async (tx) => {
    if (input.externalRef !== undefined) {
      const existing = await tx.escrowSettlement.findUnique({
        where: { externalRef: input.externalRef },
        include: { buyer: { select: { id: true, barcodeId: true, displayName: true } } },
      });
      if (existing !== null) return { settlement: existing, buyer: existing.buyer, merchantId: input.merchantId };
    }
    const buyer = await tx.user.findUnique({ where: { barcodeId: input.buyerBarcodeId } });
    if (buyer === null) throw new DomainError('buyer not found', 404);
    if (buyer.id === input.merchantId) throw new DomainError('buyer and merchant must be different');
    const payCode = await tx.payCode.findFirst({ where: { buyerId: buyer.id, status: PayCodeStatus.ACTIVE }, orderBy: { createdAt: 'desc' } });
    if (payCode === null) throw new DomainError('no active pay code');
    if (payCode.expiresAt <= new Date()) {
      await tx.payCode.update({ where: { id: payCode.id }, data: { status: PayCodeStatus.EXPIRED } });
      return { error: 'pay code has expired' as const };
    }
    const valid = await bcrypt.compare(input.code, payCode.codeHash);
    if (!valid) {
      const wrongAttempts = payCode.wrongAttempts + 1;
      await tx.payCode.update({
        where: { id: payCode.id },
        data: { wrongAttempts, status: wrongAttempts >= 3 ? PayCodeStatus.CANCELLED : PayCodeStatus.ACTIVE },
      });
      return { error: wrongAttempts >= 3 ? 'pay code cancelled after too many attempts' : 'invalid pay code' };
    }
    if (input.amountMicroUsdt > payCode.maxAmountMicroUsdt) throw new DomainError('settlement exceeds pay code amount');
    const balance = await lockBalance(tx, buyer.id);
    if (input.amountMicroUsdt > availableEscrowMicroUsdt(balance)) throw new DomainError('settlement exceeds available escrow');
    const settlementId = randomUUID();
    const merchantAccount = await userCouponAccount(tx, input.merchantId);
    const issuance = await issuanceAccount(tx);
    const transaction = await postDepositCouponCredit(tx, {
      externalRef: `escrow:settle:${settlementId}`,
      userId: input.merchantId,
      userCouponAccountId: merchantAccount.id,
      issuanceAccountId: issuance.id,
      amountMicroUsdt: input.amountMicroUsdt,
      type: TransactionType.DEPOSIT,
    });
    const settlement = await tx.escrowSettlement.create({
      data: {
        id: settlementId,
        buyerId: buyer.id,
        merchantId: input.merchantId,
        payCodeId: payCode.id,
        amountMicroUsdt: input.amountMicroUsdt,
        ref: escrowReference('settlement', settlementId),
        ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
        transactionId: transaction.id,
      },
    });
    await tx.payCode.update({ where: { id: payCode.id }, data: { status: PayCodeStatus.USED, usedAt: new Date() } });
    await tx.escrowBalance.update({ where: { userId: buyer.id }, data: { reservedMicroUsdt: { increment: input.amountMicroUsdt } } });
    return { settlement, buyer: { id: buyer.id, barcodeId: buyer.barcodeId, displayName: buyer.displayName }, merchantId: input.merchantId };
  });
  if ('error' in result) throw new DomainError(result.error);
  return result;
}

export async function confirmSettlement(prisma: PrismaClient, input: { ref: string; txHash: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    const settlement = await tx.escrowSettlement.findUnique({ where: { ref: input.ref } });
    if (settlement === null) throw new DomainError('settlement not found', 404);
    if (settlement.status === EscrowSettlementStatus.CONFIRMED) return settlement;
    if (settlement.status === EscrowSettlementStatus.FAILED) throw new DomainError('settlement has failed');
    const balance = await lockBalance(tx, settlement.buyerId);
    if (balance.reservedMicroUsdt < settlement.amountMicroUsdt || balance.lockedMicroUsdt < settlement.amountMicroUsdt) {
      throw new DomainError('escrow balance is inconsistent');
    }
    await tx.escrowBalance.update({
      where: { userId: settlement.buyerId },
      data: { lockedMicroUsdt: { decrement: settlement.amountMicroUsdt }, reservedMicroUsdt: { decrement: settlement.amountMicroUsdt } },
    });
    return tx.escrowSettlement.update({
      where: { id: settlement.id },
      data: { status: EscrowSettlementStatus.CONFIRMED, chainTxHash: input.txHash, confirmedAt: new Date() },
    });
  });
}

export async function failSettlement(prisma: PrismaClient, input: { settlementId: string; error: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    const settlement = await tx.escrowSettlement.findUnique({ where: { id: input.settlementId } });
    if (settlement === null) throw new DomainError('settlement not found', 404);
    if (settlement.status === EscrowSettlementStatus.CONFIRMED) return settlement;
    const balance = await lockBalance(tx, settlement.buyerId);
    const release = settlement.amountMicroUsdt <= balance.reservedMicroUsdt ? settlement.amountMicroUsdt : balance.reservedMicroUsdt;
    let lastError = input.error;
    if (settlement.transactionId !== null) {
      const original = await tx.transaction.findUniqueOrThrow({ where: { id: settlement.transactionId } });
      const merchantAccount = await userCouponAccount(tx, settlement.merchantId);
      const issuance = await issuanceAccount(tx);
      try {
        if (original.amountCoupons > 0n) {
          await postWithClient(tx, {
            type: TransactionType.REFUND,
            externalRef: `escrow:settle-reverse:${settlement.id}`,
            userId: settlement.merchantId,
            status: TransactionStatus.CONFIRMED,
            amountMicroUsdt: settlement.amountMicroUsdt,
            amountCoupons: original.amountCoupons,
            roundingDustMicroUsdt: original.roundingDustMicroUsdt,
            legs: [{ fromAccountId: merchantAccount.id, toAccountId: issuance.id, amount: original.amountCoupons, asset: Asset.COUPON }],
          });
        }
        const previousDust = (original.roundingDustMicroUsdt + 10_000n - (settlement.amountMicroUsdt % 10_000n)) % 10_000n;
        await tx.user.update({ where: { id: settlement.merchantId }, data: { dustMicroUsdt: previousDust } });
      } catch (error) {
        lastError = `${input.error}; reversal failed: ${error instanceof Error ? error.message : String(error)}`;
        await tx.escrowBalance.update({ where: { userId: settlement.buyerId }, data: { reservedMicroUsdt: { decrement: release } } });
        return tx.escrowSettlement.update({ where: { id: settlement.id }, data: { status: EscrowSettlementStatus.FAILED, lastError } });
      }
    }
    await tx.escrowBalance.update({ where: { userId: settlement.buyerId }, data: { reservedMicroUsdt: { decrement: release } } });
    return tx.escrowSettlement.update({ where: { id: settlement.id }, data: { status: EscrowSettlementStatus.FAILED, lastError } });
  });
}

export async function requestUnload(prisma: PrismaClient, input: { userId: string; amountMicroUsdt: bigint }) {
  if (input.amountMicroUsdt <= 0n) throw new DomainError('unload amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    const wallet = await tx.memberWallet.findFirst({ where: { userId: input.userId, isPrimary: true } });
    if (wallet === null) throw new DomainError('primary wallet is required');
    const balance = await lockBalance(tx, input.userId);
    if (input.amountMicroUsdt > availableEscrowMicroUsdt(balance)) throw new DomainError('unload exceeds available escrow');
    const id = randomUUID();
    const unload = await tx.escrowUnload.create({
      data: { id, userId: input.userId, walletAddress: wallet.address, amountMicroUsdt: input.amountMicroUsdt, ref: escrowReference('unload', id) },
    });
    await tx.escrowBalance.update({ where: { userId: input.userId }, data: { reservedMicroUsdt: { increment: input.amountMicroUsdt } } });
    return unload;
  });
}

export async function confirmUnload(prisma: PrismaClient, input: { ref: string; txHash: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    const unload = await tx.escrowUnload.findUnique({ where: { ref: input.ref } });
    if (unload === null) throw new DomainError('unload not found', 404);
    if (unload.status === EscrowUnloadStatus.CONFIRMED) return unload;
    if (unload.status === EscrowUnloadStatus.FAILED) throw new DomainError('unload has failed');
    await lockBalance(tx, unload.userId);
    await tx.escrowBalance.update({
      where: { userId: unload.userId },
      data: { lockedMicroUsdt: { decrement: unload.amountMicroUsdt }, reservedMicroUsdt: { decrement: unload.amountMicroUsdt } },
    });
    return tx.escrowUnload.update({ where: { id: unload.id }, data: { status: EscrowUnloadStatus.CONFIRMED, chainTxHash: input.txHash, confirmedAt: new Date() } });
  });
}

export async function failUnload(prisma: PrismaClient, input: { unloadId: string; error: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    const unload = await tx.escrowUnload.findUnique({ where: { id: input.unloadId } });
    if (unload === null) throw new DomainError('unload not found', 404);
    if (unload.status !== EscrowUnloadStatus.PENDING) return unload;
    const balance = await lockBalance(tx, unload.userId);
    const release = unload.amountMicroUsdt <= balance.reservedMicroUsdt ? unload.amountMicroUsdt : balance.reservedMicroUsdt;
    await tx.escrowBalance.update({ where: { userId: unload.userId }, data: { reservedMicroUsdt: { decrement: release } } });
    return tx.escrowUnload.update({ where: { id: unload.id }, data: { status: EscrowUnloadStatus.FAILED, lastError: input.error } });
  });
}

export type EscrowChainEventInput = {
  kind: EscrowEventKind;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  walletAddress: string;
  amountMicroUsdt: bigint;
  ref?: string;
};

export async function applyEscrowChainEvent(prisma: PrismaClient, event: EscrowChainEventInput) {
  evmAddressSchema.parse(event.walletAddress);
  if (event.amountMicroUsdt <= 0n) throw new DomainError('chain event amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    const existing = await tx.escrowChainEvent.findUnique({ where: { txHash_logIndex: { txHash: event.txHash, logIndex: event.logIndex } } });
    if (existing !== null) return existing;
    const wallet = await tx.memberWallet.findUnique({ where: { address: event.walletAddress.toLowerCase() } });
    const userId = wallet?.userId;
    const recorded = await tx.escrowChainEvent.create({
      data: {
        kind: event.kind,
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        walletAddress: event.walletAddress.toLowerCase(),
        amountMicroUsdt: event.amountMicroUsdt,
        ...(event.ref === undefined ? {} : { ref: event.ref }),
        ...(userId === undefined ? {} : { userId }),
      },
    });
    if (event.kind === EscrowEventKind.DEPOSIT) {
      if (userId !== undefined) {
        await lockBalance(tx, userId);
        await tx.escrowBalance.update({ where: { userId }, data: { lockedMicroUsdt: { increment: event.amountMicroUsdt }, lastEventAt: new Date() } });
      }
    } else if (event.ref !== undefined) {
      if (event.kind === EscrowEventKind.SETTLE) {
        const settlement = await tx.escrowSettlement.findUnique({ where: { ref: event.ref } });
        if (settlement === null || settlement.amountMicroUsdt !== event.amountMicroUsdt) throw new DomainError('settlement event does not match');
        if (settlement.status === EscrowSettlementStatus.PENDING) {
          await lockBalance(tx, settlement.buyerId);
          await tx.escrowBalance.update({ where: { userId: settlement.buyerId }, data: { lockedMicroUsdt: { decrement: settlement.amountMicroUsdt }, reservedMicroUsdt: { decrement: settlement.amountMicroUsdt } } });
          await tx.escrowSettlement.update({ where: { id: settlement.id }, data: { status: EscrowSettlementStatus.CONFIRMED, chainTxHash: event.txHash, confirmedAt: new Date() } });
        }
      } else {
        const unload = await tx.escrowUnload.findUnique({ where: { ref: event.ref } });
        if (unload === null || unload.amountMicroUsdt !== event.amountMicroUsdt) throw new DomainError('unload event does not match');
        if (unload.status === EscrowUnloadStatus.PENDING) {
          await lockBalance(tx, unload.userId);
          await tx.escrowBalance.update({ where: { userId: unload.userId }, data: { lockedMicroUsdt: { decrement: unload.amountMicroUsdt }, reservedMicroUsdt: { decrement: unload.amountMicroUsdt } } });
          await tx.escrowUnload.update({ where: { id: unload.id }, data: { status: EscrowUnloadStatus.CONFIRMED, chainTxHash: event.txHash, confirmedAt: new Date() } });
        }
      }
    }
    return recorded;
  });
}

export function couponAmountForEscrow(microUsdt: bigint): bigint {
  return couponsFromMicroUsdt(microUsdt);
}
