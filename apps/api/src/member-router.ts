import { randomInt, randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AccountType,
  Asset,
  BalanceDisclosureStatus,
  EmailVerificationPurpose,
  IdentityCaptureStep,
  IdentityVerificationStatus,
  KycStatus,
  Prisma,
  PrismaClient,
  WithdrawalStatus,
} from '@trustme/db';
import {
  activateGuarantee,
  approveGuarantee,
  barcodeIdSchema,
  countrySchema,
  cancelEscrow,
  cancelGuarantee,
  createEscrowHold,
  createLoanRequest,
  decimalFromMicroUsdt,
  evmAddressSchema,
  fourDigitCodeSchema,
  iranMobileSchema,
  nationalCodeSchema,
  microUsdtFromDecimal,
  phoneNumberSchema,
  readWithdrawalAvailability,
  releaseEscrow,
  repayLoan,
  requestWithdrawal,
  transferCoupons,
  withdrawalQuote,
  approveRefund,
  createRefundRequest,
  rejectRefund,
  createAidRequest,
  attachAidDocuments,
  approveAidRequest,
  rejectAidRequest,
  requestAidDocuments,
  donateToCharity,
  identityPolicyFor,
} from '@trustme/core';
import { DomainError } from '@trustme/core';
import type { QueueLike } from './app.js';
import { HttpError } from './http-error.js';
import { isWeakPin, issueEmailCode, memberClaims, requireCompletedSetup, securitySetupStatus, serializeMember, smtpSender, verifyAndSetEmail, verifyMemberPin } from './member-auth.js';
import type { ApiConfig } from './config.js';
import { deleteMediaFile, mediaPath, uploadMedia } from './media.js';
import { hashIdentityValue } from './identity.js';
import { checkShahkarMatch } from './shahkar.js';
import { requireIdentityForWithdrawal } from './withdrawal-settings.js';

export type MemberRouterDependencies = {
  config: ApiConfig;
  prisma: PrismaClient;
  queue: QueueLike;
  emailSender?: import('./member-auth.js').EmailSender;
  logEmailCode?: (email: string, code: string) => void;
  checkShahkarMatch?: typeof checkShahkarMatch;
};

const couponsSchema = z.string().regex(/^[1-9]\d*$/, 'amountCoupons must be a positive decimal string');
const displayNameSchema = z.string().trim().min(1).max(128);
const transferSchema = z.object({ toBarcodeId: barcodeIdSchema, amountCoupons: couponsSchema, idempotencyKey: z.string().min(1), pin: fourDigitCodeSchema });
const escrowSchema = z.object({
  recipientBarcodeId: barcodeIdSchema,
  amountCoupons: couponsSchema,
  code: fourDigitCodeSchema,
  expiresAt: z.string().datetime(),
  idempotencyKey: z.string().min(1).optional(),
  pin: fourDigitCodeSchema,
});
const withdrawalSchema = z.object({ destinationAddress: evmAddressSchema, couponsGross: couponsSchema, pin: fourDigitCodeSchema });
const withdrawalQuoteSchema = z.object({ couponsGross: couponsSchema });
const loanInstallmentSchema = z.object({ dueAt: z.string().datetime(), amountCoupons: couponsSchema });
const loanGuarantorSchema = z.object({ barcodeId: barcodeIdSchema, amountCoupons: couponsSchema });
const loanSchema = z.object({
  principalCoupons: couponsSchema,
  installments: z.array(loanInstallmentSchema).min(1),
  guarantors: z.array(loanGuarantorSchema).min(1),
});
const repaymentSchema = z.object({ amountCoupons: couponsSchema, idempotencyKey: z.string().min(1) });
const codeSchema = z.object({ code: fourDigitCodeSchema });
const emailCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'code must be exactly six digits') });
const approvalSchema = z.object({ code: fourDigitCodeSchema, pin: fourDigitCodeSchema });
const contactSchema = z.object({ barcodeId: barcodeIdSchema, alias: z.string().trim().min(1).max(128) });
const contactPatchSchema = z.object({ alias: z.string().trim().min(1).max(128) });
const transactionQuerySchema = z.object({ cursor: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const contactsQuerySchema = z.object({ query: z.string().optional(), sort: z.enum(['alias', 'recent']).default('alias') });
const barcodeQuerySchema = z.object({ query: z.string().trim().min(3), limit: z.coerce.number().int().min(1).max(25).default(20) });
const refundSchema = z.object({ transactionId: z.string().uuid(), amountCoupons: couponsSchema, reason: z.string().trim().min(1), mediaIds: z.array(z.string().uuid()).max(10).optional() });
const refundQuerySchema = z.object({ role: z.enum(['buyer', 'seller']).default('buyer'), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), cursor: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const charityDonationSchema = z.object({ amountCoupons: couponsSchema, pin: fourDigitCodeSchema, idempotencyKey: z.string().min(1).optional() });
const aidRequestSchema = z.object({ charityId: z.string().uuid(), amountCoupons: couponsSchema, description: z.string().trim().min(1), loanId: z.string().uuid().optional(), mediaIds: z.array(z.string().uuid()).max(10).optional() });
const aidDocumentsSchema = z.object({ mediaIds: z.array(z.string().uuid()).min(1).max(10) });
const charityQuerySchema = z.object({ status: z.enum(['PENDING', 'DOCUMENTS_REQUESTED', 'APPROVED', 'REJECTED']).optional() });
const aidApprovalSchema = z.object({ approvedCoupons: couponsSchema.optional(), note: z.string().trim().optional(), pin: fourDigitCodeSchema });
const noteSchema = z.object({ note: z.string().trim().min(1) });
const idSchema = z.string().uuid();
const manualReviewSchema = z.object({
  captureSessionId: idSchema,
}).strict();
const captureSessionSteps = [
  IdentityCaptureStep.DOCUMENT_FRONT,
  IdentityCaptureStep.SELFIE_NEUTRAL,
  IdentityCaptureStep.SELFIE_TURNED,
  IdentityCaptureStep.SELFIE_WITH_DOCUMENT,
] as const;

function shuffledCaptureSteps(): IdentityCaptureStep[] {
  const steps = [...captureSessionSteps];
  for (let index = steps.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = steps[index]!;
    steps[index] = steps[swapIndex]!;
    steps[swapIndex] = current;
  }
  return steps;
}

function shahkarAccess(config: ApiConfig): { shahkar: boolean } {
  return {
    shahkar: config.shahkarApiToken !== undefined && config.identityHashPepper !== undefined,
  };
}

function parseCoupons(value: string): bigint {
  return BigInt(value);
}

function forbidden(): never {
  throw new HttpError(403, 'forbidden');
}

function pathId(value: string): string {
  if (!idSchema.safeParse(value).success) throw new HttpError(404, 'resource not found');
  return value;
}

function isPhoneUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes('phoneNumber') || target.includes('User_phoneNumber_key') : target === 'phoneNumber' || target === 'User_phoneNumber_key';
}

async function member(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user === null) throw new HttpError(401, 'unauthorized');
  return user;
}

async function userByBarcode(prisma: PrismaClient, barcodeId: string) {
  const user = await prisma.user.findUnique({ where: { barcodeId } });
  if (user === null) throw new HttpError(404, 'member not found');
  return user;
}

async function couponAccount(prisma: PrismaClient, userId: string) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}

async function escrowAccount(prisma: PrismaClient, userId: string) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.ESCROW, asset: Asset.COUPON } });
}

async function systemAccount(prisma: PrismaClient, type: AccountType, asset: Asset) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { type, asset, userId: null } });
}

async function withdrawalSettings(prisma: PrismaClient) {
  const values = await prisma.systemSetting.findMany({
    where: { key: { in: ['WITHDRAWAL_BASE_FEE_BPS', 'WITHDRAWAL_MIN_FEE_USDT', 'MIN_WITHDRAWAL_USDT', 'AUTO_APPROVAL_LIMIT_USDT', 'WITHDRAWAL_COOLDOWN_HOURS', 'REQUIRE_IDENTITY_FOR_WITHDRAWAL'] } },
  });
  const settings = new Map(values.map((setting) => [setting.key, setting.value]));
  return {
    baseFeeBps: BigInt(settings.get('WITHDRAWAL_BASE_FEE_BPS') ?? (() => { throw new Error('missing fee setting'); })()),
    minimumFeeMicroUsdt: microUsdtFromDecimal(settings.get('WITHDRAWAL_MIN_FEE_USDT') ?? (() => { throw new Error('missing minimum fee setting'); })()),
    minimumWithdrawalMicroUsdt: microUsdtFromDecimal(settings.get('MIN_WITHDRAWAL_USDT') ?? (() => { throw new Error('missing minimum setting'); })()),
    autoApprovalLimitMicroUsdt: microUsdtFromDecimal(settings.get('AUTO_APPROVAL_LIMIT_USDT') ?? '0'),
    cooldownHours: Number(settings.get('WITHDRAWAL_COOLDOWN_HOURS') ?? '168'),
    requireIdentityVerification: requireIdentityForWithdrawal(settings.get('REQUIRE_IDENTITY_FOR_WITHDRAWAL')),
  };
}

function serializeWithdrawal(withdrawal: {
  id: string;
  status: WithdrawalStatus;
  couponsGross: bigint;
  grossMicroUsdt: bigint;
  feeMicroUsdt: bigint;
  netMicroUsdt: bigint;
  chainTxHash: string | null;
  eligibleAt: Date;
}) {
  return {
    id: withdrawal.id,
    status: withdrawal.status,
    couponsGross: withdrawal.couponsGross.toString(),
    grossUsdt: decimalFromMicroUsdt(withdrawal.grossMicroUsdt),
    feeUsdt: decimalFromMicroUsdt(withdrawal.feeMicroUsdt),
    netUsdt: decimalFromMicroUsdt(withdrawal.netMicroUsdt),
    chainTxHash: withdrawal.chainTxHash,
    eligibleAt: withdrawal.eligibleAt,
  };
}

function serializeIdentityReview(review: {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}) {
  return {
    id: review.id,
    status: review.status,
    submittedAt: review.createdAt,
    decidedAt: review.decidedAt,
    decisionNote: review.decisionNote,
  };
}

function serializeLoan(loan: {
  id: string;
  borrowerId: string;
  lenderId: string | null;
  principalCoupons: bigint;
  outstandingCoupons: bigint;
  status: string;
  createdAt: Date;
  fundedAt: Date | null;
  settledAt: Date | null;
  installments: Array<{ id: string; sequence: number; dueAt: Date; amountCoupons: bigint; paidCoupons: bigint; paidAt: Date | null }>;
  guarantees: Array<{ id: string; loanId: string; guarantorId: string; amountCoupons: bigint; status: string; wrongAttempts: number; lockedAt: Date | null; activatedAt: Date | null; resolvedAt: Date | null; guarantor: { displayName: string | null; barcodeId: string } }>;
}) {
  return {
    id: loan.id,
    borrowerId: loan.borrowerId,
    lenderId: loan.lenderId,
    principalCoupons: loan.principalCoupons.toString(),
    outstandingCoupons: loan.outstandingCoupons.toString(),
    status: loan.status,
    createdAt: loan.createdAt,
    fundedAt: loan.fundedAt,
    settledAt: loan.settledAt,
    installments: loan.installments.map((installment) => ({
      id: installment.id,
      sequence: installment.sequence,
      dueAt: installment.dueAt,
      amountCoupons: installment.amountCoupons.toString(),
      paidCoupons: installment.paidCoupons.toString(),
      paidAt: installment.paidAt,
    })),
    guarantees: loan.guarantees.map((guarantee) => ({
      id: guarantee.id,
      loanId: guarantee.loanId,
      guarantorId: guarantee.guarantorId,
      amountCoupons: guarantee.amountCoupons.toString(),
      status: guarantee.status,
      wrongAttempts: guarantee.wrongAttempts,
      lockedAt: guarantee.lockedAt,
      activatedAt: guarantee.activatedAt,
      resolvedAt: guarantee.resolvedAt,
      guarantor: guarantee.guarantor,
    })),
  };
}

function serializeGuarantee(guarantee: {
  id: string;
  loanId?: string;
  guarantorId: string;
  amountCoupons: bigint;
  status: string;
  wrongAttempts: number;
  lockedAt?: Date | null;
  activatedAt?: Date | null;
  resolvedAt?: Date | null;
}) {
  return {
    id: guarantee.id,
    loanId: guarantee.loanId,
    guarantorId: guarantee.guarantorId,
    amountCoupons: guarantee.amountCoupons.toString(),
    status: guarantee.status,
    wrongAttempts: guarantee.wrongAttempts,
    lockedAt: guarantee.lockedAt ?? null,
    activatedAt: guarantee.activatedAt ?? null,
    resolvedAt: guarantee.resolvedAt ?? null,
  };
}

function cursorDate(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const separator = decoded.indexOf('|');
  if (separator < 1) throw new HttpError(400, 'invalid cursor');
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !z.string().uuid().safeParse(id).success) throw new HttpError(400, 'invalid cursor');
  return { createdAt, id };
}

function nextCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function refundCursor(status: string, createdAt: Date, id: string): string {
  return Buffer.from(`${status}|${createdAt.toISOString()}|${id}`).toString('base64url');
}

function parseRefundCursor(cursor: string): { status: string; createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const parts = decoded.split('|');
  if (parts.length !== 3 || !['PENDING', 'APPROVED', 'REJECTED'].includes(parts[0]!)) throw new HttpError(400, 'invalid cursor');
  const createdAt = new Date(parts[1]!);
  if (Number.isNaN(createdAt.getTime()) || !idSchema.safeParse(parts[2]).success) throw new HttpError(400, 'invalid cursor');
  return { status: parts[0]!, createdAt, id: parts[2]! };
}

function serializeRefund(request: {
  id: string;
  amountCoupons: bigint;
  reason: string;
  status: string;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  buyerId: string;
  sellerId: string;
  buyer: { displayName: string | null; barcodeId: string };
  seller: { displayName: string | null; barcodeId: string };
  transaction: { amountCoupons: bigint; createdAt: Date };
  media: Array<{ id: string }>;
}, currentUserId: string, refundable: bigint) {
  const counterparty = request.buyerId === currentUserId ? request.seller : request.buyer;
  return {
    id: request.id,
    amountCoupons: request.amountCoupons.toString(),
    reason: request.reason,
    status: request.status,
    decisionNote: request.decisionNote,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    counterparty,
    originalAmountCoupons: request.transaction.amountCoupons.toString(),
    originalTransactionDate: request.transaction.createdAt,
    refundableAmountCoupons: refundable.toString(),
    mediaIds: request.media.map((asset) => asset.id),
  };
}

function serializeAid(request: {
  id: string;
  charityId: string;
  applicantId: string;
  loanId: string | null;
  amountCoupons: bigint;
  approvedCoupons: bigint | null;
  description: string;
  status: string;
  decisionNote: string | null;
  decidedById: string | null;
  disbursementTransactionId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  media: Array<{ id: string }>;
  applicant?: { displayName: string | null; barcodeId: string };
  charity?: { name: string };
  loan?: { id: string; principalCoupons: bigint; outstandingCoupons: bigint; status: string } | null;
}) {
  return {
    id: request.id,
    charityId: request.charityId,
    charityName: request.charity?.name,
    applicant: request.applicant,
    amountCoupons: request.amountCoupons.toString(),
    approvedCoupons: request.approvedCoupons?.toString() ?? null,
    description: request.description,
    status: request.status,
    decisionNote: request.decisionNote,
    decidedById: request.decidedById,
    disbursementTransactionId: request.disbursementTransactionId,
    loan: request.loan === undefined || request.loan === null ? null : {
      id: request.loan.id,
      principalCoupons: request.loan.principalCoupons.toString(),
      outstandingCoupons: request.loan.outstandingCoupons.toString(),
      status: request.loan.status,
    },
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    mediaIds: request.media.map((asset) => asset.id),
  };
}

export function createMemberRouter(dependencies: MemberRouterDependencies): express.Router {
  const { prisma, queue } = dependencies;
  const sender = dependencies.emailSender ?? smtpSender(dependencies.config);
  const router = express.Router();
  const mediaLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, keyGenerator: (request) => memberClaims(request).sub });
  const identityLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, keyGenerator: (request) => memberClaims(request).sub });
  const setupAllowedPaths = new Set(['/security-setup', '/email', '/email/verify', '/logout']);
  const memberPolicy = (user: Awaited<ReturnType<typeof member>>) => {
    const policy = user.country === null
      ? null
      : identityPolicyFor(user.country, shahkarAccess(dependencies.config));
    const serialized = serializeMember(user);
    return {
      ...serialized,
      identityVerification: {
        ...serialized.identityVerification,
        mode: policy?.mode ?? null,
        provider: policy?.provider ?? null,
      },
    };
  };
  router.use((request, response, next) => {
    if (setupAllowedPaths.has(request.path)) {
      next();
      return;
    }
    requireCompletedSetup(dependencies.config, prisma)(request, response, next);
  });

  router.get('/security-setup', async (request, response, next) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: memberClaims(request).sub },
        select: { pinHash: true, emailVerifiedAt: true, biometricEnrolledAt: true, setupAcknowledgedAt: true, securitySetupCompletedAt: true },
      });
      response.json(securitySetupStatus(user, dependencies.config.requireEmailVerification));
    } catch (error) {
      next(error);
    }
  });

  router.get('/barcodes', async (request, response, next) => {
    try {
      const query = barcodeQuerySchema.parse(request.query);
      const items = await prisma.user.findMany({
        where: {
          OR: [
            { barcodeId: { startsWith: query.query, mode: 'insensitive' } },
            { displayName: { contains: query.query, mode: 'insensitive' } },
          ],
        },
        select: { barcodeId: true, displayName: true, isDemo: true },
        orderBy: { barcodeId: 'asc' },
        take: query.limit,
      });
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.get('/barcodes/:barcodeId', async (request, response, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { barcodeId: request.params.barcodeId },
        select: { barcodeId: true, displayName: true, isDemo: true, kycStatus: true },
      });
      if (user === null) throw new HttpError(404, 'member not found');
      response.json(user);
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    try {
      response.json(memberPolicy(await member(prisma, memberClaims(request).sub)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/identity', identityLimiter, async (request, response, next) => {
    try {
      const config = dependencies.config;
      if (config.shahkarApiToken === undefined || config.identityHashPepper === undefined) {
        throw new HttpError(503, 'identity verification is not configured');
      }
      const current = await member(prisma, memberClaims(request).sub);
      if (current.country === null) throw new HttpError(400, 'account country is required');
      const policy = identityPolicyFor(current.country, shahkarAccess(config));
      if (policy.mode !== 'AUTOMATED' || policy.provider !== 'SHAHKAR') {
        throw new HttpError(409, 'shahkar is not the active identity path for this account');
      }
      const identityHashPepper = config.identityHashPepper;
      const body = z.object({ nationalCode: nationalCodeSchema }).parse(request.body);
      const userId = memberClaims(request).sub;
      if (current.phoneNumber === null) throw new HttpError(400, 'identity verification requires a phone number');
      const mobile = iranMobileSchema.safeParse(current.phoneNumber);
      if (!mobile.success) throw new HttpError(400, 'phone number must be a valid Iranian mobile number');
      const nationalIdHash = hashIdentityValue(body.nationalCode, identityHashPepper);
      if (current.identityVerificationStatus === IdentityVerificationStatus.VERIFIED && current.nationalIdHash === nationalIdHash) {
        response.json({ status: current.identityVerificationStatus, verifiedAt: current.identityVerifiedAt });
        return;
      }
      const identityWindowStart = new Date(Date.now() - 24 * 60 * 60_000);
      const recentIdentityChecks = await prisma.identityCheck.count({ where: { userId, createdAt: { gte: identityWindowStart } } });
      if (recentIdentityChecks >= 10) throw new HttpError(429, 'identity verification limit reached');
      const check = dependencies.checkShahkarMatch ?? checkShahkarMatch;
      const outcome = await check(
        { nationalCode: body.nationalCode, mobile: mobile.data },
        { token: config.shahkarApiToken, baseUrl: config.shahkarBaseUrl },
      );
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        const locked = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const now = new Date();
        const recentChecks = await tx.identityCheck.count({
          where: { userId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
        });
        if (recentChecks >= 10) throw new HttpError(429, 'identity verification limit reached');
        const identityStatus = outcome.status === 'MATCH'
          ? IdentityVerificationStatus.VERIFIED
          : outcome.status === 'MISMATCH'
            ? IdentityVerificationStatus.MISMATCH
            : IdentityVerificationStatus.INCONCLUSIVE;
        const data: Prisma.UserUpdateInput = {
          identityVerificationStatus: identityStatus,
          identityCheckCount: { increment: 1 },
          lastIdentityCheckAt: now,
        };
        if (outcome.status === 'MATCH') {
          data.identityVerifiedAt = now;
          data.nationalIdHash = nationalIdHash;
          if (locked.kycStatus === KycStatus.UNVERIFIED) data.kycStatus = KycStatus.VERIFIED;
        } else if (outcome.status === 'MISMATCH') {
          if (locked.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
            data.identityVerificationStatus = IdentityVerificationStatus.VERIFIED;
          } else {
            data.identityVerifiedAt = null;
            data.nationalIdHash = null;
          }
        } else if (locked.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
          data.identityVerificationStatus = IdentityVerificationStatus.VERIFIED;
        }
        await tx.identityCheck.create({
          data: {
            userId,
            status: identityStatus,
            providerCode: outcome.providerCode,
            nationalIdHash,
            mobileHash: hashIdentityValue(mobile.data, identityHashPepper),
          },
        });
        return tx.user.update({ where: { id: userId }, data });
      });
      response.json({ status: updated.identityVerificationStatus, verifiedAt: updated.identityVerifiedAt });
    } catch (error) {
      next(error);
    }
  });

  router.get('/identity', async (request, response, next) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: memberClaims(request).sub },
        include: {
          identityReviews: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      });
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'REQUIRE_IDENTITY_FOR_WITHDRAWAL' } });
      const requireIdentityForWithdrawalValue = requireIdentityForWithdrawal(setting?.value);
      const policy = user.country === null ? null : identityPolicyFor(user.country, shahkarAccess(dependencies.config));
      response.json({
        country: user.country,
        mode: policy?.mode ?? null,
        provider: policy?.provider ?? null,
        providerLabel: policy?.providerLabel ?? null,
        plannedProviderLabel: policy?.plannedProviderLabel ?? null,
        status: user.identityVerificationStatus,
        verifiedAt: user.identityVerifiedAt,
        requiredForWithdrawal: requireIdentityForWithdrawalValue,
        review: user.identityReviews[0] === undefined ? null : serializeIdentityReview(user.identityReviews[0]),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/identity/live-capture-session', identityLimiter, async (request, response, next) => {
    try {
      const current = await member(prisma, memberClaims(request).sub);
      if (current.country === null) throw new HttpError(400, 'account country is required');
      const policy = identityPolicyFor(current.country, shahkarAccess(dependencies.config));
      if (policy.mode !== 'MANUAL') throw new HttpError(409, 'live identity capture is not the active identity path for this account');
      if (current.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
        throw new HttpError(409, 'identity is already verified');
      }
      const pending = await prisma.identityReview.findFirst({ where: { userId: current.id, status: 'PENDING' } });
      if (pending !== null) throw new HttpError(409, 'identity review already pending');
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      const session = await prisma.identityCaptureSession.create({
        data: {
          userId: current.id,
          challengeCode: randomInt(1000, 10000).toString(),
          steps: shuffledCaptureSteps(),
          expiresAt,
        },
      });
      response.status(201).json({ id: session.id, challengeCode: session.challengeCode, expiresAt: session.expiresAt, steps: session.steps });
    } catch (error) {
      next(error);
    }
  });

  router.get('/disclosures', async (request, response, next) => {
    try {
      const now = new Date();
      await prisma.balanceDisclosureRequest.updateMany({
        where: { userId: memberClaims(request).sub, status: BalanceDisclosureStatus.PENDING, expiresAt: { lte: now } },
        data: { status: BalanceDisclosureStatus.EXPIRED, code: null, resolvedAt: now },
      });
      const rows = await prisma.balanceDisclosureRequest.findMany({
        where: { userId: memberClaims(request).sub, status: BalanceDisclosureStatus.PENDING, expiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      response.json({
        items: rows.flatMap((row) => row.code === null ? [] : [{ id: row.id, code: row.code, requestedAt: row.createdAt, expiresAt: row.expiresAt }]),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/disclosures/:id/deny', async (request, response, next) => {
    try {
      const id = pathId(request.params.id);
      const userId = memberClaims(request).sub;
      const row = await prisma.balanceDisclosureRequest.findUnique({ where: { id } });
      if (row === null || row.userId !== userId) throw new HttpError(404, 'disclosure request not found');
      if (row.status !== BalanceDisclosureStatus.PENDING || row.expiresAt <= new Date()) {
        if (row.status === BalanceDisclosureStatus.PENDING) await prisma.balanceDisclosureRequest.update({ where: { id }, data: { status: BalanceDisclosureStatus.EXPIRED, code: null, resolvedAt: new Date() } });
        throw new HttpError(409, 'disclosure request is no longer pending');
      }
      await prisma.balanceDisclosureRequest.update({ where: { id }, data: { status: BalanceDisclosureStatus.DENIED, code: null, resolvedAt: new Date() } });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/identity/manual-review', identityLimiter, async (request, response, next) => {
    try {
      const current = await member(prisma, memberClaims(request).sub);
      if (current.country === null) throw new HttpError(400, 'account country is required');
      const policy = identityPolicyFor(current.country, shahkarAccess(dependencies.config));
      if (policy.mode !== 'MANUAL') throw new HttpError(409, 'manual identity review is not the active identity path for this account');
      if (current.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
        throw new HttpError(409, 'identity is already verified');
      }
      const body = manualReviewSchema.parse(request.body);
      const review = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "IdentityCaptureSession" WHERE "id" = ${body.captureSessionId}::uuid FOR UPDATE`;
        const session = await tx.identityCaptureSession.findUnique({
          where: { id: body.captureSessionId },
          include: {
            mediaAssets: {
              include: {
                identityReviewDocuments: { select: { id: true } },
                identityReviewSelfies: { select: { id: true } },
              },
            },
          },
        });
        if (session === null || session.userId !== current.id) throw new HttpError(403, 'forbidden');
        if (session.consumedAt !== null || session.expiresAt <= new Date()) throw new HttpError(409, 'identity capture session is expired or already used');
        const pending = await tx.identityReview.findFirst({ where: { userId: current.id, status: 'PENDING' } });
        if (pending !== null) throw new HttpError(409, 'identity review already pending');
        const expectedSteps = new Set(session.steps);
        const assetsByStep = new Map<IdentityCaptureStep, typeof session.mediaAssets[number]>();
        for (const asset of session.mediaAssets) {
          if (
            asset.ownerId !== current.id
            || asset.kind !== 'IMAGE'
            || asset.refundRequestId !== null
            || asset.aidRequestId !== null
            || asset.captureSessionId !== session.id
            || asset.captureStep === null
            || !expectedSteps.has(asset.captureStep)
            || asset.identityReviewDocuments.length > 0
            || asset.identityReviewSelfies.length > 0
          ) throw new HttpError(403, 'forbidden');
          if (assetsByStep.has(asset.captureStep)) throw new HttpError(400, 'identity capture requires exactly one frame per step');
          assetsByStep.set(asset.captureStep, asset);
        }
        if (expectedSteps.size !== captureSessionSteps.length || assetsByStep.size !== captureSessionSteps.length || captureSessionSteps.some((step) => !assetsByStep.has(step))) {
          throw new HttpError(400, 'identity capture requires exactly one frame per step');
        }
        const document = assetsByStep.get(IdentityCaptureStep.DOCUMENT_FRONT)!;
        const selfie = assetsByStep.get(IdentityCaptureStep.SELFIE_NEUTRAL)!;
        const turned = assetsByStep.get(IdentityCaptureStep.SELFIE_TURNED)!;
        const withDocument = assetsByStep.get(IdentityCaptureStep.SELFIE_WITH_DOCUMENT)!;
        const review = await tx.identityReview.create({
          data: {
            userId: current.id,
            country: current.country!,
            captureSessionId: session.id,
            challengeCode: session.challengeCode,
            documentAssetId: document.id,
            selfieAssetId: selfie.id,
            documentFrontCapturedAt: document.createdAt,
            selfieNeutralCapturedAt: selfie.createdAt,
            selfieTurnedCapturedAt: turned.createdAt,
            selfieWithDocumentCapturedAt: withDocument.createdAt,
          },
        });
        await tx.identityCaptureSession.update({ where: { id: session.id }, data: { consumedAt: new Date() } });
        return review;
      });
      response.status(201).json(serializeIdentityReview(review));
    } catch (error) {
      next(error);
    }
  });

  router.put('/country', async (request, response, next) => {
    try {
      const body = z.object({ country: countrySchema }).strict().parse(request.body);
      const user = await member(prisma, memberClaims(request).sub);
      if (user.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
        throw new HttpError(409, 'country cannot be changed after identity verification');
      }
      const updated = await prisma.user.update({ where: { id: user.id }, data: { country: body.country } });
      response.json(memberPolicy(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/phone', identityLimiter, async (request, response, next) => {
    try {
      const body = z.object({ phone: phoneNumberSchema, pin: fourDigitCodeSchema }).strict().parse(request.body);
      const userId = memberClaims(request).sub;
      await verifyMemberPin(prisma, userId, body.pin);
      const current = await member(prisma, userId);
      if (current.phoneNumber === body.phone) {
        response.json(memberPolicy(current));
        return;
      }
      if (current.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
        throw new HttpError(409, 'phone cannot be changed after identity verification');
      }
      const updated = await prisma.user.update({ where: { id: userId }, data: { phoneNumber: body.phone } });
      response.json(memberPolicy(updated));
    } catch (error) {
      if (isPhoneUniqueViolation(error)) {
        next(new HttpError(409, 'phone already registered'));
        return;
      }
      next(error);
    }
  });

  router.patch('/', async (request, response, next) => {
    try {
      const body = z.object({ displayName: displayNameSchema }).parse(request.body);
      const updated = await prisma.user.update({ where: { id: memberClaims(request).sub }, data: { displayName: body.displayName } });
      response.json(memberPolicy(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/pin', async (request, response, next) => {
    try {
      const body = z.object({ currentPin: fourDigitCodeSchema, newPin: fourDigitCodeSchema }).parse(request.body);
      if (isWeakPin(body.newPin)) throw new HttpError(400, 'PIN is too weak');
      const claims = memberClaims(request);
      await verifyMemberPin(prisma, claims.sub, body.currentPin);
      await prisma.$transaction([
        prisma.user.update({ where: { id: claims.sub }, data: { pinHash: await bcrypt.hash(body.newPin, 12), pinUpdatedAt: new Date(), pinAttempts: 0, pinLockCount: 0, pinLockedUntil: null } }),
        prisma.memberDevice.updateMany({ where: { userId: claims.sub, id: { not: claims.sid }, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/email', async (request, response, next) => {
    try {
      const body = z.object({ email: z.string().email() }).parse(request.body);
      const email = body.email.trim().toLowerCase();
      const userId = memberClaims(request).sub;
      if (dependencies.config.emailDelivery === 'none') throw new HttpError(503, 'email delivery not configured');
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing !== null && existing.id !== userId) throw new HttpError(409, 'email already in use');
      await issueEmailCode(prisma, dependencies.config, sender, dependencies.logEmailCode, userId, email, EmailVerificationPurpose.VERIFY_EMAIL);
      response.status(202).json({ expiresAt: new Date(Date.now() + 15 * 60_000) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/email/verify', async (request, response, next) => {
    try {
      const body = emailCodeSchema.parse(request.body);
      const updated = await verifyAndSetEmail(prisma, memberClaims(request).sub, body.code, dependencies.config.requireEmailVerification);
      response.json(memberPolicy(updated));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'email already in use'));
        return;
      }
      next(error);
    }
  });

  router.get('/devices', async (request, response, next) => {
    try {
      const claims = memberClaims(request);
      const devices = await prisma.memberDevice.findMany({ where: { userId: claims.sub, revokedAt: null }, orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }] });
      response.json({ items: devices.map((device) => ({ id: device.id, label: device.label, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, current: device.id === claims.sid })) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/devices/:id', async (request, response, next) => {
    try {
      const claims = memberClaims(request);
      const device = await prisma.memberDevice.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (device.userId !== claims.sub) forbidden();
      await prisma.memberDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (request, response, next) => {
    try {
      await prisma.memberDevice.update({ where: { id: memberClaims(request).sid }, data: { revokedAt: new Date() } });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get('/balance', async (request, response, next) => {
    try {
      const user = await member(prisma, memberClaims(request).sub);
      const account = await couponAccount(prisma, user.id);
      const address = await prisma.depositAddress.findFirst({ where: { userId: user.id } });
      response.json({ barcodeId: user.barcodeId, coupons: account.balance.toString(), dustMicroUsdt: decimalFromMicroUsdt(user.dustMicroUsdt), depositAddress: address?.address ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.get('/withdrawal-availability', async (request, response, next) => {
    try {
      const settings = await withdrawalSettings(prisma);
      const availability = await readWithdrawalAvailability(prisma, memberClaims(request).sub, { requireIdentityVerification: settings.requireIdentityVerification });
      response.json({
        balanceCoupons: availability.balanceCoupons.toString(),
        lockedGuaranteeCoupons: availability.lockedGuaranteeCoupons.toString(),
        outstandingDebtCoupons: availability.outstandingDebtCoupons.toString(),
        totalCollateralCoupons: availability.totalCollateralCoupons.toString(),
        availableToWithdrawCoupons: availability.availableToWithdrawCoupons.toString(),
        blockers: availability.blockers,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/transactions', async (request, response, next) => {
    try {
      const userAccount = await couponAccount(prisma, memberClaims(request).sub);
      const query = transactionQuerySchema.parse(request.query);
      const cursor = query.cursor === undefined ? undefined : cursorDate(query.cursor);
      const rows = await prisma.ledgerEntry.findMany({
        where: {
          asset: Asset.COUPON,
          AND: [
            { OR: [{ fromAccountId: userAccount.id }, { toAccountId: userAccount.id }] },
            ...(cursor === undefined ? [] : [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }]),
          ],
        },
        include: {
          transaction: { select: { type: true, status: true, createdAt: true } },
          fromAccount: { include: { user: { select: { displayName: true, barcodeId: true } } } },
          toAccount: { include: { user: { select: { displayName: true, barcodeId: true } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const transactionIds = page.map((row) => row.transactionId);
      const escrowHolds = transactionIds.length === 0
        ? []
        : await prisma.escrowHold.findMany({
          where: {
            OR: [
              { transactionId: { in: transactionIds } },
              { releaseTransactionId: { in: transactionIds } },
            ],
          },
          include: {
            sender: { select: { displayName: true, barcodeId: true } },
            recipient: { select: { displayName: true, barcodeId: true } },
          },
        });
      const holdByTransactionId = new Map<string, (typeof escrowHolds)[number]>();
      for (const hold of escrowHolds) {
        holdByTransactionId.set(hold.transactionId, hold);
        if (hold.releaseTransactionId !== null) holdByTransactionId.set(hold.releaseTransactionId, hold);
      }
      const refundableTransactionIds = page.flatMap((row) => {
        const outgoing = row.fromAccountId === userAccount.id;
        const hold = holdByTransactionId.get(row.transactionId);
        if (hold !== undefined && row.toAccount.type === AccountType.ESCROW && hold.transactionId === row.transactionId) {
          return hold.releaseTransactionId === null ? [] : [hold.releaseTransactionId];
        }
        if (hold !== undefined && row.fromAccount.type === AccountType.ESCROW && hold.releaseTransactionId === row.transactionId) return [];
        if (
          outgoing &&
          row.transaction.type === 'TRANSFER' &&
          row.fromAccount.type === AccountType.USER_COUPON &&
          row.toAccount.type === AccountType.USER_COUPON
        ) return [row.transactionId];
        return [];
      });
      const refunds = refundableTransactionIds.length === 0
        ? []
        : await prisma.refundRequest.findMany({
          where: { transactionId: { in: refundableTransactionIds }, buyerId: memberClaims(request).sub },
          select: { id: true, transactionId: true, status: true, amountCoupons: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        });
      const latestRefundByTransactionId = new Map<string, (typeof refunds)[number]>();
      for (const refund of refunds) {
        if (!latestRefundByTransactionId.has(refund.transactionId)) latestRefundByTransactionId.set(refund.transactionId, refund);
      }
      response.json({
        items: page.map((row) => {
          const outgoing = row.fromAccountId === userAccount.id;
          const counterpartyAccount = outgoing ? row.toAccount : row.fromAccount;
          const hold = holdByTransactionId.get(row.transactionId);
          const escrowHoldLeg = hold !== undefined && row.toAccount.type === AccountType.ESCROW && hold.transactionId === row.transactionId;
          const escrowReleaseLeg = hold !== undefined && row.fromAccount.type === AccountType.ESCROW && hold.releaseTransactionId === row.transactionId;
          const refundableTransactionId = escrowHoldLeg
            ? hold.releaseTransactionId
            : !escrowReleaseLeg &&
                outgoing &&
                row.transaction.type === 'TRANSFER' &&
                row.fromAccount.type === AccountType.USER_COUPON &&
                row.toAccount.type === AccountType.USER_COUPON
              ? row.transactionId
              : null;
          const resolvedCounterparty = escrowHoldLeg
            ? { displayName: hold.recipient.displayName, barcodeId: hold.recipient.barcodeId }
            : escrowReleaseLeg
              ? { displayName: hold.sender.displayName, barcodeId: hold.sender.barcodeId }
              : counterpartyAccount.user === null
                ? { systemAccountType: counterpartyAccount.type }
                : { displayName: counterpartyAccount.user.displayName, barcodeId: counterpartyAccount.user.barcodeId };
          const refund = refundableTransactionId === null ? null : latestRefundByTransactionId.get(refundableTransactionId);
          return {
            id: row.id,
            transactionId: row.transactionId,
            refundableTransactionId,
            direction: outgoing ? 'out' : 'in',
            amountCoupons: row.amount.toString(),
            counterparty: resolvedCounterparty,
            refund: refund === undefined || refund === null ? null : { id: refund.id, status: refund.status, amountCoupons: refund.amountCoupons.toString() },
            transaction: {
              type: row.transaction.type,
              status: row.transaction.status,
              createdAt: row.transaction.createdAt,
            },
          };
        }),
        nextCursor: hasMore ? nextCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/transfers', async (request, response, next) => {
    try {
      const body = transferSchema.parse(request.body);
      const user = await member(prisma, memberClaims(request).sub);
      await verifyMemberPin(prisma, user.id, body.pin);
      const destination = await userByBarcode(prisma, body.toBarcodeId);
      const transaction = await transferCoupons(prisma, {
        userId: user.id,
        counterpartyUserId: destination.id,
        externalRef: `api:me:transfer:${user.id}:${body.idempotencyKey}`,
        fromAccountId: (await couponAccount(prisma, user.id)).id,
        toAccountId: (await couponAccount(prisma, destination.id)).id,
        amountCoupons: parseCoupons(body.amountCoupons),
      });
      await prisma.contact.updateMany({
        where: {
          OR: [
            { ownerId: user.id, contactUserId: destination.id },
            { ownerId: destination.id, contactUserId: user.id },
          ],
        },
        data: { lastActivityAt: new Date() },
      });
      response.status(201).json({ transactionId: transaction.id, status: transaction.status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/escrows', async (request, response, next) => {
    try {
      const body = escrowSchema.parse(request.body);
      const sender = await member(prisma, memberClaims(request).sub);
      await verifyMemberPin(prisma, sender.id, body.pin);
      const recipient = await userByBarcode(prisma, body.recipientBarcodeId);
      const hold = await createEscrowHold(prisma, {
        senderId: sender.id,
        recipientId: recipient.id,
        senderAccountId: (await couponAccount(prisma, sender.id)).id,
        escrowAccountId: (await escrowAccount(prisma, sender.id)).id,
        amountCoupons: parseCoupons(body.amountCoupons),
        code: body.code,
        expiresAt: new Date(body.expiresAt),
        ...(body.idempotencyKey === undefined ? {} : { externalRef: `api:me:escrow:${sender.id}:${body.idempotencyKey}` }),
      });
      response.status(201).json({ id: hold.id, status: hold.status, amountCoupons: hold.amountCoupons.toString(), expiresAt: hold.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.post('/escrows/:id/release', async (request, response, next) => {
    try {
      const body = codeSchema.parse(request.body);
      const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (hold.recipientId !== memberClaims(request).sub) forbidden();
      const released = await releaseEscrow(prisma, { holdId: hold.id, recipientAccountId: (await couponAccount(prisma, hold.recipientId)).id, code: body.code });
      response.json({ id: released?.id, status: released?.status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/escrows/:id/cancel', async (request, response, next) => {
    try {
      const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (hold.senderId !== memberClaims(request).sub) forbidden();
      const cancelled = await cancelEscrow(prisma, { holdId: hold.id, senderAccountId: (await couponAccount(prisma, hold.senderId)).id });
      response.json({ id: cancelled.id, status: cancelled.status });
    } catch (error) {
      next(error);
    }
  });

  router.get('/withdrawals/quote', async (request, response, next) => {
    try {
      const query = withdrawalQuoteSchema.parse(request.query);
      const settings = await withdrawalSettings(prisma);
      const quote = withdrawalQuote(parseCoupons(query.couponsGross), {
        baseFeeBps: settings.baseFeeBps,
        minimumFeeMicroUsdt: settings.minimumFeeMicroUsdt,
        minimumWithdrawalMicroUsdt: settings.minimumWithdrawalMicroUsdt,
      });
      response.json({
        grossMicroUsdt: quote.grossMicroUsdt.toString(),
        feeMicroUsdt: quote.feeMicroUsdt.toString(),
        netMicroUsdt: quote.netMicroUsdt.toString(),
        baseFeeBps: settings.baseFeeBps.toString(),
        minimumFeeMicroUsdt: settings.minimumFeeMicroUsdt.toString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/withdrawals', async (request, response, next) => {
    try {
      const body = withdrawalSchema.parse(request.body);
      const user = await member(prisma, memberClaims(request).sub);
      await verifyMemberPin(prisma, user.id, body.pin);
      const settings = await withdrawalSettings(prisma);
      const withdrawal = await requestWithdrawal(prisma, {
        userId: user.id,
        userAccountId: (await couponAccount(prisma, user.id)).id,
        destinationAddress: body.destinationAddress,
        couponsGross: parseCoupons(body.couponsGross),
        baseFeeBps: settings.baseFeeBps,
        minimumFeeMicroUsdt: settings.minimumFeeMicroUsdt,
        minimumWithdrawalMicroUsdt: settings.minimumWithdrawalMicroUsdt,
        autoApprovalLimitMicroUsdt: settings.autoApprovalLimitMicroUsdt,
        cooldownHours: settings.cooldownHours,
        requireIdentityVerification: settings.requireIdentityVerification,
        vaultAccountId: (await systemAccount(prisma, AccountType.SYSTEM_VAULT_USDT, Asset.USDT)).id,
        feeAccountId: (await systemAccount(prisma, AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT)).id,
        pendingAccountId: (await systemAccount(prisma, AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT)).id,
        issuanceAccountId: (await systemAccount(prisma, AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON)).id,
      });
      if (withdrawal.status === WithdrawalStatus.APPROVED) await queue.add('dispatch', { withdrawalId: withdrawal.id }, { jobId: withdrawal.id });
      response.status(201).json(serializeWithdrawal(withdrawal));
    } catch (error) {
      next(error);
    }
  });

  router.get('/contacts', async (request, response, next) => {
    try {
      const userId = memberClaims(request).sub;
      const query = contactsQuerySchema.parse(request.query);
      const rows = await prisma.contact.findMany({
        where: {
          ownerId: userId,
          ...(query.query === undefined ? {} : {
            OR: [
              { alias: { contains: query.query, mode: 'insensitive' } },
              { contactUser: { barcodeId: { contains: query.query, mode: 'insensitive' } } },
              { contactUser: { displayName: { contains: query.query, mode: 'insensitive' } } },
            ],
          }),
        },
        include: { contactUser: { select: { displayName: true, barcodeId: true } } },
        orderBy: query.sort === 'alias' ? [{ alias: 'asc' }, { id: 'asc' }] : [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      });
      response.json({ items: rows.map((row) => ({ id: row.id, alias: row.alias, barcodeId: row.contactUser.barcodeId, displayName: row.contactUser.displayName, lastActivityAt: row.lastActivityAt, createdAt: row.createdAt })) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/contacts', async (request, response, next) => {
    try {
      const body = contactSchema.parse(request.body);
      const ownerId = memberClaims(request).sub;
      const target = await userByBarcode(prisma, body.barcodeId);
      if (target.id === ownerId) throw new DomainError('cannot add yourself as a contact');
      const created = await prisma.contact.create({ data: { ownerId, contactUserId: target.id, alias: body.alias }, include: { contactUser: { select: { displayName: true, barcodeId: true } } } });
      response.status(201).json({ id: created.id, alias: created.alias, barcodeId: created.contactUser.barcodeId, displayName: created.contactUser.displayName, lastActivityAt: created.lastActivityAt, createdAt: created.createdAt });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'contact already exists'));
        return;
      }
      next(error);
    }
  });

  router.patch('/contacts/:id', async (request, response, next) => {
    try {
      const body = contactPatchSchema.parse(request.body);
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (contact.ownerId !== memberClaims(request).sub) forbidden();
      const updated = await prisma.contact.update({ where: { id: contact.id }, data: { alias: body.alias }, include: { contactUser: { select: { displayName: true, barcodeId: true } } } });
      response.json({ id: updated.id, alias: updated.alias, barcodeId: updated.contactUser.barcodeId, displayName: updated.contactUser.displayName, lastActivityAt: updated.lastActivityAt, createdAt: updated.createdAt });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/contacts/:id', async (request, response, next) => {
    try {
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (contact.ownerId !== memberClaims(request).sub) forbidden();
      await prisma.contact.delete({ where: { id: contact.id } });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get('/loans', async (request, response, next) => {
    try {
      const userId = memberClaims(request).sub;
      const loans = await prisma.loan.findMany({
        where: { OR: [{ borrowerId: userId }, { lenderId: userId }] },
        include: { installments: true, guarantees: { include: { guarantor: { select: { displayName: true, barcodeId: true } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      response.json({ items: loans.map(serializeLoan) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/loans', async (request, response, next) => {
    try {
      const body = loanSchema.parse(request.body);
      const guarantors = await Promise.all(body.guarantors.map(async (guarantor) => ({ guarantorId: (await userByBarcode(prisma, guarantor.barcodeId)).id, amountCoupons: parseCoupons(guarantor.amountCoupons) })));
      const requested = await createLoanRequest(prisma, {
        borrowerId: memberClaims(request).sub,
        principalCoupons: parseCoupons(body.principalCoupons),
        installments: body.installments.map((installment) => ({ dueAt: new Date(installment.dueAt), amountCoupons: parseCoupons(installment.amountCoupons) })),
        guarantors,
      });
      const loan = await prisma.loan.findUniqueOrThrow({
        where: { id: requested.id },
        include: { installments: true, guarantees: { include: { guarantor: { select: { displayName: true, barcodeId: true } } } } },
      });
      response.status(201).json(serializeLoan(loan));
    } catch (error) {
      next(error);
    }
  });

  router.post('/loans/:id/repay', async (request, response, next) => {
    try {
      const body = repaymentSchema.parse(request.body);
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (loan.borrowerId !== memberClaims(request).sub) forbidden();
      if (loan.lenderId === null) throw new DomainError('loan has no lender');
      await repayLoan(prisma, {
        loanId: loan.id,
        amountCoupons: parseCoupons(body.amountCoupons),
        borrowerAccountId: (await couponAccount(prisma, loan.borrowerId)).id,
        lenderAccountId: (await couponAccount(prisma, loan.lenderId)).id,
        externalRef: `api:me:loan:${loan.id}:repay:${body.idempotencyKey}`,
      });
      const repaid = await prisma.loan.findUniqueOrThrow({
        where: { id: loan.id },
        include: { installments: true, guarantees: { include: { guarantor: { select: { displayName: true, barcodeId: true } } } } },
      });
      response.json(serializeLoan(repaid));
    } catch (error) {
      next(error);
    }
  });

  router.get('/guarantees', async (request, response, next) => {
    try {
      const guarantees = await prisma.guarantee.findMany({
        where: { guarantorId: memberClaims(request).sub },
        include: { loan: { include: { installments: true, guarantees: { include: { guarantor: { select: { displayName: true, barcodeId: true } } } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      response.json({
        items: guarantees.map((guarantee) => ({
          ...serializeGuarantee(guarantee),
          loan: serializeLoan(guarantee.loan),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/guarantees/:id/approve', async (request, response, next) => {
    try {
      const body = approvalSchema.parse(request.body);
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (guarantee.guarantorId !== memberClaims(request).sub) forbidden();
      await verifyMemberPin(prisma, guarantee.guarantorId, body.pin);
      const approved = await approveGuarantee(prisma, {
        guaranteeId: guarantee.id,
        code: body.code,
        guarantorAccountId: (await couponAccount(prisma, guarantee.guarantorId)).id,
        guaranteeLockAccountId: (await systemAccount(prisma, AccountType.GUARANTEE_LOCK, Asset.COUPON)).id,
      });
      response.json(serializeGuarantee(approved));
    } catch (error) {
      next(error);
    }
  });

  router.post('/guarantees/:id/activate', async (request, response, next) => {
    try {
      const body = codeSchema.parse(request.body);
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: pathId(request.params.id) }, include: { loan: true } });
      if (guarantee.loan.borrowerId !== memberClaims(request).sub) forbidden();
      const activated = await activateGuarantee(prisma, { guaranteeId: guarantee.id, code: body.code });
      if (activated === null) throw new DomainError('guarantee activation failed');
      response.json(serializeGuarantee(activated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/guarantees/:id/decline', async (request, response, next) => {
    try {
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: pathId(request.params.id) } });
      if (guarantee.guarantorId !== memberClaims(request).sub) forbidden();
      const declined = await cancelGuarantee(prisma, {
        guaranteeId: guarantee.id,
        guarantorAccountId: (await couponAccount(prisma, guarantee.guarantorId)).id,
        guaranteeLockAccountId: (await systemAccount(prisma, AccountType.GUARANTEE_LOCK, Asset.COUPON)).id,
        declined: true,
      });
      response.json(serializeGuarantee(declined));
    } catch (error) {
      next(error);
    }
  });

  router.post('/media', mediaLimiter, async (request, response, next) => {
    let uploaded: Awaited<ReturnType<typeof uploadMedia>> | undefined;
    try {
      uploaded = await uploadMedia(request, dependencies.config.mediaStorageDir);
      const userId = memberClaims(request).sub;
      if ((uploaded.captureSessionId === undefined) !== (uploaded.captureStep === undefined)) {
        throw new HttpError(400, 'capture session and step are required together');
      }
      if (uploaded.captureSessionId !== undefined && uploaded.captureStep !== undefined && uploaded.kind !== 'IMAGE') {
        throw new HttpError(400, 'identity capture frames must be images');
      }
      const asset = uploaded.captureSessionId === undefined || uploaded.captureStep === undefined
        ? await prisma.mediaAsset.create({
          data: {
            ownerId: userId,
            kind: uploaded.kind,
            mimeType: uploaded.mimeType,
            byteSize: uploaded.byteSize,
            sha256: uploaded.sha256,
            storageKey: uploaded.storageKey,
          },
        })
        : await prisma.$transaction(async (tx) => {
          const captureSessionId = uploaded!.captureSessionId;
          const captureStep = uploaded!.captureStep;
          if (captureSessionId === undefined || captureStep === undefined || !idSchema.safeParse(captureSessionId).success) throw new HttpError(400, 'invalid capture session');
          await tx.$queryRaw`SELECT "id" FROM "IdentityCaptureSession" WHERE "id" = ${captureSessionId}::uuid FOR UPDATE`;
          const session = await tx.identityCaptureSession.findUnique({ where: { id: captureSessionId } });
          if (session === null || session.userId !== userId) throw new HttpError(403, 'forbidden');
          if (session.consumedAt !== null || session.expiresAt <= new Date()) throw new HttpError(409, 'identity capture session is expired or already used');
          if (!session.steps.includes(captureStep)) throw new HttpError(400, 'capture step is not required for this session');
          return tx.mediaAsset.create({
            data: {
              ownerId: userId,
              kind: uploaded!.kind,
              mimeType: uploaded!.mimeType,
              byteSize: uploaded!.byteSize,
              sha256: uploaded!.sha256,
              storageKey: uploaded!.storageKey,
              captureSessionId: session.id,
              captureStep,
            },
          });
        });
      response.status(201).json({ id: asset.id, kind: asset.kind, mimeType: asset.mimeType, byteSize: asset.byteSize });
    } catch (error) {
      if (uploaded !== undefined) {
        await deleteMediaFile(dependencies.config.mediaStorageDir, uploaded.storageKey);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'capture step already uploaded'));
        return;
      }
      next(error);
    }
  });

  router.get('/media/:id', async (request, response, next) => {
    try {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: pathId(request.params.id) },
        include: {
          refundRequest: { select: { buyerId: true, sellerId: true } },
          aidRequest: { include: { charity: { include: { agents: { where: { revokedAt: null }, select: { userId: true } } } } } },
        },
      });
      if (asset === null) throw new HttpError(404, 'resource not found');
      const userId = memberClaims(request).sub;
      const isRefundParty = asset.refundRequest !== null && (asset.refundRequest.buyerId === userId || asset.refundRequest.sellerId === userId);
      const isCharityAgent = asset.aidRequest?.charity.agents.some((agent) => agent.userId === userId) === true;
      if (asset.ownerId !== userId && !isRefundParty && !isCharityAgent) throw new HttpError(404, 'resource not found');
      const file = await mediaPath(dependencies.config.mediaStorageDir, asset.storageKey);
      response.setHeader('Content-Disposition', 'attachment');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      response.type(asset.mimeType);
      response.sendFile(file, (error) => {
        if (error !== undefined && !response.headersSent) next(new HttpError(404, 'resource not found'));
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/refunds', async (request, response, next) => {
    try {
      const body = refundSchema.parse(request.body);
      const created = await createRefundRequest(prisma, {
        transactionId: body.transactionId,
        buyerId: memberClaims(request).sub,
        amountCoupons: parseCoupons(body.amountCoupons),
        reason: body.reason,
        ...(body.mediaIds === undefined ? {} : { mediaIds: body.mediaIds }),
      });
      response.status(201).json({ id: created.id, status: created.status, amountCoupons: created.amountCoupons.toString(), reason: created.reason, createdAt: created.createdAt });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError(409, 'refund is already pending'));
        return;
      }
      next(error);
    }
  });

  router.get('/refunds', async (request, response, next) => {
    try {
      const userId = memberClaims(request).sub;
      const query = refundQuerySchema.parse(request.query);
      const cursor = query.cursor === undefined ? undefined : parseRefundCursor(query.cursor);
      const roleColumn = query.role === 'buyer' ? Prisma.sql`"buyerId"` : Prisma.sql`"sellerId"`;
      const statusPredicate = query.status === undefined ? Prisma.empty : Prisma.sql`AND "status" = ${query.status}::"RefundStatus"`;
      const cursorPredicate = cursor === undefined
        ? Prisma.empty
        : query.status !== undefined || query.role !== 'seller'
          ? Prisma.sql`AND ("createdAt" < ${cursor.createdAt} OR ("createdAt" = ${cursor.createdAt} AND "id" < ${cursor.id}::uuid))`
          : cursor.status === 'PENDING'
            ? Prisma.sql`AND ("status" <> 'PENDING' OR ("status" = 'PENDING' AND ("createdAt" < ${cursor.createdAt} OR ("createdAt" = ${cursor.createdAt} AND "id" < ${cursor.id}::uuid))))`
            : Prisma.sql`AND "status" <> 'PENDING' AND ("createdAt" < ${cursor.createdAt} OR ("createdAt" = ${cursor.createdAt} AND "id" < ${cursor.id}::uuid))`;
      const orderBy = query.role === 'seller'
        ? Prisma.sql`CASE WHEN "status" = 'PENDING' THEN 0 ELSE 1 END ASC, "createdAt" DESC, "id" DESC`
        : Prisma.sql`"createdAt" DESC, "id" DESC`;
      const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "RefundRequest"
        WHERE ${roleColumn} = ${userId}::uuid
        ${statusPredicate}
        ${cursorPredicate}
        ORDER BY ${orderBy}
        LIMIT ${query.limit + 1}
      `);
      const hasMore = ids.length > query.limit;
      const pageIds = (hasMore ? ids.slice(0, query.limit) : ids).map((row) => row.id);
      const rows = await prisma.refundRequest.findMany({
        where: { id: { in: pageIds } },
        include: {
          buyer: { select: { displayName: true, barcodeId: true } },
          seller: { select: { displayName: true, barcodeId: true } },
          transaction: { select: { amountCoupons: true, createdAt: true } },
          media: { select: { id: true } },
        },
      });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const orderedRows = pageIds.flatMap((id) => {
        const row = rowById.get(id);
        return row === undefined ? [] : [row];
      });
      const approved = pageIds.length === 0
        ? []
        : await prisma.refundRequest.groupBy({
          by: ['transactionId'],
          where: { transactionId: { in: orderedRows.map((row) => row.transactionId) }, status: 'APPROVED' },
          _sum: { amountCoupons: true },
        });
      const approvedByTransaction = new Map(approved.map((row) => [row.transactionId, row._sum.amountCoupons ?? 0n]));
      response.json({
        items: orderedRows.map((row) => serializeRefund(row, userId, row.transaction.amountCoupons - (approvedByTransaction.get(row.transactionId) ?? 0n))),
        nextCursor: hasMore && orderedRows.length > 0
          ? refundCursor(orderedRows[orderedRows.length - 1]!.status, orderedRows[orderedRows.length - 1]!.createdAt, orderedRows[orderedRows.length - 1]!.id)
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/refunds/:id', async (request, response, next) => {
    try {
      const userId = memberClaims(request).sub;
      const row = await prisma.refundRequest.findUnique({
        where: { id: pathId(request.params.id) },
        include: {
          buyer: { select: { displayName: true, barcodeId: true } },
          seller: { select: { displayName: true, barcodeId: true } },
          transaction: { select: { amountCoupons: true, createdAt: true } },
          media: { select: { id: true } },
        },
      });
      if (row === null || (row.buyerId !== userId && row.sellerId !== userId)) throw new HttpError(404, 'resource not found');
      const approved = await prisma.refundRequest.aggregate({ where: { transactionId: row.transactionId, status: 'APPROVED' }, _sum: { amountCoupons: true } });
      response.json(serializeRefund(row, userId, row.transaction.amountCoupons - (approved._sum.amountCoupons ?? 0n)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/refunds/:id/approve', async (request, response, next) => {
    try {
      const body = z.object({ pin: fourDigitCodeSchema }).parse(request.body);
      const userId = memberClaims(request).sub;
      await verifyMemberPin(prisma, userId, body.pin);
      const approved = await approveRefund(prisma, { refundRequestId: pathId(request.params.id), sellerId: userId });
      response.json({ id: approved.id, status: approved.status, refundTransactionId: approved.refundTransactionId });
    } catch (error) {
      next(error);
    }
  });

  router.post('/refunds/:id/reject', async (request, response, next) => {
    try {
      const body = noteSchema.parse(request.body);
      const rejected = await rejectRefund(prisma, { refundRequestId: pathId(request.params.id), sellerId: memberClaims(request).sub, note: body.note });
      response.json({ id: rejected.id, status: rejected.status, decisionNote: rejected.decisionNote });
    } catch (error) {
      next(error);
    }
  });

  router.get('/charities', async (_request, response, next) => {
    try {
      const charities = await prisma.charity.findMany({ where: { isActive: true }, select: { id: true, name: true, description: true }, orderBy: { name: 'asc' } });
      response.json({ items: charities });
    } catch (error) {
      next(error);
    }
  });

  router.post('/charities/:id/donations', async (request, response, next) => {
    try {
      const body = charityDonationSchema.parse(request.body);
      const userId = memberClaims(request).sub;
      await verifyMemberPin(prisma, userId, body.pin);
      const charity = await prisma.charity.findUnique({ where: { id: pathId(request.params.id) } });
      if (charity === null || !charity.isActive) throw new HttpError(404, 'charity not found');
      const transaction = await donateToCharity(prisma, {
        memberId: userId,
        memberAccountId: (await couponAccount(prisma, userId)).id,
        charityAccountId: (await prisma.ledgerAccount.findFirstOrThrow({ where: { charityId: charity.id, type: AccountType.CHARITY_COUPON, asset: Asset.COUPON } })).id,
        amountCoupons: parseCoupons(body.amountCoupons),
        externalRef: `api:me:charity:${charity.id}:${userId}:${body.idempotencyKey ?? randomUUID()}`,
      });
      response.status(201).json({ transactionId: transaction.id, status: transaction.status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/aid-requests', async (request, response, next) => {
    try {
      const body = aidRequestSchema.parse(request.body);
      const created = await createAidRequest(prisma, {
        applicantId: memberClaims(request).sub,
        charityId: body.charityId,
        amountCoupons: parseCoupons(body.amountCoupons),
        description: body.description,
        ...(body.loanId === undefined ? {} : { loanId: body.loanId }),
        ...(body.mediaIds === undefined ? {} : { mediaIds: body.mediaIds }),
      });
      const media = await prisma.mediaAsset.findMany({ where: { aidRequestId: created.id }, select: { id: true } });
      response.status(201).json(serializeAid({ ...created, media }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/aid-requests/:id/documents', async (request, response, next) => {
    try {
      const body = aidDocumentsSchema.parse(request.body);
      const updated = await attachAidDocuments(prisma, { aidRequestId: pathId(request.params.id), applicantId: memberClaims(request).sub, mediaIds: body.mediaIds });
      const media = await prisma.mediaAsset.findMany({ where: { aidRequestId: updated.id }, select: { id: true } });
      response.json(serializeAid({ ...updated, media }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/aid-requests', async (request, response, next) => {
    try {
      const rows = await prisma.aidRequest.findMany({
        where: { applicantId: memberClaims(request).sub },
        include: { media: { select: { id: true } }, charity: { select: { name: true } }, loan: { select: { id: true, principalCoupons: true, outstandingCoupons: true, status: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      response.json({ items: rows.map(serializeAid) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/charity-requests', async (request, response, next) => {
    try {
      const query = charityQuerySchema.parse(request.query);
      const agents = await prisma.charityAgent.findMany({ where: { userId: memberClaims(request).sub, revokedAt: null }, select: { charityId: true } });
      if (agents.length === 0) {
        response.json({ items: [] });
        return;
      }
      const rows = await prisma.aidRequest.findMany({
        where: { charityId: { in: agents.map((agent) => agent.charityId) }, ...(query.status === undefined ? {} : { status: query.status }) },
        include: {
          media: { select: { id: true } },
          applicant: { select: { displayName: true, barcodeId: true } },
          charity: { select: { name: true } },
          loan: { select: { id: true, principalCoupons: true, outstandingCoupons: true, status: true } },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });
      response.json({ items: rows.map(serializeAid) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/charity-requests/:id/approve', async (request, response, next) => {
    try {
      const body = aidApprovalSchema.parse(request.body);
      const userId = memberClaims(request).sub;
      await verifyMemberPin(prisma, userId, body.pin);
      const approved = await approveAidRequest(prisma, {
        aidRequestId: pathId(request.params.id),
        agentId: userId,
        ...(body.approvedCoupons === undefined ? {} : { approvedCoupons: parseCoupons(body.approvedCoupons) }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      response.json({ id: approved.id, status: approved.status, approvedCoupons: approved.approvedCoupons?.toString() ?? null, disbursementTransactionId: approved.disbursementTransactionId });
    } catch (error) {
      next(error);
    }
  });

  router.post('/charity-requests/:id/reject', async (request, response, next) => {
    try {
      const body = noteSchema.parse(request.body);
      const rejected = await rejectAidRequest(prisma, { aidRequestId: pathId(request.params.id), agentId: memberClaims(request).sub, note: body.note });
      response.json({ id: rejected.id, status: rejected.status, decisionNote: rejected.decisionNote });
    } catch (error) {
      next(error);
    }
  });

  router.post('/charity-requests/:id/request-documents', async (request, response, next) => {
    try {
      const body = noteSchema.parse(request.body);
      const updated = await requestAidDocuments(prisma, { aidRequestId: pathId(request.params.id), agentId: memberClaims(request).sub, note: body.note });
      response.json({ id: updated.id, status: updated.status, decisionNote: updated.decisionNote });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
