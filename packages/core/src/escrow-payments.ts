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
  PurchaseGuaranteeStatus,
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '@trustme/db';
import { postDepositCouponCredit } from './domain.js';
import { postWithClient } from './ledger.js';
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

export async function lockBalance(tx: Prisma.TransactionClient, userId: string) {
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
  input: {
    buyerId: string;
    code: string;
    maxAmountMicroUsdt: bigint;
    expiresAt: Date;
    merchantId?: string;
    amountMicroUsdt?: bigint;
  },
) {
  fourDigitCodeSchema.parse(input.code);
  if (input.maxAmountMicroUsdt <= 0n) throw new DomainError('pay code amount must be positive');
  if (input.expiresAt <= new Date()) throw new DomainError('pay code expiry must be in the future');
  if (input.merchantId !== undefined) {
    if (input.merchantId === input.buyerId) throw new DomainError('buyer and merchant must be different');
    if (input.amountMicroUsdt === undefined) throw new DomainError('directed pay code amount is required');
    if (input.amountMicroUsdt <= 0n) throw new DomainError('pay code amount must be positive');
    if (input.amountMicroUsdt > input.maxAmountMicroUsdt) throw new DomainError('pay code amount exceeds maximum');
  }
  const id = randomUUID();
  const codeHash = await bcrypt.hash(input.code, 10);
  return withSerializableRetry(prisma, async (tx) => {
    const balance = await lockBalance(tx, input.buyerId);
    let guaranteeId: string | null = null;
    if (input.maxAmountMicroUsdt > availableEscrowMicroUsdt(balance)) {
      const guarantees = await activeGuaranteesFor(tx, input.buyerId);
      const guarantee = guarantees.find((candidate) => candidate.remainingMicroUsdt >= input.maxAmountMicroUsdt);
      if (guarantee === undefined) throw new DomainError('pay code exceeds available escrow');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseGuarantee" WHERE "id" = ${guarantee.id}::uuid FOR UPDATE`);
      guaranteeId = guarantee.id;
    }
    await tx.payCode.updateMany({ where: { buyerId: input.buyerId, status: PayCodeStatus.ACTIVE }, data: { status: PayCodeStatus.CANCELLED } });
    return tx.payCode.create({
      data: {
        id,
        buyerId: input.buyerId,
        ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId, amountMicroUsdt: input.amountMicroUsdt }),
        guaranteeId,
        codeHash,
        maxAmountMicroUsdt: input.merchantId === undefined ? input.maxAmountMicroUsdt : input.amountMicroUsdt!,
        expiresAt: input.expiresAt,
      },
    });
  });
}

export async function activeGuaranteesFor(tx: Prisma.TransactionClient, beneficiaryId: string) {
  return tx.purchaseGuarantee.findMany({
    where: { beneficiaryId, status: PurchaseGuaranteeStatus.ACTIVE, remainingMicroUsdt: { gt: 0n } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

async function settlePayCode(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    buyerId: string;
    payCode: { id: string; codeHash: string; maxAmountMicroUsdt: bigint; guaranteeId: string | null };
    amountMicroUsdt: bigint;
    externalRef?: string;
  },
) {
  let payerId = input.buyerId;
  let guarantee: { id: string; guarantorId: string; remainingMicroUsdt: bigint; status: PurchaseGuaranteeStatus } | null = null;
  if (input.payCode.guaranteeId === null) {
    const balance = await lockBalance(tx, input.buyerId);
    if (input.amountMicroUsdt > availableEscrowMicroUsdt(balance)) throw new DomainError('settlement exceeds available escrow');
  } else {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseGuarantee" WHERE "id" = ${input.payCode.guaranteeId}::uuid FOR UPDATE`);
    guarantee = await tx.purchaseGuarantee.findUnique({ where: { id: input.payCode.guaranteeId }, select: { id: true, guarantorId: true, remainingMicroUsdt: true, status: true } });
    if (guarantee === null || guarantee.status !== PurchaseGuaranteeStatus.ACTIVE || guarantee.remainingMicroUsdt < input.amountMicroUsdt) {
      throw new DomainError('guarantee no longer covers this amount');
    }
    payerId = guarantee.guarantorId;
  }
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
    commissionFor: { buyerId: input.buyerId },
  });
  const settlement = await tx.escrowSettlement.create({
    data: {
      id: settlementId,
      buyerId: input.buyerId,
      payerId,
      merchantId: input.merchantId,
      payCodeId: input.payCode.id,
      guaranteeId: input.payCode.guaranteeId,
      amountMicroUsdt: input.amountMicroUsdt,
      ref: escrowReference('settlement', settlementId),
      ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
      transactionId: transaction.id,
    },
  });
  await tx.payCode.update({ where: { id: input.payCode.id }, data: { status: PayCodeStatus.USED, usedAt: new Date() } });
  if (input.payCode.guaranteeId === null) {
    await tx.escrowBalance.update({ where: { userId: input.buyerId }, data: { reservedMicroUsdt: { increment: input.amountMicroUsdt } } });
  } else {
    await tx.purchaseGuarantee.update({
      where: { id: input.payCode.guaranteeId },
      data: {
        remainingMicroUsdt: { decrement: input.amountMicroUsdt },
        ...(input.amountMicroUsdt === guarantee!.remainingMicroUsdt ? { status: PurchaseGuaranteeStatus.EXHAUSTED } : {}),
      },
    });
  }
  const buyer = await tx.user.findUniqueOrThrow({ where: { id: input.buyerId }, select: { id: true, barcodeId: true, displayName: true } });
  return { settlement, buyer, merchantId: input.merchantId };
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
    if (payCode.merchantId !== null && payCode.merchantId !== input.merchantId) throw new DomainError('no active pay code');
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
    return settlePayCode(tx, {
      merchantId: input.merchantId,
      buyerId: buyer.id,
      payCode,
      amountMicroUsdt: input.amountMicroUsdt,
      ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
    });
  });
  if ('error' in result) throw new DomainError(result.error);
  return result;
}

export async function settleDirectedPayCode(
  prisma: PrismaClient,
  input: { merchantId: string; payCodeId: string; code: string; externalRef?: string },
) {
  fourDigitCodeSchema.parse(input.code);
  const result = await withSerializableRetry(prisma, async (tx) => {
    if (input.externalRef !== undefined) {
      const existing = await tx.escrowSettlement.findUnique({
        where: { externalRef: input.externalRef },
        include: { buyer: { select: { id: true, barcodeId: true, displayName: true } } },
      });
      if (existing !== null) return { settlement: existing, buyer: existing.buyer, merchantId: input.merchantId };
    }
    const payCode = await tx.payCode.findUnique({ where: { id: input.payCodeId } });
    if (payCode === null || payCode.merchantId !== input.merchantId || payCode.status !== PayCodeStatus.ACTIVE) throw new DomainError('pay code not found', 404);
    if (payCode.expiresAt <= new Date()) {
      await tx.payCode.update({ where: { id: payCode.id }, data: { status: PayCodeStatus.EXPIRED } });
      return { error: 'pay code has expired' as const };
    }
    const valid = await bcrypt.compare(input.code, payCode.codeHash);
    if (!valid) {
      const wrongAttempts = payCode.wrongAttempts + 1;
      await tx.payCode.update({ where: { id: payCode.id }, data: { wrongAttempts, status: wrongAttempts >= 3 ? PayCodeStatus.CANCELLED : PayCodeStatus.ACTIVE } });
      return { error: wrongAttempts >= 3 ? 'pay code cancelled after too many attempts' : 'invalid pay code' };
    }
    if (payCode.amountMicroUsdt === null) throw new DomainError('pay code amount is missing');
    return settlePayCode(tx, {
      merchantId: input.merchantId,
      buyerId: payCode.buyerId,
      payCode,
      amountMicroUsdt: payCode.amountMicroUsdt,
      ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
    });
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
    const balance = await lockBalance(tx, settlement.payerId);
    if (balance.reservedMicroUsdt < settlement.amountMicroUsdt || balance.lockedMicroUsdt < settlement.amountMicroUsdt) {
      throw new DomainError('escrow balance is inconsistent');
    }
    await tx.escrowBalance.update({
      where: { userId: settlement.payerId },
      data: { lockedMicroUsdt: { decrement: settlement.amountMicroUsdt }, reservedMicroUsdt: { decrement: settlement.amountMicroUsdt } },
    });
    return tx.escrowSettlement.update({
      where: { id: settlement.id },
      data: { status: EscrowSettlementStatus.CONFIRMED, chainTxHash: input.txHash, confirmedAt: new Date() },
    });
  });
}

async function restoreOrReleaseGuarantee(
  tx: Prisma.TransactionClient,
  settlement: { payerId: string; guaranteeId: string; amountMicroUsdt: bigint },
  release: bigint,
) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseGuarantee" WHERE "id" = ${settlement.guaranteeId}::uuid FOR UPDATE`);
  const guarantee = await tx.purchaseGuarantee.findUniqueOrThrow({ where: { id: settlement.guaranteeId } });
  if (guarantee.status === PurchaseGuaranteeStatus.REVOKED) {
    await tx.escrowBalance.update({
      where: { userId: settlement.payerId },
      data: { reservedMicroUsdt: { decrement: release } },
    });
    return;
  }
  await tx.purchaseGuarantee.update({
    where: { id: guarantee.id },
    data: { remainingMicroUsdt: { increment: settlement.amountMicroUsdt }, status: PurchaseGuaranteeStatus.ACTIVE },
  });
}

export async function failSettlement(prisma: PrismaClient, input: { settlementId: string; error: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    const settlement = await tx.escrowSettlement.findUnique({ where: { id: input.settlementId } });
    if (settlement === null) throw new DomainError('settlement not found', 404);
    if (settlement.status === EscrowSettlementStatus.CONFIRMED) return settlement;
    const balance = await lockBalance(tx, settlement.payerId);
    const release = settlement.amountMicroUsdt <= balance.reservedMicroUsdt ? settlement.amountMicroUsdt : balance.reservedMicroUsdt;
    let lastError = input.error;
    if (settlement.transactionId !== null) {
      const original = await tx.transaction.findUniqueOrThrow({ where: { id: settlement.transactionId } });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${settlement.merchantId}::uuid FOR UPDATE`);
      const merchant = await tx.user.findUniqueOrThrow({ where: { id: settlement.merchantId } });
      const newDust = merchant.dustMicroUsdt + original.amountCoupons * 10_000n - settlement.amountMicroUsdt;
      try {
        if (newDust < 0n) throw new DomainError('manual handling is needed: merchant dust would become negative');
        if (original.amountCoupons > 0n) {
          const originalEntries = await tx.ledgerEntry.findMany({
            where: { transactionId: original.id, asset: Asset.COUPON },
            select: { fromAccountId: true, toAccountId: true, amount: true, asset: true },
          });
          await postWithClient(tx, {
            type: TransactionType.REFUND,
            externalRef: `escrow:settle-reverse:${settlement.id}`,
            userId: settlement.merchantId,
            status: TransactionStatus.CONFIRMED,
            amountMicroUsdt: settlement.amountMicroUsdt,
            amountCoupons: original.amountCoupons,
            roundingDustMicroUsdt: original.roundingDustMicroUsdt,
            legs: originalEntries.map((entry) => ({
              fromAccountId: entry.toAccountId,
              toAccountId: entry.fromAccountId,
              amount: entry.amount,
              asset: entry.asset,
            })),
          });
        }
        await tx.user.update({ where: { id: settlement.merchantId }, data: { dustMicroUsdt: newDust } });
      } catch (error) {
        lastError = `${input.error}; reversal failed: ${error instanceof Error ? error.message : String(error)}; manual handling is needed`;
        if (settlement.guaranteeId === null) {
          await tx.escrowBalance.update({ where: { userId: settlement.payerId }, data: { reservedMicroUsdt: { decrement: release } } });
        }
        if (settlement.guaranteeId !== null) {
          await restoreOrReleaseGuarantee(tx, { payerId: settlement.payerId, guaranteeId: settlement.guaranteeId, amountMicroUsdt: settlement.amountMicroUsdt }, release);
        }
        return tx.escrowSettlement.update({ where: { id: settlement.id }, data: { status: EscrowSettlementStatus.FAILED, lastError } });
      }
    }
    if (settlement.guaranteeId === null) {
      await tx.escrowBalance.update({ where: { userId: settlement.payerId }, data: { reservedMicroUsdt: { decrement: release } } });
    }
    if (settlement.guaranteeId !== null) {
      await restoreOrReleaseGuarantee(tx, { payerId: settlement.payerId, guaranteeId: settlement.guaranteeId, amountMicroUsdt: settlement.amountMicroUsdt }, release);
    }
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

export async function applyEscrowChainEvent(
  prisma: PrismaClient,
  event: EscrowChainEventInput,
  log: Pick<Console, 'error'> = console,
) {
  evmAddressSchema.parse(event.walletAddress);
  if (event.amountMicroUsdt <= 0n) throw new DomainError('chain event amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    const existing = await tx.escrowChainEvent.findUnique({ where: { txHash_logIndex: { txHash: event.txHash, logIndex: event.logIndex } } });
    const wallet = await tx.memberWallet.findUnique({ where: { address: event.walletAddress.toLowerCase() } });
    const userId = wallet?.userId;
    if (existing !== null && existing.reconciledAt !== null) return existing;
    const recorded = existing ?? await tx.escrowChainEvent.create({
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
    const markReconciled = () => tx.escrowChainEvent.update({ where: { id: recorded.id }, data: { reconciledAt: new Date() } });
    if (event.kind === EscrowEventKind.DEPOSIT) {
      if (userId === undefined) {
        log.error(`unreconciled escrow deposit event ${event.txHash}:${event.logIndex}: wallet is not registered`);
        return recorded;
      }
      await lockBalance(tx, userId);
      await tx.escrowBalance.update({ where: { userId }, data: { lockedMicroUsdt: { increment: event.amountMicroUsdt }, lastEventAt: new Date() } });
      return markReconciled();
    }
    if (event.ref === undefined) {
      log.error(`unreconciled escrow ${event.kind.toLowerCase()} event ${event.txHash}:${event.logIndex}: reference is missing`);
      return recorded;
    }
    if (event.kind === EscrowEventKind.SETTLE) {
      const settlement = await tx.escrowSettlement.findUnique({ where: { ref: event.ref } });
      if (settlement === null) {
        log.error(`unreconciled escrow settlement event ${event.txHash}:${event.logIndex}: reference ${event.ref} is unknown`);
        return recorded;
      }
      if (settlement.amountMicroUsdt !== event.amountMicroUsdt) {
        log.error(`unreconciled escrow settlement event ${event.txHash}:${event.logIndex}: amount does not match reference ${event.ref}`);
        return recorded;
      }
      if (settlement.status === EscrowSettlementStatus.PENDING) {
        const balance = await lockBalance(tx, settlement.payerId);
        if (balance.lockedMicroUsdt < settlement.amountMicroUsdt || balance.reservedMicroUsdt < settlement.amountMicroUsdt) {
          log.error(`unreconciled escrow settlement event ${event.txHash}:${event.logIndex}: escrow balance is inconsistent`);
          return recorded;
        }
        await tx.escrowBalance.update({ where: { userId: settlement.payerId }, data: { lockedMicroUsdt: { decrement: settlement.amountMicroUsdt }, reservedMicroUsdt: { decrement: settlement.amountMicroUsdt } } });
        await tx.escrowSettlement.update({ where: { id: settlement.id }, data: { status: EscrowSettlementStatus.CONFIRMED, chainTxHash: event.txHash, confirmedAt: new Date() } });
      }
      return markReconciled();
    }
    const unload = await tx.escrowUnload.findUnique({ where: { ref: event.ref } });
    if (unload === null) {
      log.error(`unreconciled escrow unload event ${event.txHash}:${event.logIndex}: reference ${event.ref} is unknown`);
      return recorded;
    }
    if (unload.amountMicroUsdt !== event.amountMicroUsdt) {
      log.error(`unreconciled escrow unload event ${event.txHash}:${event.logIndex}: amount does not match reference ${event.ref}`);
      return recorded;
    }
    if (unload.status === EscrowUnloadStatus.PENDING) {
      const balance = await lockBalance(tx, unload.userId);
      if (balance.lockedMicroUsdt < unload.amountMicroUsdt || balance.reservedMicroUsdt < unload.amountMicroUsdt) {
        log.error(`unreconciled escrow unload event ${event.txHash}:${event.logIndex}: escrow balance is inconsistent`);
        return recorded;
      }
      await tx.escrowBalance.update({ where: { userId: unload.userId }, data: { lockedMicroUsdt: { decrement: unload.amountMicroUsdt }, reservedMicroUsdt: { decrement: unload.amountMicroUsdt } } });
      await tx.escrowUnload.update({ where: { id: unload.id }, data: { status: EscrowUnloadStatus.CONFIRMED, chainTxHash: event.txHash, confirmedAt: new Date() } });
    }
    return markReconciled();
  });
}
