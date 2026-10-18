import bcrypt from 'bcryptjs';
import { AccountType, Asset, prisma } from '@trustme/db';
import { issueDemoCoupons } from '@trustme/core';
import { provisionUser } from './user-provisioning.js';
import { isWeakPin } from './member-auth.js';

const REVIEW_DEMO_COUPONS = 500n;

async function main(): Promise<void> {
  const phones = (process.env.REVIEW_LOGIN_PHONES ?? '').split(',').map((phone) => phone.trim()).filter(Boolean);
  const pin = process.env.REVIEW_LOGIN_PIN ?? '';
  const depositXpub = process.env.DEPOSIT_XPUB;
  if (phones.length === 0) throw new Error('REVIEW_LOGIN_PHONES is required');
  if (!/^\d{4}$/.test(pin) || isWeakPin(pin)) throw new Error('REVIEW_LOGIN_PIN must be a strong four-digit PIN');
  if (!depositXpub) throw new Error('DEPOSIT_XPUB is required');
  const pinHash = await bcrypt.hash(pin, 12);
  for (const phoneNumber of phones) {
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existing !== null && !existing.isDemo) throw new Error(`review phone belongs to a non-demo user: ${phoneNumber}`);
    const user = existing === null
      ? await provisionUser(prisma, { depositXpub }, { phoneNumber, pinHash, pinUpdatedAt: new Date(), displayName: 'App Review', isDemo: true })
      : await prisma.user.update({ where: { id: existing.id }, data: { pinHash, pinUpdatedAt: new Date(), pinAttempts: 0, pinLockCount: 0, pinLockedUntil: null } });
    await prisma.user.update({ where: { id: user.id }, data: { securitySetupCompletedAt: user.securitySetupCompletedAt ?? new Date(), setupAcknowledgedAt: user.setupAcknowledgedAt ?? new Date() } });
    const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    const issuance = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.SYSTEM_DEMO_ISSUANCE, asset: Asset.COUPON, userId: null } });
    await issueDemoCoupons(prisma, {
      userId: user.id,
      userCouponAccountId: account.id,
      demoIssuanceAccountId: issuance.id,
      amountCoupons: REVIEW_DEMO_COUPONS,
      externalRef: `review:${user.id}:issue`,
    });
    console.log(`${existing === null ? 'created' : 'updated'} review account ${phoneNumber} (${user.barcodeId})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
