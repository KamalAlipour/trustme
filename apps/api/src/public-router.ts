import express from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AccountType, Asset, PrismaClient, TransactionStatus } from '@trustme/db';
import {
  barcodeIdSchema,
  decimalFromMicroUsdt,
  readDemoCirculation,
  readSolvency,
  withSerializableRetry,
} from '@trustme/core';
import { HttpError } from './http-error.js';

export type PublicRouterDependencies = {
  prisma: PrismaClient;
};

const transactionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const disclosureCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be exactly six digits'),
});

function signedDecimalFromMicroUsdt(value: bigint): string {
  return value < 0n ? `-${decimalFromMicroUsdt(-value)}` : decimalFromMicroUsdt(value);
}

function unavailable(): never {
  throw new HttpError(410, 'unavailable');
}

export function createPublicRouter(dependencies: PublicRouterDependencies): express.Router {
  const { prisma } = dependencies;
  const router = express.Router();
  const disclosureLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/reserves', async (_request, response, next) => {
    try {
      const [solvency, demoCouponsInCirculation, issuance] = await Promise.all([
        readSolvency(prisma),
        readDemoCirculation(prisma),
        prisma.ledgerAccount.findFirstOrThrow({
          where: { type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON, userId: null },
          select: { balance: true },
        }),
      ]);
      response.json({
        custodyUsdt: signedDecimalFromMicroUsdt(solvency.custodyMicroUsdt),
        obligationsUsdt: signedDecimalFromMicroUsdt(solvency.obligationsMicroUsdt),
        surplusUsdt: signedDecimalFromMicroUsdt(solvency.surplusMicroUsdt),
        isSolvent: solvency.isSolvent,
        couponsInCirculation: (-issuance.balance).toString(),
        demoCouponsInCirculation: demoCouponsInCirculation.toString(),
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/transactions', async (request, response, next) => {
    try {
      const { limit } = transactionQuerySchema.parse(request.query);
      const transactions = await prisma.transaction.findMany({
        where: { status: TransactionStatus.CONFIRMED },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: {
          type: true,
          amountCoupons: true,
          createdAt: true,
          user: { select: { isDemo: true } },
        },
      });
      response.json({
        items: transactions.map((transaction) => ({
          type: transaction.type,
          amountCoupons: transaction.amountCoupons.toString(),
          at: new Date(Math.floor(transaction.createdAt.getTime() / 60_000) * 60_000).toISOString(),
          isDemo: transaction.user?.isDemo ?? false,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/barcodes/:barcodeId', async (request, response, next) => {
    try {
      const barcodeId = barcodeIdSchema.parse(request.params.barcodeId);
      const user = await prisma.user.findUnique({
        where: { barcodeId },
        select: { barcodeId: true, activeGuaranteeCount: true, isDemo: true, createdAt: true },
      });
      if (user === null) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      response.json({
        barcodeId: user.barcodeId,
        status: user.activeGuaranteeCount > 0 ? 'restricted' : 'active',
        isDemo: user.isDemo,
        memberSince: user.createdAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/barcodes/:barcodeId/disclosure', disclosureLimiter, async (request, response, next) => {
    try {
      const barcodeId = barcodeIdSchema.parse(request.params.barcodeId);
      const user = await prisma.user.findUnique({ where: { barcodeId }, select: { id: true } });
      if (user === null) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60_000);
      const created = await withSerializableRetry(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
        const liveCount = await tx.balanceDisclosureRequest.count({
          where: {
            userId: user.id,
            createdAt: { gte: new Date(now.getTime() - 60 * 60_000) },
            expiresAt: { gt: now },
            consumedAt: null,
            deniedAt: null,
          },
        });
        if (liveCount >= 3) throw new HttpError(429, 'too many disclosure requests');
        return tx.balanceDisclosureRequest.create({
          data: {
            userId: user.id,
            codeHash: '',
            attempts: 0,
            createdAt: now,
            expiresAt,
          },
          select: { id: true, expiresAt: true },
        });
      });
      response.status(201).json({ requestId: created.id, expiresAt: created.expiresAt.toISOString() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/disclosure/:requestId/verify', async (request, response, next) => {
    try {
      const requestId = z.string().uuid().parse(request.params.requestId);
      const { code } = disclosureCodeSchema.parse(request.body);
      const result = await withSerializableRetry(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "BalanceDisclosureRequest" WHERE id = ${requestId}::uuid FOR UPDATE`;
        const disclosure = await tx.balanceDisclosureRequest.findUnique({
          where: { id: requestId },
          select: {
            id: true,
            codeHash: true,
            attempts: true,
            expiresAt: true,
            consumedAt: true,
            deniedAt: true,
            user: { select: { barcodeId: true, isDemo: true, ledgerAccounts: { where: { type: AccountType.USER_COUPON, asset: Asset.COUPON }, select: { balance: true }, take: 1 } } },
          },
        });
        if (
          disclosure === null ||
          disclosure.codeHash.length === 0 ||
          disclosure.consumedAt !== null ||
          disclosure.deniedAt !== null ||
          disclosure.expiresAt <= new Date() ||
          disclosure.attempts >= 5
        ) return { kind: 'unavailable' as const };
        if (!await bcrypt.compare(code, disclosure.codeHash)) {
          await tx.balanceDisclosureRequest.update({
            where: { id: disclosure.id },
            data: { attempts: { increment: 1 } },
          });
          return { kind: 'unavailable' as const };
        }
        const account = disclosure.user.ledgerAccounts[0];
        if (account === undefined) return { kind: 'unavailable' as const };
        const asOf = new Date();
        await tx.balanceDisclosureRequest.update({ where: { id: disclosure.id }, data: { consumedAt: asOf } });
        return {
          kind: 'success' as const,
          barcodeId: disclosure.user.barcodeId,
          balanceCoupons: account.balance.toString(),
          isDemo: disclosure.user.isDemo,
          asOf: asOf.toISOString(),
        };
      });
      if (result.kind === 'unavailable') unavailable();
      response.json({
        barcodeId: result.barcodeId,
        balanceCoupons: result.balanceCoupons,
        isDemo: result.isDemo,
        asOf: result.asOf,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
