import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@trustme/db';
import type { ApiConfig } from './config.js';
import type { QueueLike } from './app.js';
import { HttpError } from './http-error.js';

export type PhoneCodeResult = {
  id: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  deliveryStatus: 'PENDING' | 'SENT' | 'FAILED';
  deliveryError: string | null;
};

export async function issuePhoneCode(
  prisma: PrismaClient,
  config: ApiConfig,
  smsQueue: QueueLike,
  logSmsCode: ((phone: string, code: string) => void) | undefined,
  userId: string,
  phone: string,
): Promise<PhoneCodeResult> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const recent = await prisma.phoneVerification.findMany({
    where: { phone, createdAt: { gte: hourAgo } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const latest = recent[0];
  if (latest !== undefined && now.getTime() - latest.createdAt.getTime() < 60_000) {
    throw new HttpError(429, 'please wait before requesting a new code', {
      retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now.getTime() - latest.createdAt.getTime())) / 1000)),
    });
  }
  if (recent.length >= 5) {
    const oldest = recent.at(-1);
    if (oldest === undefined) throw new HttpError(429, 'please wait before requesting a new code');
    throw new HttpError(429, 'please wait before requesting a new code', {
      retryAfterSeconds: Math.max(1, Math.ceil((oldest.createdAt.getTime() + 60 * 60_000 - now.getTime()) / 1000)),
    });
  }
  if (config.smsDelivery === 'none') throw new HttpError(503, 'sms delivery not configured');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const verification = await prisma.phoneVerification.create({
    data: {
      userId,
      phone,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: new Date(now.getTime() + 5 * 60_000),
      deliveryStatus: config.smsDelivery === 'log' ? 'SENT' : 'PENDING',
    },
  });
  if (config.smsDelivery === 'log') {
    logSmsCode?.(phone, code);
  } else {
    await smsQueue.add('send-otp', { phoneVerificationId: verification.id, phone, code }, {
      jobId: verification.id,
      attempts: 3,
      backoff: { type: 'sms-relay' },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
  return {
    id: verification.id,
    expiresAt: verification.expiresAt,
    resendAvailableAt: new Date(verification.createdAt.getTime() + 60_000),
    deliveryStatus: verification.deliveryStatus,
    deliveryError: verification.deliveryError,
  };
}

export async function verifyPhoneCode(prisma: PrismaClient, userId: string, phone: string, code: string): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "PhoneVerification"
      WHERE "userId" = ${userId}::uuid
        AND "phone" = ${phone}
        AND "consumedAt" IS NULL
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const verification = locked[0] === undefined
      ? null
      : await tx.phoneVerification.findUnique({ where: { id: locked[0].id } });
    if (verification === null || verification.expiresAt <= new Date() || verification.attempts >= 5) return false;
    if (!await bcrypt.compare(code, verification.codeHash)) {
      const attempts = verification.attempts + 1;
      await tx.phoneVerification.update({
        where: { id: verification.id },
        data: { attempts, ...(attempts >= 5 ? { consumedAt: new Date() } : {}) },
      });
      return false;
    }
    const now = new Date();
    await tx.phoneVerification.update({ where: { id: verification.id }, data: { consumedAt: now } });
    await tx.user.update({ where: { id: userId }, data: { phoneVerifiedAt: now } });
    return true;
  });
  if (!result) throw new HttpError(401, 'invalid phone verification code');
}
