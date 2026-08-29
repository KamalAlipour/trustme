import { randomInt, timingSafeEqual } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AccountType, Asset, BalanceDisclosureStatus, Prisma, PrismaClient, TransactionStatus, TransactionType } from '@trustme/db';
import { barcodeIdSchema, decimalFromMicroUsdt, readDemoCirculation, readSolvency } from '@trustme/core';
import { HttpError } from './http-error.js';

const publicTypes = [
  TransactionType.DEPOSIT,
  TransactionType.WITHDRAWAL,
  TransactionType.TRANSFER,
  TransactionType.REFUND,
];
const barcodeParamsSchema = z.object({ barcodeId: barcodeIdSchema });
const disclosureParamsSchema = z.object({ requestId: z.string().uuid() });
const disclosureCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'code must be exactly six digits') }).strict();
const ledgerQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

function cacheHeaders(response: express.Response): void {
  response.setHeader('Cache-Control', 'public, max-age=10');
}

function sixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function publicUsdt(value: bigint): string {
  const [whole, fraction = ''] = decimalFromMicroUsdt(value).split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

async function accountForUser(prisma: DatabaseClient, userId: string) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}

async function disclosurePayload(prisma: DatabaseClient, userId: string, barcodeId: string, isDemo: boolean) {
  const account = await accountForUser(prisma, userId);
  const entries = await prisma.ledgerEntry.findMany({
    where: {
      asset: Asset.COUPON,
      OR: [{ fromAccountId: account.id }, { toAccountId: account.id }],
    },
    include: {
      transaction: { select: { type: true, status: true, createdAt: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  const allEntries = await prisma.ledgerEntry.findMany({
    where: {
      asset: Asset.COUPON,
      OR: [{ fromAccountId: account.id }, { toAccountId: account.id }],
    },
    select: { fromAccountId: true, toAccountId: true, amount: true },
  });
  let totalReceived = 0n;
  for (const entry of allEntries) {
    if (entry.toAccountId === account.id) totalReceived += entry.amount;
  }
  let balance = account.balance;
  const transactions = entries.map((entry) => {
    const signed = entry.toAccountId === account.id ? entry.amount : -entry.amount;
    const item = {
      at: entry.transaction.createdAt,
      type: entry.transaction.type,
      status: entry.transaction.status,
      amountCoupons: signed.toString(),
      balanceAfterCoupons: balance.toString(),
    };
    balance -= signed;
    return item;
  });
  return {
    barcodeId,
    isDemo,
    balanceCoupons: account.balance.toString(),
    totalReceivedCoupons: totalReceived.toString(),
    transactions,
  };
}

export function createPublicRouter(prisma: PrismaClient): express.Router {
  const router = express.Router();
  const readLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const barcodeLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const disclosureLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const barcodeDisclosureLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 3, keyGenerator: (request) => typeof request.params.barcodeId === 'string' ? request.params.barcodeId : (request.ip ?? 'unknown'), standardHeaders: true, legacyHeaders: false });
  router.use((_request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  let reservesCache: { expiresAt: number; value: unknown } | undefined;
  router.get('/reserves', readLimiter, async (_request, response, next) => {
    try {
      cacheHeaders(response);
      if (reservesCache !== undefined && reservesCache.expiresAt > Date.now()) {
        response.json(reservesCache.value);
        return;
      }
      const [solvency, issuance, demoCirculation, demoUsers] = await Promise.all([
        readSolvency(prisma),
        prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON, userId: null }, select: { balance: true } }),
        readDemoCirculation(prisma),
        prisma.user.count({ where: { isDemo: true } }),
      ]);
      const value = {
        asOf: new Date().toISOString(),
        real: {
          custodyUsdt: publicUsdt(solvency.custodyMicroUsdt),
          obligationsUsdt: publicUsdt(solvency.obligationsMicroUsdt),
          couponsInCirculation: (-issuance.balance).toString(),
          isFullyBacked: solvency.isSolvent,
        },
        demo: { couponsInCirculation: demoCirculation.toString(), userCount: demoUsers },
      };
      reservesCache = { expiresAt: Date.now() + 10_000, value };
      response.json(value);
    } catch (error) {
      next(error);
    }
  });

  router.get('/ledger', readLimiter, async (request, response, next) => {
    try {
      cacheHeaders(response);
      const { limit } = ledgerQuerySchema.parse(request.query);
      const rows = await prisma.transaction.findMany({
        where: { status: TransactionStatus.COMPLETED, type: { in: publicTypes } },
        include: { user: { select: { isDemo: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      response.json({
        items: rows.map((row) => ({
          at: row.createdAt,
          type: row.type,
          amountCoupons: row.amountCoupons.toString(),
          amountUsdt: publicUsdt(row.amountMicroUsdt),
          isDemo: row.user?.isDemo ?? false,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/barcodes/:barcodeId', barcodeLimiter, async (request, response, next) => {
    try {
      cacheHeaders(response);
      const { barcodeId } = barcodeParamsSchema.parse(request.params);
      const user = await prisma.user.findUnique({ where: { barcodeId }, select: { barcodeId: true, isDemo: true } });
      if (user === null) throw new HttpError(404, 'member not found');
      response.json({ barcodeId: user.barcodeId, isDemo: user.isDemo, valid: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/barcodes/:barcodeId/disclosure', disclosureLimiter, barcodeDisclosureLimiter, async (request, response, next) => {
    try {
      const { barcodeId } = barcodeParamsSchema.parse(request.params);
      const user = await prisma.user.findUnique({ where: { barcodeId }, select: { id: true } });
      if (user === null) throw new HttpError(404, 'member not found');
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const requestRow = await prisma.$transaction(async (tx) => {
        await tx.balanceDisclosureRequest.updateMany({
          where: { userId: user.id, status: BalanceDisclosureStatus.PENDING, expiresAt: { lte: new Date() } },
          data: { status: BalanceDisclosureStatus.EXPIRED, code: null, resolvedAt: new Date() },
        });
        const pending = await tx.balanceDisclosureRequest.findFirst({ where: { userId: user.id, status: BalanceDisclosureStatus.PENDING } });
        if (pending !== null) throw new HttpError(409, 'disclosure request already pending');
        const code = sixDigitCode();
        return tx.balanceDisclosureRequest.create({
          data: { userId: user.id, code, expiresAt },
          select: { id: true, expiresAt: true },
        });
      });
      response.status(201).json({ requestId: requestRow.id, expiresAt: requestRow.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.post('/disclosures/:requestId/confirm', async (request, response, next) => {
    try {
      const { code } = disclosureCodeSchema.parse(request.body);
      const { requestId } = disclosureParamsSchema.parse(request.params);
      const result = await prisma.$transaction(async (tx) => {
        const row = await tx.balanceDisclosureRequest.findUnique({ where: { id: requestId }, include: { user: { select: { barcodeId: true, isDemo: true } } } });
        if (row === null) return { error: new HttpError(404, 'disclosure request not found') };
        if (row.status !== BalanceDisclosureStatus.PENDING || row.expiresAt <= new Date()) {
          if (row.status === BalanceDisclosureStatus.PENDING) await tx.balanceDisclosureRequest.update({ where: { id: row.id }, data: { status: BalanceDisclosureStatus.EXPIRED, code: null, resolvedAt: new Date() } });
          return { error: new HttpError(410, 'disclosure request is no longer available') };
        }
        if (row.attempts >= 5) return { error: new HttpError(401, 'invalid disclosure code') };
        const expected = Buffer.from(code, 'utf8');
        const stored = Buffer.from(row.code ?? '', 'utf8');
        const valid = stored.length === expected.length && timingSafeEqual(expected, stored);
        if (!valid) {
          const attempts = row.attempts + 1;
          await tx.balanceDisclosureRequest.update({ where: { id: row.id }, data: { attempts, ...(attempts >= 5 ? { status: BalanceDisclosureStatus.DENIED, code: null, resolvedAt: new Date() } : {}) } });
          return { error: new HttpError(401, 'invalid disclosure code') };
        }
        await tx.balanceDisclosureRequest.update({ where: { id: row.id }, data: { status: BalanceDisclosureStatus.CONSUMED, code: null, resolvedAt: new Date() } });
        return { payload: await disclosurePayload(tx, row.userId, row.user.barcodeId, row.user.isDemo) };
      });
      if ('error' in result) throw result.error;
      response.json(result.payload);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
