import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { EmailVerificationPurpose, IdentityProvider, Prisma, PrismaClient } from '@trustme/db';
import { generateBarcodeId, phoneNumberSchema, fourDigitCodeSchema, withSerializableRetry } from '@trustme/core';
import { HttpError } from './http-error.js';
import { createUserWithAccounts, isBarcodeUniqueViolation, isEmailUniqueViolation, provisionUser } from './user-provisioning.js';
import type { ApiConfig } from './config.js';
import { verifyAppleIdToken, verifyGoogleIdToken, type VerifiedSocialClaims } from './social-auth.js';

export type EmailSender = {
  send(to: string, subject: string, body: string): Promise<void>;
};

export type MemberClaims = { sub: string; typ: 'member'; sid: string; iat: number; exp: number };
export type MemberAuthDependencies = {
  config: ApiConfig;
  prisma: PrismaClient;
  emailSender?: EmailSender;
  logEmailCode?: (email: string, code: string) => void;
  verifyGoogleIdToken?: (idToken: string, audiences: readonly string[]) => Promise<VerifiedSocialClaims>;
  verifyAppleIdToken?: (idToken: string, audiences: readonly string[]) => Promise<VerifiedSocialClaims>;
};

const dummyPinHash = bcrypt.hash(randomBytes(32).toString('hex'), 12);
const genericLoginError = new HttpError(401, 'invalid phone or PIN');
const emailCodePattern = /^\d{6}$/;
const installationIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const registerSchema = z.object({
  phone: phoneNumberSchema,
  pin: fourDigitCodeSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
  email: z.string().email().optional(),
});
const loginSchema = z.object({ phone: phoneNumberSchema, pin: fourDigitCodeSchema });

function emailValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) throw new HttpError(400, 'invalid email');
  return value.trim().toLowerCase();
}
function installationIdFrom(request: Request): string | null {
  return request.header('x-installation-id') ?? null;
}
function base64url(value: string): string { return Buffer.from(value).toString('base64url'); }
function signature(value: string, secret: string): string { return createHmac('sha256', secret).update(value).digest('base64url'); }

export function createMemberJwt(userId: string, sid: string, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: userId, typ: 'member', sid, iat: now, exp: now + ttlSeconds }))}`;
  return `${body}.${signature(body, secret)}`;
}

export function verifyMemberJwt(token: string, secret: string): MemberClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, providedSignature] = parts;
  if (!header || !payload || !providedSignature) return null;
  const expected = Buffer.from(signature(`${header}.${payload}`, secret));
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<MemberClaims>;
    if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT' || claims.typ !== 'member' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return { sub: claims.sub, typ: 'member', sid: claims.sid, iat: claims.iat, exp: claims.exp };
  } catch { return null; }
}

export type MemberRequest = Request & { member?: MemberClaims };
export type SecuritySetupStatus = {
  emailVerified: boolean;
  biometricEnrolled: boolean;
  biometricPending: boolean;
  requiresEmailVerification: boolean;
  remaining: Array<'pin' | 'email_verification' | 'biometric_enrolment'>;
  completedAt: Date | null;
};

export function securitySetupStatus(user: {
  pinHash: string | null;
  emailVerifiedAt: Date | null;
  biometricEnrolledAt: Date | null;
  setupAcknowledgedAt: Date | null;
  securitySetupCompletedAt: Date | null;
}, requireEmailVerification: boolean): SecuritySetupStatus {
  const remaining: Array<'pin' | 'email_verification' | 'biometric_enrolment'> = [];
  if (user.pinHash === null) remaining.push('pin');
  if (requireEmailVerification && user.emailVerifiedAt === null) remaining.push('email_verification');
  if (user.biometricEnrolledAt === null && user.setupAcknowledgedAt === null) remaining.push('biometric_enrolment');
  return {
    emailVerified: user.emailVerifiedAt !== null,
    biometricEnrolled: user.biometricEnrolledAt !== null,
    biometricPending: user.biometricEnrolledAt === null && user.setupAcknowledgedAt !== null,
    requiresEmailVerification: requireEmailVerification,
    remaining,
    completedAt: user.securitySetupCompletedAt,
  };
}

export async function recomputeSecuritySetupCompletion(
  tx: Prisma.TransactionClient,
  userId: string,
  requireEmailVerification: boolean,
) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { pinHash: true, emailVerifiedAt: true, biometricEnrolledAt: true, setupAcknowledgedAt: true, securitySetupCompletedAt: true },
  });
  const complete = user.pinHash !== null &&
    (user.biometricEnrolledAt !== null || user.setupAcknowledgedAt !== null) &&
    (!requireEmailVerification || user.emailVerifiedAt !== null);
  return tx.user.update({
    where: { id: userId },
    data: { securitySetupCompletedAt: complete ? (user.securitySetupCompletedAt ?? new Date()) : null },
  });
}
export function memberClaims(request: Request): MemberClaims {
  const claims = (request as MemberRequest).member;
  if (!claims) throw new Error('member authentication required');
  return claims;
}

export function requireMember(secret: string, prisma: PrismaClient): RequestHandler {
  return async (request, response, next) => {
    try {
      const value = request.header('authorization');
      const token = value?.startsWith('Bearer ') ? value.slice(7) : undefined;
      const claims = token === undefined ? null : verifyMemberJwt(token, secret);
      if (!claims) { response.status(401).json({ error: 'unauthorized' }); return; }
      const device = await prisma.memberDevice.findUnique({ where: { id: claims.sid } });
      if (!device || device.userId !== claims.sub || device.revokedAt !== null || device.expiresAt <= new Date()) { response.status(401).json({ error: 'unauthorized' }); return; }
      if (device.lastSeenAt <= new Date(Date.now() - 5 * 60_000)) {
        await prisma.memberDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
      }
      (request as MemberRequest).member = claims;
      next();
    } catch (error) { next(error); }
  };
}

export function requireCompletedSetup(config: ApiConfig, prisma: PrismaClient): RequestHandler {
  return async (request, response, next) => {
    try {
      const claims = memberClaims(request);
      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: { pinHash: true, emailVerifiedAt: true, biometricEnrolledAt: true, setupAcknowledgedAt: true, securitySetupCompletedAt: true },
      });
      if (user === null) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }
      const setup = securitySetupStatus(user, config.requireEmailVerification);
      if (setup.remaining.length > 0 || setup.completedAt === null) {
        response.status(403).json({ error: 'setup_incomplete', remaining: setup.remaining });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function isWeakPin(pin: string): boolean {
  if (!fourDigitCodeSchema.safeParse(pin).success || /^(\d)\1{3}$/.test(pin)) return true;
  const digits = pin.split('').map(Number);
  return digits.every((digit, index) => index === 0 || digit === digits[index - 1]! + 1) || digits.every((digit, index) => index === 0 || digit === digits[index - 1]! - 1);
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  return `${local?.slice(0, 1) ?? ''}****@${domain}`;
}
export function maskPhone(phoneNumber: string | null): string | null {
  if (phoneNumber === null) return null;
  const digits = phoneNumber.replace(/\D/g, '');
  return `*-*-${digits.slice(-4).padStart(4, '*')}`;
}
export function serializeMember(user: {
  id: string;
  displayName: string | null;
  barcodeId: string;
  phoneNumber: string | null;
  country: string | null;
  email: string | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  kycStatus: string;
  activeGuaranteeCount: number;
  identityVerificationStatus: string;
  identityVerifiedAt: Date | null;
}) {
  return {
    id: user.id,
    displayName: user.displayName,
    barcodeId: user.barcodeId,
    phone: maskPhone(user.phoneNumber),
    email: maskEmail(user.email),
    emailVerified: user.emailVerifiedAt !== null,
    phoneVerified: user.phoneVerifiedAt !== null,
    country: user.country,
    kycStatus: user.kycStatus,
    activeGuaranteeCount: user.activeGuaranteeCount,
    isRestricted: user.activeGuaranteeCount > 0,
    identityVerification: {
      status: user.identityVerificationStatus,
      verifiedAt: user.identityVerifiedAt,
    },
  };
}

export async function verifyMemberPin(prisma: PrismaClient, userId: string, pin: string): Promise<void> {
  const result = await withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return 'invalid' as const;
    const now = new Date();
    if (user.pinLockedUntil && user.pinLockedUntil > now) return { locked: true as const, retryAfter: Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / 1000) };
    const valid = await bcrypt.compare(pin, user.pinHash ?? await dummyPinHash);
    if (valid && user.pinHash) {
      await tx.user.update({ where: { id: user.id }, data: { pinAttempts: 0, pinLockCount: 0, pinLockedUntil: null } });
      return 'valid' as const;
    }
    const attempts = user.pinAttempts + 1;
    if (attempts < 5) { await tx.user.update({ where: { id: user.id }, data: { pinAttempts: attempts } }); return 'invalid' as const; }
    const lockCount = user.pinLockCount + 1;
    const lockSeconds = Math.min(15 * 60 * (2 ** (lockCount - 1)), 24 * 60 * 60);
    await tx.user.update({ where: { id: user.id }, data: { pinAttempts: 0, pinLockCount: lockCount, pinLockedUntil: new Date(now.getTime() + lockSeconds * 1000) } });
    return { locked: true as const, retryAfter: lockSeconds };
  });
  if (result === 'valid') return;
  if (typeof result === 'object' && result.locked) throw new HttpError(423, 'pin temporarily locked', { retryAfter: result.retryAfter });
  throw genericLoginError;
}

async function createSession(prisma: PrismaClient, config: ApiConfig, userId: string, label: string, installationId: string | null) {
  const refreshToken = randomBytes(32).toString('base64url');
  const refreshExpiresAt = new Date(Date.now() + config.memberRefreshTtlDays * 86_400_000);
  const normalizedInstallationId = installationId !== null && installationIdPattern.test(installationId) ? installationId : null;
  const device = await withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    const existing = normalizedInstallationId === null ? null : await tx.memberDevice.findFirst({
      where: { userId, installationId: normalizedInstallationId, revokedAt: null, replacedById: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing !== null) {
      return tx.memberDevice.update({
        where: { id: existing.id },
        data: {
          refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'),
          label,
          expiresAt: refreshExpiresAt,
          lastSeenAt: new Date(),
        },
      });
    }
    return tx.memberDevice.create({
      data: {
        userId,
        ...(normalizedInstallationId === null ? {} : { installationId: normalizedInstallationId }),
        label,
        refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'),
        expiresAt: refreshExpiresAt,
      },
    });
  });
  return { accessToken: createMemberJwt(userId, device.id, config.memberJwtSecret, config.memberJwtTtlSeconds), expiresAt: new Date(Date.now() + config.memberJwtTtlSeconds * 1000), refreshToken, refreshExpiresAt };
}
async function tokenResponse(prisma: PrismaClient, config: ApiConfig, userId: string, label: string, installationId: string | null) {
  const tokens = await createSession(prisma, config, userId, label, installationId);
  return { tokens, member: serializeMember(await prisma.user.findUniqueOrThrow({ where: { id: userId } })) };
}

async function socialTokenResponse(
  dependencies: MemberAuthDependencies,
  provider: 'GOOGLE' | 'APPLE',
  claims: VerifiedSocialClaims,
  displayName: string | undefined,
  label: string,
  installationId: string | null,
) {
  const { prisma, config } = dependencies;
  const existing = await prisma.userIdentity.findUnique({
    where: {
      provider_subject: {
        provider: provider === 'GOOGLE' ? IdentityProvider.GOOGLE : IdentityProvider.APPLE,
        subject: claims.subject,
      },
    },
  });
  if (existing) {
    if (claims.emailVerified && claims.email !== null) {
      await withSerializableRetry(prisma, async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: existing.userId },
          select: { email: true, emailVerifiedAt: true },
        });
        if (user === null || user.email !== claims.email || user.emailVerifiedAt !== null) return;
        const now = new Date();
        await tx.user.update({ where: { id: existing.userId }, data: { emailVerifiedAt: now } });
        await recomputeSecuritySetupCompletion(tx, existing.userId, config.requireEmailVerification);
      });
    }
    return tokenResponse(prisma, config, existing.userId, label, installationId);
  }
  let omitEmail = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const user = await withSerializableRetry(prisma, async (tx) => {
        const emailTaken = claims.email !== null &&
          await tx.user.findUnique({ where: { email: claims.email }, select: { id: true } }) !== null;
        const created = await createUserWithAccounts(tx, config, {
          phoneNumber: null,
          ...(displayName === undefined ? {} : { displayName }),
          ...(claims.email === null || emailTaken || omitEmail ? {} : {
            email: claims.email,
            ...(claims.emailVerified ? { emailVerifiedAt: new Date() } : {}),
          }),
          barcodeId: generateBarcodeId(),
        });
        await tx.userIdentity.create({
          data: {
            userId: created.id,
            provider: provider === 'GOOGLE' ? IdentityProvider.GOOGLE : IdentityProvider.APPLE,
            subject: claims.subject,
            email: claims.email,
          },
        });
        return created;
      });
      return tokenResponse(prisma, config, user.id, label, installationId);
    } catch (error) {
      if (isEmailUniqueViolation(error) && claims.email !== null && !omitEmail) {
        omitEmail = true;
        continue;
      }
      if (!isBarcodeUniqueViolation(error) || attempt === 4) throw error;
    }
  }
  throw new Error('barcode generation failed');
}

export function smtpSender(config: ApiConfig): EmailSender | undefined {
  if (config.emailDelivery !== 'smtp') return undefined;
  const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, auth: { user: config.smtpUser, pass: config.smtpPassword } });
  return { send: async (to, subject, body) => { await transport.sendMail({ from: config.smtpFrom, to, subject, text: body }); } };
}
export async function issueEmailCode(prisma: PrismaClient, config: ApiConfig, sender: EmailSender | undefined, log: ((email: string, code: string) => void) | undefined, userId: string, email: string, purpose: EmailVerificationPurpose) {
  const count = await prisma.emailVerification.count({ where: { userId, purpose, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } });
  if (count >= 3) throw new HttpError(429, 'too many email code requests');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.emailVerification.create({ data: { userId, email, purpose, codeHash: await bcrypt.hash(code, 10), expiresAt: new Date(Date.now() + 15 * 60_000) } });
  if (config.emailDelivery === 'log') log?.(email, code);
  if (sender) await sender.send(email, purpose === EmailVerificationPurpose.PIN_RESET ? 'Trust Coupon PIN reset' : 'Verify your Trust Coupon email', `Your code is ${code}`);
}
export async function verifyEmailCode(prisma: PrismaClient, userId: string, email: string, purpose: EmailVerificationPurpose, code: string) {
  const result = await withSerializableRetry(prisma, async (tx) => {
    const verification = await tx.emailVerification.findFirst({ where: { userId, email, purpose, consumedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!verification || verification.expiresAt <= new Date() || verification.attempts >= 5) return 'invalid' as const;
    await tx.$queryRaw`SELECT id FROM "EmailVerification" WHERE id = ${verification.id}::uuid FOR UPDATE`;
    if (!await bcrypt.compare(code, verification.codeHash)) {
      const attempts = verification.attempts + 1;
      await tx.emailVerification.update({ where: { id: verification.id }, data: { attempts, ...(attempts >= 5 ? { consumedAt: new Date() } : {}) } });
      return 'invalid' as const;
    }
    await tx.emailVerification.update({ where: { id: verification.id }, data: { consumedAt: new Date() } });
    return 'valid' as const;
  });
  if (result !== 'valid') throw new HttpError(401, 'invalid email verification code');
}

export async function verifyAndSetEmail(prisma: PrismaClient, userId: string, code: string, requireEmailVerification: boolean) {
  const result = await withSerializableRetry(prisma, async (tx) => {
    const verification = await tx.emailVerification.findFirst({
      where: { userId, purpose: EmailVerificationPurpose.VERIFY_EMAIL, consumedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!verification || verification.expiresAt <= new Date() || verification.attempts >= 5) return null;
    await tx.$queryRaw`SELECT id FROM "EmailVerification" WHERE id = ${verification.id}::uuid FOR UPDATE`;
    if (!await bcrypt.compare(code, verification.codeHash)) {
      const attempts = verification.attempts + 1;
      await tx.emailVerification.update({
        where: { id: verification.id },
        data: { attempts, ...(attempts >= 5 ? { consumedAt: new Date() } : {}) },
      });
      return null;
    }
    const now = new Date();
    await tx.emailVerification.update({ where: { id: verification.id }, data: { consumedAt: now } });
    await tx.user.update({ where: { id: userId }, data: { email: verification.email, emailVerifiedAt: now } });
    return recomputeSecuritySetupCompletion(tx, userId, requireEmailVerification);
  });
  if (result === null) throw new HttpError(401, 'invalid email verification code');
  return result;
}

export function createMemberAuthRouter(dependencies: MemberAuthDependencies): express.Router {
  const { config, prisma, emailSender: injectedSender, logEmailCode } = dependencies;
  const sender = injectedSender ?? smtpSender(config);
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false });
  const register = (value: unknown) => {
    const input = registerSchema.parse(value);
    if (isWeakPin(input.pin)) throw new HttpError(400, 'PIN is too weak');
    const email = input.email === undefined ? undefined : emailValue(input.email);
    return { ...input, ...(email === undefined ? {} : { email }) };
  };

  router.post('/register', limiter, async (request, response, next) => {
    try {
      const body = register(request.body);
      if (await prisma.user.findUnique({ where: { phoneNumber: body.phone } })) throw new HttpError(409, 'phone already registered');
      const pinUpdatedAt = new Date();
      const user = await provisionUser(prisma, config, {
        phoneNumber: body.phone,
        pinHash: await bcrypt.hash(body.pin, 12),
        pinUpdatedAt,
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        ...(body.email === undefined ? {} : { email: body.email }),
      }, generateBarcodeId);
      if (body.email !== undefined && config.emailDelivery !== 'none') {
        await issueEmailCode(prisma, config, sender, logEmailCode, user.id, body.email, EmailVerificationPurpose.VERIFY_EMAIL);
      }
      response.status(201).json(await tokenResponse(prisma, config, user.id, request.header('x-device-label') ?? 'Unknown device', installationIdFrom(request)));
    } catch (error) { next(isBarcodeUniqueViolation(error) ? new HttpError(409, 'could not allocate member barcode') : error); }
  });
  router.post('/login', limiter, async (request, response, next) => {
    try {
      const body = loginSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { phoneNumber: body.phone } });
      if (!user) { await bcrypt.compare(body.pin, await dummyPinHash); throw genericLoginError; }
      await verifyMemberPin(prisma, user.id, body.pin);
      response.json(await tokenResponse(prisma, config, user.id, request.header('x-device-label') ?? 'Unknown device', installationIdFrom(request)));
    } catch (error) { next(error); }
  });
  const socialLogin = (provider: 'GOOGLE' | 'APPLE') => async (request: express.Request, response: express.Response, next: express.NextFunction) => {
    try {
      const body = z.object({
        idToken: z.string().min(1),
        displayName: z.string().trim().min(1).max(128).optional(),
      }).parse(request.body);
      const audiences = provider === 'GOOGLE' ? (config.googleOAuthClientIds ?? []) : (config.appleOAuthAudiences ?? []);
      if (audiences.length === 0) {
        response.status(503).json({ error: 'provider_disabled' });
        return;
      }
      const verifier = provider === 'GOOGLE'
        ? (dependencies.verifyGoogleIdToken ?? verifyGoogleIdToken)
        : (dependencies.verifyAppleIdToken ?? verifyAppleIdToken);
      const claims = await verifier(body.idToken, audiences);
      response.status(200).json(await socialTokenResponse(
        dependencies,
        provider,
        claims,
        provider === 'APPLE' ? body.displayName : undefined,
        request.header('x-device-label') ?? 'Unknown device',
        installationIdFrom(request),
      ));
    } catch (error) { next(error); }
  };
  router.post('/google', limiter, socialLogin('GOOGLE'));
  router.post('/apple', limiter, socialLogin('APPLE'));
  router.post('/refresh', limiter, async (request, response, next) => {
    try {
      const value = request.body?.refreshToken;
      if (typeof value !== 'string' || value.length === 0) throw new HttpError(401, 'unauthorized');
      const refreshHash = createHash('sha256').update(value).digest('hex');
      const result = await withSerializableRetry(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "MemberDevice" WHERE "refreshTokenHash" = ${refreshHash} FOR UPDATE`;
        const device = await tx.memberDevice.findUnique({ where: { refreshTokenHash: refreshHash } });
        if (!device) return { kind: 'missing' as const };
        if (device.revokedAt !== null || device.replacedById !== null) {
          await tx.memberDevice.updateMany({ where: { userId: device.userId, revokedAt: null }, data: { revokedAt: new Date() } });
          return { kind: 'reused' as const };
        }
        if (device.expiresAt <= new Date()) return { kind: 'expired' as const };
        const refreshToken = randomBytes(32).toString('base64url');
        const refreshExpiresAt = new Date(Date.now() + config.memberRefreshTtlDays * 86_400_000);
        const replacement = await tx.memberDevice.create({
          data: {
            userId: device.userId,
            label: device.label,
            installationId: device.installationId,
            refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'),
            expiresAt: refreshExpiresAt,
          },
        });
        const now = new Date();
        await tx.memberDevice.update({ where: { id: device.id }, data: { revokedAt: now, replacedById: replacement.id } });
        return {
          kind: 'rotated' as const,
          userId: device.userId,
          sid: replacement.id,
          refreshToken,
          refreshExpiresAt,
          expiresAt: new Date(Date.now() + config.memberJwtTtlSeconds * 1000),
        };
      });
      if (result.kind !== 'rotated') throw new HttpError(401, 'unauthorized');
      const member = serializeMember(await prisma.user.findUniqueOrThrow({ where: { id: result.userId } }));
      response.json({
        tokens: {
          accessToken: createMemberJwt(result.userId, result.sid, config.memberJwtSecret, config.memberJwtTtlSeconds),
          expiresAt: result.expiresAt,
          refreshToken: result.refreshToken,
          refreshExpiresAt: result.refreshExpiresAt,
        },
        member,
      });
    } catch (error) { next(error); }
  });
  router.post('/pin-reset/request', limiter, async (request, response, next) => {
    try {
      const email = emailValue(request.body?.email);
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || user.emailVerifiedAt === null) { response.status(202).json({ expiresAt: new Date(Date.now() + 15 * 60_000) }); return; }
      if (config.emailDelivery === 'none') throw new HttpError(503, 'email delivery not configured');
      await issueEmailCode(prisma, config, sender, logEmailCode, user.id, email, EmailVerificationPurpose.PIN_RESET);
      response.status(202).json({ expiresAt: new Date(Date.now() + 15 * 60_000) });
    } catch (error) { next(error); }
  });
  router.post('/pin-reset/confirm', limiter, async (request, response, next) => {
    try {
      const email = emailValue(request.body?.email);
      const code = String(request.body?.code ?? '');
      const pin = String(request.body?.pin ?? '');
      if (!emailCodePattern.test(code)) throw new HttpError(400, 'code must be exactly six digits');
      if (!fourDigitCodeSchema.safeParse(pin).success || isWeakPin(pin)) throw new HttpError(400, 'PIN is too weak');
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || user.emailVerifiedAt === null) throw new HttpError(401, 'invalid email verification code');
      await verifyEmailCode(prisma, user.id, email, EmailVerificationPurpose.PIN_RESET, code);
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash(pin, 12), pinUpdatedAt: new Date(), pinAttempts: 0, pinLockCount: 0, pinLockedUntil: null, pinResetQuarantineUntil: new Date(Date.now() + config.pinResetQuarantineHours * 60 * 60 * 1000), biometricEnrolledAt: null, setupAcknowledgedAt: null, securitySetupCompletedAt: null } }),
        prisma.memberDevice.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
      response.json(await tokenResponse(prisma, config, user.id, request.header('x-device-label') ?? 'Unknown device', installationIdFrom(request)));
    } catch (error) { next(error); }
  });
  return router;
}

export function createMemberSecurityRouter(dependencies: MemberAuthDependencies): express.Router {
  const router = express.Router();
  router.post('/security/pin', async (request, response, next) => {
    try {
      const body = z.object({ pin: fourDigitCodeSchema }).parse(request.body);
      if (isWeakPin(body.pin)) throw new HttpError(400, 'PIN is too weak');
      const userId = memberClaims(request).sub;
      await withSerializableRetry(dependencies.prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        if (user.pinHash !== null) throw new HttpError(409, 'PIN already exists');
        await tx.user.update({
          where: { id: userId },
          data: { pinHash: await bcrypt.hash(body.pin, 12), pinUpdatedAt: new Date() },
        });
        return recomputeSecuritySetupCompletion(tx, userId, dependencies.config.requireEmailVerification);
      });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });
  router.post('/security/biometric', async (request, response, next) => {
    try {
      const body = z.object({ pin: fourDigitCodeSchema, biometricEnrolled: z.boolean() }).parse(request.body);
      const userId = memberClaims(request).sub;
      await verifyMemberPin(dependencies.prisma, userId, body.pin);
      const updated = await withSerializableRetry(dependencies.prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
        await tx.user.update({
          where: { id: userId },
          data: body.biometricEnrolled
            ? { biometricEnrolledAt: new Date() }
            : { setupAcknowledgedAt: new Date() },
        });
        return recomputeSecuritySetupCompletion(tx, userId, dependencies.config.requireEmailVerification);
      });
      response.json(securitySetupStatus(updated, dependencies.config.requireEmailVerification));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
