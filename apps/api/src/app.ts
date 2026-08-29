import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  AccountType,
  Asset,
  Prisma,
  PrismaClient,
  WithdrawalStatus,
} from '@trustme/db';
import {
  barcodeIdSchema,
  createEscrowHold,
  decimalFromMicroUsdt,
  fourDigitCodeSchema,
  microUsdtFromDecimal,
  requestWithdrawal,
  releaseEscrow,
  cancelEscrow,
  transferCoupons,
  evmAddressSchema,
  DomainError,
  activateGuarantee,
  approveGuarantee,
  cancelGuarantee,
  claimGuarantees,
  createLoanRequest,
  disburseLoan,
  readWithdrawalAvailability,
  repayLoan,
} from '@trustme/core';
import { type ApiConfig } from './config.js';
import { openapiDocument } from './openapi.js';
import { createAdminRouter, EthersAdminChainProvider, type AdminChainProvider } from './admin.js';
import { HttpError } from './http-error.js';
import { createMemberAuthRouter, createMemberSecurityRouter, requireMember } from './member-auth.js';
import { createMemberRouter } from './member-router.js';
import { provisionUser } from './user-provisioning.js';

export { HttpError } from './http-error.js';

type RedisLike = { ping(): Promise<string> };
export type QueueLike = Pick<Queue, 'add'>;

function useConfiguredCors(app: express.Express, allowedOrigins: string[]): void {
  const allowed = new Set(allowedOrigins);
  app.use((request, response, next) => {
    const origin = request.header('origin');
    if (origin === undefined || !allowed.has(origin)) {
      next();
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });
}

const couponsSchema = z.string().regex(/^[1-9]\d*$/, 'amountCoupons must be a positive decimal string');
const userBodySchema = z.object({
  phone: z.string().min(1),
  barcodeId: barcodeIdSchema.optional(),
  alias: z.string().min(1).optional(),
});
const transferBodySchema = z.object({
  fromBarcodeId: barcodeIdSchema,
  toBarcodeId: barcodeIdSchema,
  amountCoupons: couponsSchema,
  idempotencyKey: z.string().min(1),
});
const escrowBodySchema = z.object({
  senderBarcodeId: barcodeIdSchema,
  recipientBarcodeId: barcodeIdSchema,
  amountCoupons: couponsSchema,
  code: fourDigitCodeSchema,
  expiresAt: z.string().datetime(),
  idempotencyKey: z.string().min(1).optional(),
});
const releaseBodySchema = z.object({ code: fourDigitCodeSchema });
const withdrawalBodySchema = z.object({
  barcodeId: barcodeIdSchema,
  destinationAddress: evmAddressSchema,
  couponsGross: couponsSchema,
});
const loanInstallmentSchema = z.object({ dueAt: z.string().datetime(), amountCoupons: couponsSchema });
const loanGuarantorSchema = z.object({
  barcodeId: barcodeIdSchema.optional(),
  guarantorId: z.string().uuid().optional(),
  amountCoupons: couponsSchema,
}).refine((value) => value.barcodeId !== undefined || value.guarantorId !== undefined, 'guarantor identity is required');
const loanBodySchema = z.object({
  barcodeId: barcodeIdSchema,
  principalCoupons: couponsSchema,
  installments: z.array(loanInstallmentSchema).min(1),
  guarantors: z.array(loanGuarantorSchema).min(1),
});
const codeBodySchema = z.object({ code: fourDigitCodeSchema });
const lenderBodySchema = z.object({ barcodeId: barcodeIdSchema });
const repaymentBodySchema = z.object({ amountCoupons: couponsSchema, idempotencyKey: z.string().min(1) });
const availabilityQuerySchema = z.object({ barcodeId: barcodeIdSchema });

export type ApiDependencies = {
  config: ApiConfig;
  prisma: PrismaClient;
  queue: QueueLike;
  redis: RedisLike;
  chainProvider?: AdminChainProvider;
  emailSender?: import('./member-auth.js').EmailSender;
  logEmailCode?: (email: string, code: string) => void;
  verifyGoogleIdToken?: import('./social-auth.js').MemberIdTokenVerifier;
  verifyAppleIdToken?: import('./social-auth.js').MemberIdTokenVerifier;
  checkShahkarMatch?: typeof import('./shahkar.js').checkShahkarMatch;
};

function serviceTokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

async function userWithAccounts(prisma: PrismaClient, barcodeId: string) {
  const user = await prisma.user.findUnique({ where: { barcodeId } });
  if (!user) throw new HttpError(404, 'member not found');
  const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
  return { user, account };
}

async function accountForUserId(prisma: PrismaClient, userId: string) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}

async function systemAccount(prisma: PrismaClient, type: AccountType, asset: Asset) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { type, asset, userId: null } });
}

function serializeUser(user: { id: string; phoneNumber: string | null; barcodeId: string; aliasName: string | null }, depositAddress: string | null) {
  return { id: user.id, phone: user.phoneNumber, barcodeId: user.barcodeId, alias: user.aliasName, depositAddress };
}

export function createApp(dependencies: ApiDependencies): express.Express {
  const { config, prisma, queue, redis } = dependencies;
  const logger = pino({
    redact: [
      'code',
      'password',
      'passwordHash',
      'privateKey',
      'HOT_WALLET_PRIVATE_KEY',
      'ADMIN_JWT_SECRET',
      'MEMBER_JWT_SECRET',
      'authorization',
      'token',
      'jwt',
      'req.headers.authorization',
      'req.body.code',
      'req.body.pin',
      'req.body.currentPin',
      'req.body.newPin',
      'req.body.refreshToken',
      'emailCode',
      'req.body.password',
      'req.body.token',
      'res.body.token',
    ],
  });
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(pinoHttp({ logger }));
  app.use('/v1', rateLimit({ windowMs: config.rateLimitWindowMs, limit: config.rateLimitMax, standardHeaders: true, legacyHeaders: false }));
  useConfiguredCors(app, config.allowedOrigins);
  const logEmailCode = dependencies.logEmailCode ?? ((email: string, code: string) => logger.info({ email }, `member email code ${code}`));
  app.use('/v1/auth', createMemberAuthRouter({
    config,
    prisma,
    ...(dependencies.emailSender === undefined ? {} : { emailSender: dependencies.emailSender }),
    logEmailCode,
    ...(dependencies.verifyGoogleIdToken === undefined ? {} : { verifyGoogleIdToken: dependencies.verifyGoogleIdToken }),
    ...(dependencies.verifyAppleIdToken === undefined ? {} : { verifyAppleIdToken: dependencies.verifyAppleIdToken }),
  }));
  app.use('/v1/me', requireMember(config.memberJwtSecret, prisma), createMemberRouter({
    config,
    prisma,
    queue,
    ...(dependencies.emailSender === undefined ? {} : { emailSender: dependencies.emailSender }),
    logEmailCode,
    ...(dependencies.checkShahkarMatch === undefined ? {} : { checkShahkarMatch: dependencies.checkShahkarMatch }),
  }));
  app.use('/v1/member', requireMember(config.memberJwtSecret, prisma), createMemberSecurityRouter({
    config,
    prisma,
    ...(dependencies.emailSender === undefined ? {} : { emailSender: dependencies.emailSender }),
    logEmailCode,
  }));
  app.use('/v1', (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!serviceTokenMatches(config.apiServiceToken, token)) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  app.use('/admin', createAdminRouter({ config, prisma, queue, chainProvider: dependencies.chainProvider }));

  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  app.get('/readyz', async (_request, response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      response.json({ status: 'ready' });
    } catch {
      response.status(503).json({ status: 'not_ready' });
    }
  });
  app.get('/openapi.json', (_request, response) => response.json(openapiDocument));
  app.use('/docs', (_request, response) => response.type('html').send('<!doctype html><html><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'));

  app.post('/v1/users', async (request, response, next) => {
    try {
      const body = userBodySchema.parse(request.body);
      const existing = body.barcodeId === undefined
        ? null
        : await prisma.user.findUnique({ where: { barcodeId: body.barcodeId } });
      if (existing) {
        const address = await prisma.depositAddress.findFirst({ where: { userId: existing.id } });
        response.status(200).json(serializeUser(existing, address?.address ?? null));
        return;
      }
      const user = await provisionUser(prisma, config, {
        phoneNumber: body.phone,
        ...(body.barcodeId === undefined ? {} : { barcodeId: body.barcodeId }),
        ...(body.alias === undefined ? {} : { aliasName: body.alias }),
      });
      const address = await prisma.depositAddress.findFirstOrThrow({ where: { userId: user.id } });
      response.status(201).json(serializeUser(user, address.address));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const body = userBodySchema.parse(request.body);
        const existing = body.barcodeId === undefined
          ? await prisma.user.findUnique({ where: { phoneNumber: body.phone } })
          : await prisma.user.findFirst({ where: { OR: [{ barcodeId: body.barcodeId }, { phoneNumber: body.phone }] } });
        if (existing) {
          const address = await prisma.depositAddress.findFirst({ where: { userId: existing.id } });
          response.status(200).json(serializeUser(existing, address?.address ?? null));
          return;
        }
      }
      next(error);
    }
  });

  app.get('/v1/users/:barcodeId/balance', async (request, response, next) => {
    try {
      const { user, account } = await userWithAccounts(prisma, barcodeIdSchema.parse(request.params.barcodeId));
      const address = await prisma.depositAddress.findFirst({ where: { userId: user.id } });
      response.json({ barcodeId: user.barcodeId, coupons: account.balance.toString(), dustMicroUsdt: decimalFromMicroUsdt(user.dustMicroUsdt), depositAddress: address?.address ?? null });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/transfers', async (request, response, next) => {
    try {
      const body = transferBodySchema.parse(request.body);
      const source = await userWithAccounts(prisma, body.fromBarcodeId);
      const destination = await userWithAccounts(prisma, body.toBarcodeId);
      const transaction = await transferCoupons(prisma, { userId: source.user.id, counterpartyUserId: destination.user.id, externalRef: `api:transfer:${body.idempotencyKey}`, fromAccountId: source.account.id, toAccountId: destination.account.id, amountCoupons: parseCoupons(body.amountCoupons) });
      response.status(201).json({ transactionId: transaction.id, status: transaction.status });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/escrows', async (request, response, next) => {
    try {
      const body = escrowBodySchema.parse(request.body);
      const sender = await userWithAccounts(prisma, body.senderBarcodeId);
      const recipient = await userWithAccounts(prisma, body.recipientBarcodeId);
      const escrowAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.ESCROW, asset: Asset.COUPON, userId: sender.user.id } });
      const hold = await createEscrowHold(prisma, { senderId: sender.user.id, recipientId: recipient.user.id, senderAccountId: sender.account.id, escrowAccountId: escrowAccount.id, amountCoupons: parseCoupons(body.amountCoupons), code: fourDigitCodeSchema.parse(body.code), expiresAt: new Date(body.expiresAt), ...(body.idempotencyKey === undefined ? {} : { externalRef: `api:escrow:${body.idempotencyKey}` }) });
      response.status(201).json({ id: hold.id, status: hold.status, amountCoupons: hold.amountCoupons.toString(), expiresAt: hold.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/escrows/:id/release', async (request, response, next) => {
    try {
      const body = releaseBodySchema.parse(request.body);
      const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: request.params.id } });
      const recipient = await accountForUserId(prisma, hold.recipientId);
      const released = await releaseEscrow(prisma, { holdId: hold.id, recipientAccountId: recipient.id, code: fourDigitCodeSchema.parse(body.code) });
      response.json({ id: released?.id, status: released?.status });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/escrows/:id/cancel', async (request, response, next) => {
    try {
      const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: request.params.id } });
      const sender = await userWithAccounts(prisma, hold.senderId);
      const cancelled = await cancelEscrow(prisma, { holdId: hold.id, senderAccountId: sender.account.id });
      response.json({ id: cancelled.id, status: cancelled.status });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/withdrawals', async (request, response, next) => {
    try {
      const body = withdrawalBodySchema.parse(request.body);
      const member = await userWithAccounts(prisma, body.barcodeId);
      const values = await prisma.systemSetting.findMany({ where: { key: { in: ['WITHDRAWAL_BASE_FEE_BPS', 'WITHDRAWAL_MIN_FEE_USDT', 'MIN_WITHDRAWAL_USDT', 'AUTO_APPROVAL_LIMIT_USDT', 'WITHDRAWAL_COOLDOWN_HOURS', 'REQUIRE_IDENTITY_FOR_WITHDRAWAL'] } } });
      const settings = new Map(values.map((setting) => [setting.key, setting.value]));
      const baseFeeBps = BigInt(settings.get('WITHDRAWAL_BASE_FEE_BPS') ?? (() => { throw new Error('missing fee setting'); })());
      const minimumFee = microUsdtFromDecimal(settings.get('WITHDRAWAL_MIN_FEE_USDT') ?? (() => { throw new Error('missing minimum fee setting'); })());
      const minimum = microUsdtFromDecimal(settings.get('MIN_WITHDRAWAL_USDT') ?? (() => { throw new Error('missing minimum setting'); })());
      const autoApproval = microUsdtFromDecimal(settings.get('AUTO_APPROVAL_LIMIT_USDT') ?? (() => { throw new Error('missing approval setting'); })());
      const vault = await systemAccount(prisma, AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
      const fees = await systemAccount(prisma, AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT);
      const pending = await systemAccount(prisma, AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT);
      const issuance = await systemAccount(prisma, AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
      const cooldownHours = Number(settings.get('WITHDRAWAL_COOLDOWN_HOURS') ?? '168');
      const requireIdentityVerification = (settings.get('REQUIRE_IDENTITY_FOR_WITHDRAWAL') ?? 'true') === 'true';
      const withdrawal = await requestWithdrawal(prisma, { userId: member.user.id, userAccountId: member.account.id, destinationAddress: evmAddressSchema.parse(body.destinationAddress), couponsGross: parseCoupons(body.couponsGross), baseFeeBps, minimumFeeMicroUsdt: minimumFee, minimumWithdrawalMicroUsdt: minimum, autoApprovalLimitMicroUsdt: autoApproval, cooldownHours, requireIdentityVerification, vaultAccountId: vault.id, feeAccountId: fees.id, pendingAccountId: pending.id, issuanceAccountId: issuance.id });
      if (withdrawal.status === WithdrawalStatus.APPROVED) await queue.add('dispatch', { withdrawalId: withdrawal.id }, { jobId: withdrawal.id });
      response.status(201).json(serializeWithdrawal(withdrawal));
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/withdrawals/availability', async (request, response, next) => {
    try {
      const { barcodeId } = availabilityQuerySchema.parse(request.query);
      const member = await userWithAccounts(prisma, barcodeId);
      const requireIdentityVerification = (await prisma.systemSetting.findUnique({ where: { key: 'REQUIRE_IDENTITY_FOR_WITHDRAWAL' } }))?.value !== 'false';
      const availability = await readWithdrawalAvailability(prisma, member.user.id, { requireIdentityVerification });
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

  app.post('/v1/loans', async (request, response, next) => {
    try {
      const body = loanBodySchema.parse(request.body);
      const borrower = await userWithAccounts(prisma, body.barcodeId);
      const guarantors = await Promise.all(body.guarantors.map(async (guarantor) => {
        const guarantorId = guarantor.barcodeId !== undefined
          ? (await userWithAccounts(prisma, guarantor.barcodeId)).user.id
          : guarantor.guarantorId!;
        await prisma.user.findUniqueOrThrow({ where: { id: guarantorId } });
        return { guarantorId, amountCoupons: parseCoupons(guarantor.amountCoupons) };
      }));
      const loan = await createLoanRequest(prisma, {
        borrowerId: borrower.user.id,
        principalCoupons: parseCoupons(body.principalCoupons),
        installments: body.installments.map((installment) => ({ dueAt: new Date(installment.dueAt), amountCoupons: parseCoupons(installment.amountCoupons) })),
        guarantors,
      });
      response.status(201).json(serializeLoan(loan));
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/loans', async (request, response, next) => {
    try {
      const { barcodeId } = availabilityQuerySchema.parse(request.query);
      const member = await userWithAccounts(prisma, barcodeId);
      const loans = await prisma.loan.findMany({ where: { OR: [{ borrowerId: member.user.id }, { lenderId: member.user.id }] }, include: { installments: true, guarantees: true }, orderBy: { createdAt: 'desc' } });
      response.json({ items: loans.map(serializeLoan) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/guarantees', async (request, response, next) => {
    try {
      const { barcodeId } = availabilityQuerySchema.parse(request.query);
      const member = await userWithAccounts(prisma, barcodeId);
      const guarantees = await prisma.guarantee.findMany({ where: { guarantorId: member.user.id }, include: { loan: true }, orderBy: { createdAt: 'desc' } });
      response.json({ items: guarantees.map((guarantee) => ({ ...guarantee, amountCoupons: guarantee.amountCoupons.toString(), loan: serializeLoan(guarantee.loan) })) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/guarantees/:id/approve', async (request, response, next) => {
    try {
      const body = codeBodySchema.parse(request.body);
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: request.params.id } });
      const guarantor = { account: await accountForUserId(prisma, guarantee.guarantorId) };
      const lock = await systemAccount(prisma, AccountType.GUARANTEE_LOCK, Asset.COUPON);
      const approved = await approveGuarantee(prisma, { guaranteeId: guarantee.id, code: body.code, guarantorAccountId: guarantor.account.id, guaranteeLockAccountId: lock.id });
      response.json(serializeGuarantee(approved));
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/guarantees/:id/activate', async (request, response, next) => {
    try {
      const body = codeBodySchema.parse(request.body);
      const activated = await activateGuarantee(prisma, { guaranteeId: request.params.id, code: body.code });
      if (activated === null) throw new DomainError('guarantee activation failed');
      response.json(serializeGuarantee(activated));
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/guarantees/:id/cancel', async (request, response, next) => {
    try {
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: request.params.id } });
      const guarantor = { account: await accountForUserId(prisma, guarantee.guarantorId) };
      const lock = await systemAccount(prisma, AccountType.GUARANTEE_LOCK, Asset.COUPON);
      const cancelled = await cancelGuarantee(prisma, { guaranteeId: guarantee.id, guarantorAccountId: guarantor.account.id, guaranteeLockAccountId: lock.id });
      response.json(serializeGuarantee(cancelled));
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/guarantees/:id/decline', async (request, response, next) => {
    try {
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: request.params.id } });
      const guarantor = { account: await accountForUserId(prisma, guarantee.guarantorId) };
      const lock = await systemAccount(prisma, AccountType.GUARANTEE_LOCK, Asset.COUPON);
      const declined = await cancelGuarantee(prisma, { guaranteeId: guarantee.id, guarantorAccountId: guarantor.account.id, guaranteeLockAccountId: lock.id, declined: true });
      response.json(serializeGuarantee(declined));
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/loans/:id/disburse', async (request, response, next) => {
    try {
      const body = lenderBodySchema.parse(request.body);
      const lender = await userWithAccounts(prisma, body.barcodeId);
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: request.params.id } });
      const borrowerAccount = await accountForUserId(prisma, loan.borrowerId);
      response.json(serializeLoan(await disburseLoan(prisma, { loanId: loan.id, lenderId: lender.user.id, lenderAccountId: lender.account.id, borrowerAccountId: borrowerAccount.id })));
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/loans/:id/repay', async (request, response, next) => {
    try {
      const body = repaymentBodySchema.parse(request.body);
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: request.params.id } });
      if (loan.lenderId === null) throw new DomainError('loan has no lender');
      const borrowerAccount = await accountForUserId(prisma, loan.borrowerId);
      const lenderAccount = await accountForUserId(prisma, loan.lenderId);
      response.json(serializeLoan(await repayLoan(prisma, { loanId: loan.id, amountCoupons: parseCoupons(body.amountCoupons), borrowerAccountId: borrowerAccount.id, lenderAccountId: lenderAccount.id, externalRef: `api:loan:${loan.id}:repay:${body.idempotencyKey}` })));
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/loans/:id/claim', async (request, response, next) => {
    try {
      const body = lenderBodySchema.parse(request.body);
      const lender = await userWithAccounts(prisma, body.barcodeId);
      response.json(serializeLoan(await claimGuarantees(prisma, { loanId: request.params.id, lenderAccountId: lender.account.id })));
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/withdrawals/:id', async (request, response, next) => {
    try {
      const withdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: request.params.id } });
      response.json(serializeWithdrawal(withdrawal));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    void next;
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: 'validation failed',
        fields: error.issues.map((issue) => ({
          path: issue.path.map((part) => String(part)).join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.message, ...(error.details ?? {}) });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      response.status(404).json({ error: 'resource not found' });
      return;
    }
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    request.log.error({ err: error }, 'request failed');
    response.status(500).json({ error: 'internal server error' });
  });
  return app;
}

function parseCoupons(value: string): bigint {
  return BigInt(value);
}
function serializeWithdrawal(withdrawal: { id: string; status: WithdrawalStatus; couponsGross: bigint; grossMicroUsdt: bigint; feeMicroUsdt: bigint; netMicroUsdt: bigint; chainTxHash: string | null; eligibleAt?: Date }) {
  return { id: withdrawal.id, status: withdrawal.status, couponsGross: withdrawal.couponsGross.toString(), grossUsdt: decimalFromMicroUsdt(withdrawal.grossMicroUsdt), feeUsdt: decimalFromMicroUsdt(withdrawal.feeMicroUsdt), netUsdt: decimalFromMicroUsdt(withdrawal.netMicroUsdt), chainTxHash: withdrawal.chainTxHash, eligibleAt: withdrawal.eligibleAt ?? null };
}

function serializeLoan(loan: {
  id: string;
  borrowerId: string;
  lenderId?: string | null;
  principalCoupons: bigint;
  outstandingCoupons: bigint;
  status: string;
  createdAt: Date;
  fundedAt?: Date | null;
  settledAt?: Date | null;
  installments?: Array<{ id: string; sequence: number; dueAt: Date; amountCoupons: bigint; paidCoupons: bigint; paidAt: Date | null }>;
  guarantees?: Array<{ id: string; guarantorId: string; amountCoupons: bigint; status: string; wrongAttempts: number; lockedAt?: Date | null; activatedAt?: Date | null; resolvedAt?: Date | null }>;
}) {
  return {
    id: loan.id,
    borrowerId: loan.borrowerId,
    lenderId: loan.lenderId ?? null,
    principalCoupons: loan.principalCoupons.toString(),
    outstandingCoupons: loan.outstandingCoupons.toString(),
    status: loan.status,
    createdAt: loan.createdAt,
    fundedAt: loan.fundedAt ?? null,
    settledAt: loan.settledAt ?? null,
    installments: loan.installments?.map((installment) => ({
      ...installment,
      amountCoupons: installment.amountCoupons.toString(),
      paidCoupons: installment.paidCoupons.toString(),
    })),
    guarantees: loan.guarantees?.map(serializeGuarantee),
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

export async function createApiRuntime(config: ApiConfig): Promise<{ app: express.Express; prisma: PrismaClient; redis: Redis; queue: Queue }> {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const redis = new Redis(config.redisUrl);
  const queue = new Queue('trustme-withdrawal-dispatch', { connection: redis });
  return { app: createApp({ config, prisma, queue, redis, chainProvider: new EthersAdminChainProvider(config.polygonRpcUrl) }), prisma, redis, queue };
}
