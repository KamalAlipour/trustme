import { timingSafeEqual } from 'node:crypto';
import { HDNodeWallet } from 'ethers';
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
  withSerializableRetry,
  evmAddressSchema,
  DomainError,
} from '@trustme/core';
import { type ApiConfig } from './config.js';
import { openapiDocument } from './openapi.js';
import { createAdminRouter, EthersAdminChainProvider, type AdminChainProvider } from './admin.js';
import { HttpError } from './http-error.js';

export { HttpError } from './http-error.js';

type RedisLike = { ping(): Promise<string> };
export type QueueLike = Pick<Queue, 'add'>;

const couponsSchema = z.string().regex(/^[1-9]\d*$/, 'amountCoupons must be a positive decimal string');
const userBodySchema = z.object({
  phone: z.string().min(1),
  barcodeId: barcodeIdSchema,
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

export type ApiDependencies = {
  config: ApiConfig;
  prisma: PrismaClient;
  queue: QueueLike;
  redis: RedisLike;
  chainProvider?: AdminChainProvider;
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

function serializeUser(user: { id: string; phoneNumber: string; barcodeId: string; aliasName: string | null }, depositAddress: string | null) {
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
      'authorization',
      'token',
      'jwt',
      'req.headers.authorization',
      'req.body.code',
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
  // Member-facing authentication is deferred to a later handoff.
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
      const existing = await prisma.user.findUnique({ where: { barcodeId: body.barcodeId } });
      if (existing) {
        const address = await prisma.depositAddress.findFirst({ where: { userId: existing.id } });
        response.status(200).json(serializeUser(existing, address?.address ?? null));
        return;
      }
      const user = await withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
        const created = await tx.user.create({ data: { phoneNumber: body.phone, barcodeId: body.barcodeId, ...(body.alias === undefined ? {} : { aliasName: body.alias }) } });
        await tx.ledgerAccount.create({ data: { type: AccountType.USER_COUPON, asset: Asset.COUPON, userId: created.id } });
        await tx.ledgerAccount.create({ data: { type: AccountType.ESCROW, asset: Asset.COUPON, userId: created.id } });
        const depositAddress = await tx.depositAddress.create({ data: { userId: created.id, address: `pending:${created.id}` } });
        const derived = HDNodeWallet.fromExtendedKey(config.depositXpub).deriveChild(depositAddress.derivationIndex);
        return tx.depositAddress.update({ where: { id: depositAddress.id }, data: { address: derived.address } }).then(() => created);
      });
      const address = await prisma.depositAddress.findFirstOrThrow({ where: { userId: user.id } });
      response.status(201).json(serializeUser(user, address.address));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.user.findUnique({ where: { barcodeId: userBodySchema.parse(request.body).barcodeId } });
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
      const transaction = await transferCoupons(prisma, { userId: source.user.id, externalRef: `api:transfer:${body.idempotencyKey}`, fromAccountId: source.account.id, toAccountId: destination.account.id, amountCoupons: parseCoupons(body.amountCoupons) });
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
      const values = await prisma.systemSetting.findMany({ where: { key: { in: ['WITHDRAWAL_BASE_FEE_BPS', 'MIN_WITHDRAWAL_USDT', 'AUTO_APPROVAL_LIMIT_USDT'] } } });
      const settings = new Map(values.map((setting) => [setting.key, setting.value]));
      const baseFeeBps = BigInt(settings.get('WITHDRAWAL_BASE_FEE_BPS') ?? (() => { throw new Error('missing fee setting'); })());
      const minimum = microUsdtFromDecimal(settings.get('MIN_WITHDRAWAL_USDT') ?? (() => { throw new Error('missing minimum setting'); })());
      const autoApproval = microUsdtFromDecimal(settings.get('AUTO_APPROVAL_LIMIT_USDT') ?? (() => { throw new Error('missing approval setting'); })());
      const vault = await systemAccount(prisma, AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
      const fees = await systemAccount(prisma, AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT);
      const pending = await systemAccount(prisma, AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT);
      const issuance = await systemAccount(prisma, AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
      const withdrawal = await requestWithdrawal(prisma, { userId: member.user.id, userAccountId: member.account.id, destinationAddress: evmAddressSchema.parse(body.destinationAddress), couponsGross: parseCoupons(body.couponsGross), baseFeeBps, minimumWithdrawalMicroUsdt: minimum, autoApprovalLimitMicroUsdt: autoApproval, vaultAccountId: vault.id, feeAccountId: fees.id, pendingAccountId: pending.id, issuanceAccountId: issuance.id });
      if (withdrawal.status === WithdrawalStatus.APPROVED) await queue.add('dispatch', { withdrawalId: withdrawal.id }, { jobId: withdrawal.id });
      response.status(201).json(serializeWithdrawal(withdrawal));
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
      response.status(error.status).json({ error: error.message });
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
function serializeWithdrawal(withdrawal: { id: string; status: WithdrawalStatus; couponsGross: bigint; grossMicroUsdt: bigint; feeMicroUsdt: bigint; netMicroUsdt: bigint; chainTxHash: string | null }) {
  return { id: withdrawal.id, status: withdrawal.status, couponsGross: withdrawal.couponsGross.toString(), grossUsdt: decimalFromMicroUsdt(withdrawal.grossMicroUsdt), feeUsdt: decimalFromMicroUsdt(withdrawal.feeMicroUsdt), netUsdt: decimalFromMicroUsdt(withdrawal.netMicroUsdt), chainTxHash: withdrawal.chainTxHash };
}

export async function createApiRuntime(config: ApiConfig): Promise<{ app: express.Express; prisma: PrismaClient; redis: Redis; queue: Queue }> {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const redis = new Redis(config.redisUrl);
  const queue = new Queue('trustme-withdrawal-dispatch', { connection: redis });
  return { app: createApp({ config, prisma, queue, redis, chainProvider: new EthersAdminChainProvider(config.polygonRpcUrl) }), prisma, redis, queue };
}
