import { JsonRpcProvider, Contract } from 'ethers';
import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  AccountType,
  AdminRole,
  Asset,
  Prisma,
  PrismaClient,
  TransactionType,
  WithdrawalStatus,
} from '@trustme/db';
import {
  decimalFromMicroUsdt,
  getHotWalletBalances,
  microUsdtFromDecimal,
  readSolvency,
  rejectWithdrawal,
  withSerializableRetry,
} from '@trustme/core';
import type { QueueLike } from './app.js';
import { adminClaims, createAdminJwt, requireAdmin, requireRole, verifyAdminPassword } from './admin-auth.js';
import type { ApiConfig } from './config.js';
import { HttpError } from './http-error.js';

export type AdminChainProvider = {
  getBlockNumber(): Promise<number>;
  getNativeBalance(address: string): Promise<bigint>;
  getTokenBalance(tokenAddress: string, ownerAddress: string): Promise<bigint>;
};

export class EthersAdminChainProvider implements AdminChainProvider {
  private readonly provider: JsonRpcProvider;

  public constructor(url: string) {
    this.provider = new JsonRpcProvider(url);
  }

  public getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  public getNativeBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  public async getTokenBalance(tokenAddress: string, ownerAddress: string): Promise<bigint> {
    const token = new Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], this.provider);
    return BigInt(await token.getFunction('balanceOf')(ownerAddress));
  }
}

export type AdminRouterDependencies = {
  config: ApiConfig;
  prisma: PrismaClient;
  queue: QueueLike;
  chainProvider: AdminChainProvider | undefined;
};

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const nonNegativeIntegerString = z.string().regex(/^(?:0|[1-9]\d*)$/);
const settingSchema = z.object({
  withdrawalBaseFeeBps: nonNegativeIntegerString.refine((value) => BigInt(value) <= 10_000n, 'fee bps must be between 0 and 10000'),
  minimumWithdrawalMicroUsdt: nonNegativeIntegerString,
  autoApprovalLimitMicroUsdt: nonNegativeIntegerString,
}).strict();
const patchSettingsSchema = settingSchema.partial().strict();
const statusSchema = z.nativeEnum(WithdrawalStatus).optional();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const cursorSchema = z.string().min(1).optional();
const dateSchema = z.string().datetime().optional();

function jsonValue(value: unknown): string {
  const secretKeys = new Set(['code', 'password', 'passwordHash', 'privateKey', 'HOT_WALLET_PRIVATE_KEY', 'ADMIN_JWT_SECRET', 'authorization', 'token', 'jwt']);
  return JSON.stringify(value, (key, nested) => {
    if (secretKeys.has(key)) return '[REDACTED]';
    return typeof nested === 'bigint' ? nested.toString() : nested;
  });
}

function serializeWithdrawal(withdrawal: {
  id: string;
  user: { barcodeId: string };
  couponsGross: bigint;
  feeMicroUsdt: bigint;
  netMicroUsdt: bigint;
  grossMicroUsdt: bigint;
  destinationAddress: string;
  status: WithdrawalStatus;
  chainTxHash: string | null;
  createdAt: Date;
  broadcastedAt: Date | null;
}) {
  return {
    id: withdrawal.id,
    barcodeId: withdrawal.user.barcodeId,
    couponsGross: withdrawal.couponsGross.toString(),
    grossUsdt: decimalFromMicroUsdt(withdrawal.grossMicroUsdt),
    feeUsdt: decimalFromMicroUsdt(withdrawal.feeMicroUsdt),
    netUsdt: decimalFromMicroUsdt(withdrawal.netMicroUsdt),
    destinationAddress: withdrawal.destinationAddress,
    status: withdrawal.status,
    chainTxHash: withdrawal.chainTxHash,
    createdAt: withdrawal.createdAt,
    broadcastedAt: withdrawal.broadcastedAt,
  };
}

async function systemAccount(prisma: PrismaClient, type: AccountType, asset: Asset) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { type, asset, userId: null } });
}

function adminId(request: Request): string {
  return adminClaims(request).sub;
}

function cursorDate(cursor: string): { createdAt: Date; id: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new HttpError(400, 'invalid cursor');
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const separator = decoded.indexOf('|');
  if (separator < 1) throw new HttpError(400, 'invalid cursor');
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !z.string().uuid().safeParse(id).success) {
    throw new HttpError(400, 'invalid cursor');
  }
  return { createdAt, id };
}

function nextCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

async function readAdminSettings(prisma: PrismaClient) {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: ['WITHDRAWAL_BASE_FEE_BPS', 'MIN_WITHDRAWAL_USDT', 'AUTO_APPROVAL_LIMIT_USDT'] } } });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    withdrawalBaseFeeBps: values.get('WITHDRAWAL_BASE_FEE_BPS') ?? '0',
    minimumWithdrawalMicroUsdt: microUsdtFromDecimal(values.get('MIN_WITHDRAWAL_USDT') ?? '0').toString(),
    autoApprovalLimitMicroUsdt: microUsdtFromDecimal(values.get('AUTO_APPROVAL_LIMIT_USDT') ?? '0').toString(),
  };
}

export function createAdminRouter(dependencies: AdminRouterDependencies): express.Router {
  const { config, prisma, queue, chainProvider } = dependencies;
  const router = express.Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.post('/login', loginLimiter, async (request, response, next) => {
    try {
      const body = loginSchema.parse(request.body);
      const admin = await prisma.adminUser.findUnique({ where: { username: body.username } });
      const valid = await verifyAdminPassword(body.password, admin?.passwordHash);
      if (!admin || !valid) {
        response.status(401).json({ error: 'invalid credentials' });
        return;
      }
      response.json({ token: createAdminJwt(admin.id, admin.username, admin.role, config.adminJwtSecret, config.adminJwtTtlSeconds), expiresIn: config.adminJwtTtlSeconds });
    } catch (error) {
      next(error);
    }
  });

  router.use(requireAdmin(config.adminJwtSecret));

  router.get('/overview', async (_request, response, next) => {
    try {
      const [vault, issuance, fees, pending, dust, solvency, countRows] = await Promise.all([
        systemAccount(prisma, AccountType.SYSTEM_VAULT_USDT, Asset.USDT),
        systemAccount(prisma, AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON),
        systemAccount(prisma, AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT),
        systemAccount(prisma, AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT),
        prisma.user.aggregate({ _sum: { dustMicroUsdt: true } }),
        readSolvency(prisma),
        prisma.transaction.groupBy({
          by: ['type'],
          where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
          _count: { _all: true },
        }),
      ]);
      let chain: Record<string, unknown> = { available: false };
      try {
        if (!chainProvider) throw new Error('chain provider unavailable');
        const [head, cursor] = await Promise.all([
          chainProvider.getBlockNumber(),
          prisma.chainCursor.findUnique({ where: { id: 1 } }),
        ]);
        const nextBlock = cursor?.nextBlock ?? 0n;
        chain = { available: true, headBlock: head, nextBlock: nextBlock.toString(), lag: (BigInt(head) - nextBlock).toString() };
      } catch {
        chain = { available: false };
      }
      let hotWallet: Record<string, unknown> = { available: false };
      try {
        if (!chainProvider) throw new Error('chain provider unavailable');
        const balances = await getHotWalletBalances(chainProvider, config.usdtContractAddress, config.hotWalletAddress);
        hotWallet = {
          available: true,
          usdt: decimalFromMicroUsdt(balances.usdtBalanceMicroUsdt),
          nativeWei: balances.nativeBalanceWei.toString(),
        };
      } catch {
        hotWallet = { available: false };
      }
      const transactionCount24hByType = Object.fromEntries(countRows.map((row) => [row.type, row._count._all]));
      response.json({
        vaultUsdt: decimalFromMicroUsdt(vault.balance),
        couponsInCirculation: (-issuance.balance).toString(),
        feesCollectedUsdt: decimalFromMicroUsdt(fees.balance),
        withdrawalPendingUsdt: decimalFromMicroUsdt(pending.balance),
        dustUsdt: decimalFromMicroUsdt(dust._sum.dustMicroUsdt ?? 0n),
        solvency: {
          custodyUsdt: decimalFromMicroUsdt(solvency.custodyMicroUsdt),
          obligationsUsdt: decimalFromMicroUsdt(solvency.obligationsMicroUsdt),
          surplusUsdt: decimalFromMicroUsdt(solvency.surplusMicroUsdt),
          isSolvent: solvency.isSolvent,
          components: {
            vaultUsdt: decimalFromMicroUsdt(vault.balance),
            withdrawalPendingUsdt: decimalFromMicroUsdt(pending.balance),
            feesUsdt: decimalFromMicroUsdt(fees.balance),
            couponsUsdt: decimalFromMicroUsdt((-issuance.balance) * 10_000n),
            dustUsdt: decimalFromMicroUsdt(dust._sum.dustMicroUsdt ?? 0n),
          },
        },
        transactionCount24hByType,
        chain,
        hotWallet,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings', async (_request, response, next) => {
    try {
      response.json(await readAdminSettings(prisma));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/settings', requireRole(AdminRole.ADMIN), async (request, response, next) => {
    try {
      const body = patchSettingsSchema.parse(request.body);
      if (Object.keys(body).length === 0) throw new HttpError(400, 'at least one setting is required');
      await withSerializableRetry(prisma, async (tx) => {
        const keys = Object.keys(body);
        const keyMap: Record<string, string> = {
          withdrawalBaseFeeBps: 'WITHDRAWAL_BASE_FEE_BPS',
          minimumWithdrawalMicroUsdt: 'MIN_WITHDRAWAL_USDT',
          autoApprovalLimitMicroUsdt: 'AUTO_APPROVAL_LIMIT_USDT',
        };
        const before = await tx.systemSetting.findMany({ where: { key: { in: keys.map((key) => keyMap[key]!) } } });
        const oldValues = Object.fromEntries(before.map((row) => [row.key, row.value]));
        for (const field of keys) {
          const value = body[field as keyof typeof body];
          if (value === undefined) continue;
          const key = keyMap[field]!;
          const storedValue = field === 'withdrawalBaseFeeBps' ? value : decimalFromMicroUsdt(BigInt(value));
          await tx.systemSetting.upsert({ where: { key }, update: { value: storedValue }, create: { key, value: storedValue } });
        }
        const after = await tx.systemSetting.findMany({ where: { key: { in: keys.map((key) => keyMap[key]!) } } });
        await tx.adminAuditLog.create({
          data: {
            adminUserId: adminId(request),
            action: 'settings.update',
            entityType: 'SystemSetting',
            entityId: 'settings',
            oldValue: jsonValue(oldValues),
            newValue: jsonValue(Object.fromEntries(after.map((row) => [row.key, row.value]))),
          },
        });
      });
      response.json(await readAdminSettings(prisma));
    } catch (error) {
      next(error);
    }
  });

  router.get('/withdrawals', async (request, response, next) => {
    try {
      const status = statusSchema.parse(request.query.status);
      const limit = limitSchema.parse(request.query.limit);
      const cursor = cursorSchema.parse(request.query.cursor);
      const where: Prisma.WithdrawalWhereInput = { ...(status === undefined ? {} : { status }) };
      if (cursor !== undefined) {
        const parsed = cursorDate(cursor);
        where.OR = [
          { createdAt: { lt: parsed.createdAt } },
          { createdAt: parsed.createdAt, id: { lt: parsed.id } },
        ];
      }
      const rows = await prisma.withdrawal.findMany({
        where,
        include: { user: { select: { barcodeId: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      response.json({ items: page.map(serializeWithdrawal), nextCursor: hasMore ? nextCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null });
    } catch (error) {
      next(error);
    }
  });

  router.post('/withdrawals/:id/approve', requireRole(AdminRole.APPROVER, AdminRole.ADMIN), async (request, response, next) => {
    try {
      const withdrawalId = z.string().uuid().parse(request.params.id);
      const withdrawal = await withSerializableRetry(prisma, async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawalId}::uuid FOR UPDATE`);
        const current = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
        if (current.status !== WithdrawalStatus.PENDING_APPROVAL) throw new HttpError(409, 'withdrawal is not pending approval');
        const updated = await tx.withdrawal.update({ where: { id: current.id }, data: { status: WithdrawalStatus.APPROVED } });
        await tx.adminAuditLog.create({
          data: {
            adminUserId: adminId(request),
            action: 'withdrawal.approve',
            entityType: 'Withdrawal',
            entityId: current.id,
            oldValue: jsonValue({ status: current.status }),
            newValue: jsonValue({ status: updated.status }),
          },
        });
        return updated;
      });
      await queue.add('dispatch', { withdrawalId: withdrawal.id }, { jobId: withdrawal.id });
      response.json({ id: withdrawal.id, status: withdrawal.status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/withdrawals/:id/reject', requireRole(AdminRole.APPROVER, AdminRole.ADMIN), async (request, response, next) => {
    try {
      const withdrawalId = z.string().uuid().parse(request.params.id);
      const withdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      const userAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: withdrawal.userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
      const [vault, fees, pending, issuance] = await Promise.all([
        systemAccount(prisma, AccountType.SYSTEM_VAULT_USDT, Asset.USDT),
        systemAccount(prisma, AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT),
        systemAccount(prisma, AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT),
        systemAccount(prisma, AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON),
      ]);
      const rejected = await rejectWithdrawal(prisma, {
        withdrawalId: withdrawal.id,
        userAccountId: userAccount.id,
        vaultAccountId: vault.id,
        feeAccountId: fees.id,
        pendingAccountId: pending.id,
        issuanceAccountId: issuance.id,
        audit: {
          adminUserId: adminId(request),
          action: 'withdrawal.reject',
          entityType: 'Withdrawal',
          entityId: withdrawal.id,
          oldValue: jsonValue({ status: withdrawal.status }),
          newValue: jsonValue({ status: WithdrawalStatus.REJECTED }),
        },
      });
      response.json({ id: rejected.id, status: rejected.status });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ledger', async (request, response, next) => {
    try {
      const search = typeof request.query.search === 'string' ? request.query.search : undefined;
      const type = request.query.type === undefined ? undefined : z.nativeEnum(TransactionType).parse(request.query.type);
      const from = dateSchema.parse(request.query.from);
      const to = dateSchema.parse(request.query.to);
      const limit = limitSchema.parse(request.query.limit);
      const cursor = cursorSchema.parse(request.query.cursor);
      const where: Prisma.TransactionWhereInput = {
        ...(type === undefined ? {} : { type }),
        ...(from === undefined && to === undefined ? {} : { createdAt: { ...(from === undefined ? {} : { gte: new Date(from) }), ...(to === undefined ? {} : { lte: new Date(to) }) } }),
        ...(search === undefined ? {} : {
          OR: [
            ...(search.match(/^[0-9a-f-]{36}$/i) ? [{ id: search }] : []),
            { externalRef: { contains: search, mode: 'insensitive' as const } },
            { user: { barcodeId: search } },
          ],
        }),
      };
      if (cursor !== undefined) {
        const parsed = cursorDate(cursor);
        where.AND = [
          ...(where.AND instanceof Array ? where.AND : []),
          { OR: [{ createdAt: { lt: parsed.createdAt } }, { createdAt: parsed.createdAt, id: { lt: parsed.id } }] },
        ];
      }
      const rows = await prisma.transaction.findMany({
        where,
        include: { entries: true, user: { select: { barcodeId: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      response.json({
        items: page.map((row) => ({
          id: row.id,
          type: row.type,
          status: row.status,
          barcodeId: row.user?.barcodeId ?? null,
          externalRef: row.externalRef,
          amountUsdt: decimalFromMicroUsdt(row.amountMicroUsdt),
          amountCoupons: row.amountCoupons.toString(),
          feeUsdt: decimalFromMicroUsdt(row.feeMicroUsdt),
          createdAt: row.createdAt,
          entries: row.entries.map((entry) => ({
            id: entry.id,
            fromAccountId: entry.fromAccountId,
            toAccountId: entry.toAccountId,
            amount: entry.amount.toString(),
            asset: entry.asset,
            createdAt: entry.createdAt,
          })),
        })),
        nextCursor: hasMore ? nextCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
