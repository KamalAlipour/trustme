import { JsonRpcProvider, Contract } from 'ethers';
import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  AccountType,
  AdminRole,
  Asset,
  IdentityReviewStatus,
  IdentityVerificationStatus,
  Prisma,
  PrismaClient,
  TransactionType,
  WithdrawalStatus,
  CharityAgentRole,
} from '@trustme/db';
import {
  decimalFromMicroUsdt,
  getHotWalletBalances,
  microUsdtFromDecimal,
  readSolvency,
  readDemoCirculation,
  rejectWithdrawal,
  withSerializableRetry,
  createCharity,
  updateCharity,
  addCharityAgent,
  revokeCharityAgent,
  identityPolicyFor,
  networkAverageRateBps,
} from '@trustme/core';
import type { QueueLike } from './app.js';
import { adminClaims, createAdminJwt, requireAdmin, requireRole, verifyAdminPassword } from './admin-auth.js';
import type { ApiConfig } from './config.js';
import { HttpError } from './http-error.js';
import { requireIdentityForWithdrawal } from './withdrawal-settings.js';
import { parseIdentityRequiredCountries } from './identity-required-countries.js';
import { deleteMediaFile, mediaPath } from './media.js';

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
  minimumFeeMicroUsdt: nonNegativeIntegerString.refine((value) => BigInt(value) <= 100_000_000n, 'minimum fee must be at most 100 USDT'),
  minimumWithdrawalMicroUsdt: nonNegativeIntegerString,
  autoApprovalLimitMicroUsdt: nonNegativeIntegerString,
  requireIdentityForWithdrawal: z.boolean(),
  identityRequiredCountries: z.array(z.string().regex(/^[A-Za-z]{2}$/, 'country code must be exactly two letters')).transform((countries) => [...new Set(countries.map((country) => country.toUpperCase()))]),
  commissionFloorBps: z.number().int().min(0),
  commissionFloorByCountry: z.array(z.object({ country: z.string().regex(/^[A-Za-z]{2}$/), bps: z.number().int().min(0) })).transform((rows) => rows.map((row) => ({ country: row.country.toUpperCase(), bps: row.bps }))),
}).strict();
const patchSettingsSchema = settingSchema.partial().strict();
const statusSchema = z.nativeEnum(WithdrawalStatus).optional();
const identityReviewStatusSchema = z.nativeEnum(IdentityReviewStatus).optional();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const cursorSchema = z.string().min(1).optional();
const dateSchema = z.string().datetime().optional();
const charityCreateSchema = z.object({ name: z.string().trim().min(1), description: z.string().trim().optional(), contactEmail: z.string().email().optional(), isActive: z.boolean().optional() });
const charityPatchSchema = charityCreateSchema.partial();
const charityAgentSchema = z.object({ barcodeId: z.string().min(1), role: z.nativeEnum(CharityAgentRole).default(CharityAgentRole.AGENT) });

function jsonValue(value: unknown): string {
  const secretKeys = new Set(['code', 'password', 'passwordHash', 'privateKey', 'HOT_WALLET_PRIVATE_KEY', 'ADMIN_JWT_SECRET', 'authorization', 'token', 'jwt']);
  return JSON.stringify(value, (key, nested) => {
    if (secretKeys.has(key)) return '[REDACTED]';
    return typeof nested === 'bigint' ? nested.toString() : nested;
  });
}

function serializeWithdrawal(withdrawal: {
  id: string;
  user: { barcodeId: string; country: string | null; identityVerificationStatus: string };
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
    identityVerificationStatus: withdrawal.user.identityVerificationStatus,
    country: withdrawal.user.country,
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

function serializeIdentityReview(review: {
  id: string;
  country: string;
  status: IdentityReviewStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  user: { barcodeId: string };
  documentAsset: { id: string } | null;
  selfieAsset: { id: string } | null;
  challengeCode: string | null;
  documentFrontCapturedAt: Date | null;
  selfieNeutralCapturedAt: Date | null;
  selfieTurnedCapturedAt: Date | null;
  selfieWithDocumentCapturedAt: Date | null;
  captureSession: { steps: string[]; mediaAssets: Array<{ id: string; captureStep: string | null; createdAt: Date }> } | null;
}) {
  const captureTimes = new Map([
    ['DOCUMENT_FRONT', review.documentFrontCapturedAt],
    ['SELFIE_NEUTRAL', review.selfieNeutralCapturedAt],
    ['SELFIE_TURNED', review.selfieTurnedCapturedAt],
    ['SELFIE_WITH_DOCUMENT', review.selfieWithDocumentCapturedAt],
  ]);
  const frames = review.captureSession === null ? [] : review.captureSession.steps.flatMap((step) => {
    const asset = review.captureSession?.mediaAssets.find((candidate) => candidate.captureStep === step);
    return asset === undefined ? [] : [{ step, assetId: asset.id, capturedAt: captureTimes.get(step) ?? asset.createdAt, url: `/admin/identity-reviews/${review.id}/media/${asset.id}` }];
  });
  return {
    id: review.id,
    barcodeId: review.user.barcodeId,
    country: review.country,
    status: review.status,
    submittedAt: review.createdAt,
    decidedAt: review.decidedAt,
    decisionNote: review.decisionNote,
    documentUrl: review.documentAsset === null ? null : `/admin/identity-reviews/${review.id}/media/${review.documentAsset.id}`,
    selfieUrl: review.selfieAsset === null ? null : `/admin/identity-reviews/${review.id}/media/${review.selfieAsset.id}`,
    challengeCode: review.challengeCode,
    frames,
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
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: ['WITHDRAWAL_BASE_FEE_BPS', 'WITHDRAWAL_MIN_FEE_USDT', 'MIN_WITHDRAWAL_USDT', 'AUTO_APPROVAL_LIMIT_USDT', 'REQUIRE_IDENTITY_FOR_WITHDRAWAL', 'IDENTITY_REQUIRED_COUNTRIES', 'COMMISSION_FLOOR_BPS', 'COMMISSION_FLOOR_BPS_BY_COUNTRY'] } } });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const commissionFloorByCountry = (values.get('COMMISSION_FLOOR_BPS_BY_COUNTRY') ?? 'IR=300').split(',').filter(Boolean).map((entry) => {
    const [country, bps] = entry.split('=');
    return { country: country!.toUpperCase(), bps: Number.parseInt(bps ?? '0', 10) };
  });
  return {
    withdrawalBaseFeeBps: values.get('WITHDRAWAL_BASE_FEE_BPS') ?? '0',
    minimumFeeMicroUsdt: microUsdtFromDecimal(values.get('WITHDRAWAL_MIN_FEE_USDT') ?? '0').toString(),
    minimumWithdrawalMicroUsdt: microUsdtFromDecimal(values.get('MIN_WITHDRAWAL_USDT') ?? '0').toString(),
    autoApprovalLimitMicroUsdt: microUsdtFromDecimal(values.get('AUTO_APPROVAL_LIMIT_USDT') ?? '0').toString(),
    requireIdentityForWithdrawal: requireIdentityForWithdrawal(values.get('REQUIRE_IDENTITY_FOR_WITHDRAWAL')),
    identityRequiredCountries: [...parseIdentityRequiredCountries(values.get('IDENTITY_REQUIRED_COUNTRIES'))],
    commissionFloorBps: Number.parseInt(values.get('COMMISSION_FLOOR_BPS') ?? '300', 10),
    commissionFloorByCountry,
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
      const [vault, issuance, fees, pending, dust, solvency, countRows, demoCirculation, demoUserCount, commissionNetworkAverageBps] = await Promise.all([
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
        readDemoCirculation(prisma),
        prisma.user.count({ where: { isDemo: true } }),
        prisma.$transaction((tx) => networkAverageRateBps(tx)),
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
        demo: {
          couponsInCirculation: demoCirculation.toString(),
          userCount: demoUserCount,
        },
        commissionNetworkAverageBps,
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
          minimumFeeMicroUsdt: 'WITHDRAWAL_MIN_FEE_USDT',
          minimumWithdrawalMicroUsdt: 'MIN_WITHDRAWAL_USDT',
          autoApprovalLimitMicroUsdt: 'AUTO_APPROVAL_LIMIT_USDT',
          requireIdentityForWithdrawal: 'REQUIRE_IDENTITY_FOR_WITHDRAWAL',
          identityRequiredCountries: 'IDENTITY_REQUIRED_COUNTRIES',
          commissionFloorBps: 'COMMISSION_FLOOR_BPS',
          commissionFloorByCountry: 'COMMISSION_FLOOR_BPS_BY_COUNTRY',
        };
        const before = await tx.systemSetting.findMany({ where: { key: { in: keys.map((key) => keyMap[key]!) } } });
        const oldValues = Object.fromEntries(before.map((row) => [row.key, row.value]));
        for (const field of keys) {
          const value = body[field as keyof typeof body];
          if (value === undefined) continue;
          const key = keyMap[field]!;
          const storedValue = field === 'withdrawalBaseFeeBps' || field === 'requireIdentityForWithdrawal' || field === 'commissionFloorBps'
            ? String(value)
            : field === 'identityRequiredCountries'
              ? (value as string[]).join(',')
              : field === 'commissionFloorByCountry'
                ? (value as Array<{ country: string; bps: number }>).map((row) => `${row.country.toUpperCase()}=${row.bps}`).join(',')
              : decimalFromMicroUsdt(BigInt(value as string));
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
        include: { user: { select: { barcodeId: true, country: true, identityVerificationStatus: true } } },
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

  router.get('/identity-reviews', requireRole(AdminRole.APPROVER, AdminRole.ADMIN), async (request, response, next) => {
    try {
      const status = identityReviewStatusSchema.parse(request.query.status);
      const limit = limitSchema.parse(request.query.limit);
      const cursor = cursorSchema.parse(request.query.cursor);
      const where: Prisma.IdentityReviewWhereInput = { ...(status === undefined ? {} : { status }) };
      if (cursor !== undefined) {
        const parsed = cursorDate(cursor);
        where.OR = [
          { createdAt: { lt: parsed.createdAt } },
          { createdAt: parsed.createdAt, id: { lt: parsed.id } },
        ];
      }
      const rows = await prisma.identityReview.findMany({
        where,
        include: {
          user: { select: { barcodeId: true } },
          documentAsset: { select: { id: true } },
          selfieAsset: { select: { id: true } },
          captureSession: { include: { mediaAssets: { select: { id: true, captureStep: true, createdAt: true, storageKey: true } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      response.json({
        items: page.map(serializeIdentityReview),
        nextCursor: hasMore ? nextCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/identity-reviews/:id/media/:assetId', requireRole(AdminRole.APPROVER, AdminRole.ADMIN), async (request, response, next) => {
    try {
      const reviewId = z.string().uuid().parse(request.params.id);
      const assetId = z.string().uuid().parse(request.params.assetId);
      const review = await prisma.identityReview.findUnique({
        where: { id: reviewId },
        select: { documentAssetId: true, selfieAssetId: true, captureSession: { select: { mediaAssets: { select: { id: true } } } } },
      });
      const sessionAssetIds = review?.captureSession?.mediaAssets.map((asset) => asset.id) ?? [];
      if (review === null || (review.documentAssetId !== assetId && review.selfieAssetId !== assetId && !sessionAssetIds.includes(assetId))) {
        throw new HttpError(404, 'resource not found');
      }
      const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { storageKey: true, mimeType: true } });
      if (asset === null) throw new HttpError(404, 'resource not found');
      const file = await mediaPath(config.mediaStorageDir, asset.storageKey);
      response.setHeader('Content-Disposition', 'inline');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      response.type(asset.mimeType);
      response.sendFile(file, (error) => {
        if (error !== undefined && !response.headersSent) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  const decideIdentityReview = async (
    request: Request,
    reviewId: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string | null,
  ) => {
    const result = await withSerializableRetry(prisma, async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "IdentityReview" WHERE "id" = ${reviewId}::uuid FOR UPDATE`);
      const current = await tx.identityReview.findUniqueOrThrow({
        where: { id: reviewId },
        include: {
          user: true,
          documentAsset: { select: { storageKey: true } },
          selfieAsset: { select: { storageKey: true } },
          captureSession: { include: { mediaAssets: { select: { id: true, storageKey: true } } } },
        },
      });
      if (current.status !== IdentityReviewStatus.PENDING) throw new HttpError(409, 'identity review is not pending');
      if (decision === 'APPROVED') {
        const policy = identityPolicyFor(current.country, {
          shahkar: config.shahkarApiToken !== undefined && config.identityHashPepper !== undefined,
        });
        if (policy.mode !== 'MANUAL') throw new HttpError(409, 'manual identity review is not the active identity path for this account');
      }
      const now = new Date();
      const updated = await tx.identityReview.update({
        where: { id: current.id },
        data: {
          status: decision,
          decisionNote: note,
          decidedByAdminId: adminId(request),
          decidedAt: now,
          documentAssetId: null,
          selfieAssetId: null,
        },
      });
      if (decision === 'APPROVED') {
        await tx.user.update({
          where: { id: current.userId },
          data: {
            identityVerificationStatus: IdentityVerificationStatus.VERIFIED,
            identityVerifiedAt: now,
            ...(current.user.kycStatus === 'UNVERIFIED' ? { kycStatus: 'VERIFIED' } : {}),
          },
        });
      }
      const assetIds = [
        current.documentAssetId,
        current.selfieAssetId,
        ...(current.captureSession?.mediaAssets.map((asset) => asset.id) ?? []),
      ].filter((id): id is string => id !== null);
      await tx.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: adminId(request),
          action: decision === 'APPROVED' ? 'identity_review.approve' : 'identity_review.reject',
          entityType: 'IdentityReview',
          entityId: current.id,
          oldValue: jsonValue({ status: current.status }),
          newValue: jsonValue({ status: updated.status, decisionNote: updated.decisionNote }),
        },
      });
      return {
        updated,
        storageKeys: [
          current.documentAsset?.storageKey,
          current.selfieAsset?.storageKey,
          ...(current.captureSession?.mediaAssets.map((asset) => asset.storageKey) ?? []),
        ].filter((key): key is string => key !== undefined),
      };
    });
    await Promise.all(result.storageKeys.map((storageKey) => deleteMediaFile(config.mediaStorageDir, storageKey)));
    return result.updated;
  };

  router.post('/identity-reviews/:id/approve', requireRole(AdminRole.APPROVER, AdminRole.ADMIN), async (request, response, next) => {
    try {
      const updated = await decideIdentityReview(request, z.string().uuid().parse(request.params.id), 'APPROVED', null);
      response.json({ id: updated.id, status: updated.status, submittedAt: updated.createdAt, decidedAt: updated.decidedAt, decisionNote: updated.decisionNote });
    } catch (error) {
      next(error);
    }
  });

  router.post('/identity-reviews/:id/reject', requireRole(AdminRole.APPROVER, AdminRole.ADMIN), async (request, response, next) => {
    try {
      const body = z.object({ note: z.string().trim().min(1) }).strict().parse(request.body);
      const updated = await decideIdentityReview(request, z.string().uuid().parse(request.params.id), 'REJECTED', body.note);
      response.json({ id: updated.id, status: updated.status, submittedAt: updated.createdAt, decidedAt: updated.decidedAt, decisionNote: updated.decisionNote });
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

  router.post('/charities', requireRole(AdminRole.ADMIN), async (request, response, next) => {
    try {
      const body = charityCreateSchema.parse(request.body);
      const charity = await createCharity(prisma, {
        name: body.name,
        adminUserId: adminId(request),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.contactEmail === undefined ? {} : { contactEmail: body.contactEmail }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      });
      response.status(201).json(charity);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'charity already exists'));
        return;
      }
      next(error);
    }
  });

  router.patch('/charities/:id', requireRole(AdminRole.ADMIN), async (request, response, next) => {
    try {
      const body = charityPatchSchema.parse(request.body);
      const charity = await updateCharity(prisma, {
        charityId: z.string().uuid().parse(request.params.id),
        adminUserId: adminId(request),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.contactEmail === undefined ? {} : { contactEmail: body.contactEmail }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      });
      response.json(charity);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'charity already exists'));
        return;
      }
      next(error);
    }
  });

  router.post('/charities/:id/agents', requireRole(AdminRole.ADMIN), async (request, response, next) => {
    try {
      const body = charityAgentSchema.parse(request.body);
      const agent = await addCharityAgent(prisma, { charityId: z.string().uuid().parse(request.params.id), adminUserId: adminId(request), ...body });
      response.status(201).json(agent);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'agent already exists'));
        return;
      }
      next(error);
    }
  });

  router.delete('/charities/:id/agents/:userId', requireRole(AdminRole.ADMIN), async (request, response, next) => {
    try {
      const agent = await revokeCharityAgent(prisma, {
        charityId: z.string().uuid().parse(request.params.id),
        userId: z.string().uuid().parse(request.params.userId),
        adminUserId: adminId(request),
      });
      response.json(agent);
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
