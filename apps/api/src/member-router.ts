import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AccountType,
  Asset,
  EmailVerificationPurpose,
  Prisma,
  PrismaClient,
  WithdrawalStatus,
} from '@trustme/db';
import {
  activateGuarantee,
  approveGuarantee,
  barcodeIdSchema,
  cancelEscrow,
  cancelGuarantee,
  createEscrowHold,
  createLoanRequest,
  decimalFromMicroUsdt,
  evmAddressSchema,
  fourDigitCodeSchema,
  microUsdtFromDecimal,
  readWithdrawalAvailability,
  releaseEscrow,
  repayLoan,
  requestWithdrawal,
  transferCoupons,
} from '@trustme/core';
import { DomainError } from '@trustme/core';
import type { QueueLike } from './app.js';
import { HttpError } from './http-error.js';
import { isWeakPin, issueEmailCode, memberClaims, serializeMember, smtpSender, verifyEmailCode, verifyMemberPin } from './member-auth.js';
import type { ApiConfig } from './config.js';

export type MemberRouterDependencies = {
  config: ApiConfig;
  prisma: PrismaClient;
  queue: QueueLike;
  emailSender?: import('./member-auth.js').EmailSender;
  logEmailCode?: (email: string, code: string) => void;
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

function parseCoupons(value: string): bigint {
  return BigInt(value);
}

function forbidden(): never {
  throw new HttpError(403, 'forbidden');
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

export function createMemberRouter(dependencies: MemberRouterDependencies): express.Router {
  const { prisma, queue } = dependencies;
  const sender = dependencies.emailSender ?? smtpSender(dependencies.config);
  const router = express.Router();

  router.get('/', async (request, response, next) => {
    try {
      response.json(serializeMember(await member(prisma, memberClaims(request).sub)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/', async (request, response, next) => {
    try {
      const body = z.object({ displayName: displayNameSchema }).parse(request.body);
      const updated = await prisma.user.update({ where: { id: memberClaims(request).sub }, data: { displayName: body.displayName } });
      response.json(serializeMember(updated));
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
      await prisma.user.update({ where: { id: userId }, data: { email, emailVerifiedAt: null } });
      await issueEmailCode(prisma, dependencies.config, sender, dependencies.logEmailCode, userId, email, EmailVerificationPurpose.VERIFY_EMAIL);
      response.status(202).json({ expiresAt: new Date(Date.now() + 15 * 60_000) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/email/verify', async (request, response, next) => {
    try {
      const body = emailCodeSchema.parse(request.body);
      const user = await member(prisma, memberClaims(request).sub);
      if (user.email === null) throw new HttpError(400, 'email is not set');
      await verifyEmailCode(prisma, user.id, user.email, EmailVerificationPurpose.VERIFY_EMAIL, body.code);
      const updated = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      response.json(serializeMember(updated));
    } catch (error) {
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
      const device = await prisma.memberDevice.findUniqueOrThrow({ where: { id: request.params.id } });
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
      const availability = await readWithdrawalAvailability(prisma, memberClaims(request).sub);
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
      response.json({
        items: page.map((row) => {
          const outgoing = row.fromAccountId === userAccount.id;
          const counterpartyAccount = outgoing ? row.toAccount : row.fromAccount;
          return {
            id: row.id,
            direction: outgoing ? 'out' : 'in',
            amountCoupons: row.amount.toString(),
            counterparty: counterpartyAccount.user === null
              ? { systemAccountType: counterpartyAccount.type }
              : { displayName: counterpartyAccount.user.displayName, barcodeId: counterpartyAccount.user.barcodeId },
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
        externalRef: `api:me:transfer:${body.idempotencyKey}`,
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
        ...(body.idempotencyKey === undefined ? {} : { externalRef: `api:me:escrow:${body.idempotencyKey}` }),
      });
      response.status(201).json({ id: hold.id, status: hold.status, amountCoupons: hold.amountCoupons.toString(), expiresAt: hold.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.post('/escrows/:id/release', async (request, response, next) => {
    try {
      const body = codeSchema.parse(request.body);
      const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: request.params.id } });
      if (hold.recipientId !== memberClaims(request).sub) forbidden();
      const released = await releaseEscrow(prisma, { holdId: hold.id, recipientAccountId: (await couponAccount(prisma, hold.recipientId)).id, code: body.code });
      response.json({ id: released?.id, status: released?.status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/escrows/:id/cancel', async (request, response, next) => {
    try {
      const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: request.params.id } });
      if (hold.senderId !== memberClaims(request).sub) forbidden();
      const cancelled = await cancelEscrow(prisma, { holdId: hold.id, senderAccountId: (await couponAccount(prisma, hold.senderId)).id });
      response.json({ id: cancelled.id, status: cancelled.status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/withdrawals', async (request, response, next) => {
    try {
      const body = withdrawalSchema.parse(request.body);
      const user = await member(prisma, memberClaims(request).sub);
      await verifyMemberPin(prisma, user.id, body.pin);
      const values = await prisma.systemSetting.findMany({ where: { key: { in: ['WITHDRAWAL_BASE_FEE_BPS', 'MIN_WITHDRAWAL_USDT', 'AUTO_APPROVAL_LIMIT_USDT', 'WITHDRAWAL_COOLDOWN_HOURS'] } } });
      const settings = new Map(values.map((setting) => [setting.key, setting.value]));
      const baseFeeBps = BigInt(settings.get('WITHDRAWAL_BASE_FEE_BPS') ?? (() => { throw new Error('missing fee setting'); })());
      const minimum = microUsdtFromDecimal(settings.get('MIN_WITHDRAWAL_USDT') ?? '0');
      const autoApproval = microUsdtFromDecimal(settings.get('AUTO_APPROVAL_LIMIT_USDT') ?? '0');
      const withdrawal = await requestWithdrawal(prisma, {
        userId: user.id,
        userAccountId: (await couponAccount(prisma, user.id)).id,
        destinationAddress: body.destinationAddress,
        couponsGross: parseCoupons(body.couponsGross),
        baseFeeBps,
        minimumWithdrawalMicroUsdt: minimum,
        autoApprovalLimitMicroUsdt: autoApproval,
        cooldownHours: Number(settings.get('WITHDRAWAL_COOLDOWN_HOURS') ?? '168'),
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
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: request.params.id } });
      if (contact.ownerId !== memberClaims(request).sub) forbidden();
      const updated = await prisma.contact.update({ where: { id: contact.id }, data: { alias: body.alias }, include: { contactUser: { select: { displayName: true, barcodeId: true } } } });
      response.json({ id: updated.id, alias: updated.alias, barcodeId: updated.contactUser.barcodeId, displayName: updated.contactUser.displayName, lastActivityAt: updated.lastActivityAt, createdAt: updated.createdAt });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/contacts/:id', async (request, response, next) => {
    try {
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: request.params.id } });
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
      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: request.params.id } });
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
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: request.params.id } });
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
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: request.params.id }, include: { loan: true } });
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
      const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { id: request.params.id } });
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

  return router;
}
