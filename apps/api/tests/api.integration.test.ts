import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getAddress, HDNodeWallet } from 'ethers';
import { Redis } from 'ioredis';
import bcrypt from 'bcryptjs';
import { AccountType, AdminRole, Asset, PrismaClient, WithdrawalStatus } from '@trustme/db';
import { createLoanRequest, postDeposit } from '@trustme/core';
import { createApp, type ApiDependencies } from '../src/app.js';
import { provisionUser } from '../src/user-provisioning.js';
import { createMemberJwt } from '../src/member-auth.js';
import { createAdminJwt } from '../src/admin-auth.js';
import type { AdminChainProvider } from '../src/admin.js';

const prisma = new PrismaClient();
const token = 'test-service-token';
const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: 'redis://localhost:56379',
  apiServiceToken: token,
  depositXpub: HDNodeWallet.createRandom().neuter().extendedKey,
  adminJwtSecret: 'test-admin-jwt-secret-32-characters-long!',
  adminJwtTtlSeconds: 3600,
  memberJwtSecret: 'test-member-jwt-secret-32-characters-long!',
  memberJwtTtlSeconds: 900,
  memberRefreshTtlDays: 60,
  emailDelivery: 'log' as const,
  requireEmailVerification: false,
  pinResetQuarantineHours: 72,
  smtpHost: undefined,
  smtpPort: undefined,
  smtpUser: undefined,
  smtpPassword: undefined,
  smtpFrom: undefined,
  nodeEnv: 'test',
  polygonRpcUrl: 'http://127.0.0.1:8545',
  usdtContractAddress: getAddress(`0x${'99'.repeat(20)}`),
  hotWalletAddress: getAddress(`0x${'aa'.repeat(20)}`),
  port: 3100,
  bodyLimit: '32kb',
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100,
  bindHost: '127.0.0.1',
  failoverMarkerPath: '/tmp/trustme-marker',
  mediaStorageDir: '/tmp/trustme-media',
  allowedOrigins: [],
};

async function account(type: AccountType, asset: Asset, userId?: string) {
  return prisma.ledgerAccount.create({ data: { type, asset, ...(userId === undefined ? {} : { userId }) } });
}

async function addSystemAccounts() {
  const getOrCreate = async (type: AccountType, asset: Asset) => {
    const existing = await prisma.ledgerAccount.findFirst({ where: { type, asset, userId: null } });
    return existing ?? account(type, asset);
  };
  return {
    external: await getOrCreate(AccountType.EXTERNAL_ONCHAIN, Asset.USDT),
    vault: await getOrCreate(AccountType.SYSTEM_VAULT_USDT, Asset.USDT),
    pending: await getOrCreate(AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT),
    fees: await getOrCreate(AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT),
    issuance: await getOrCreate(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON),
  };
}

function appFixture(chainProvider?: AdminChainProvider, queueOverride?: ApiDependencies['queue'], configOverride: Partial<typeof config> = {}, captureEmailCode = true) {
  const calls: unknown[][] = [];
  const emailCodes = new Map<string, string>();
  const queue = { add: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as ApiDependencies['queue'];
  const redis = { ping: async () => 'PONG' };
  const app = createApp({
    config: { ...config, ...configOverride },
    prisma,
    queue: queueOverride ?? queue,
    redis,
    chainProvider,
    ...(captureEmailCode ? { logEmailCode: (email: string, code: string) => emailCodes.set(email, code) } : {}),
  });
  return { app, calls, emailCodes };
}

async function createAdmin(role: AdminRole, password = 'correct-password', username = `${role.toLowerCase()}@example.com`) {
  return prisma.adminUser.create({
    data: { username, passwordHash: await bcrypt.hash(password, 10), role },
  });
}

async function adminToken(app: ReturnType<typeof appFixture>['app'], username: string, password = 'correct-password') {
  const result = await request(app).post('/admin/login').send({ username, password });
  expect(result.status).toBe(200);
  return result.body.token as string;
}

async function memberToken(app: ReturnType<typeof appFixture>['app'], phone: string, displayName?: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12), biometricEnrolledAt: new Date(), securitySetupCompletedAt: new Date(), ...(displayName === undefined ? {} : { displayName }) } });
  const login = await request(app).post('/v1/auth/login').send({ phone, pin: '2468' });
  expect(login.status).toBe(200);
  return login.body.tokens.accessToken as string;
}

async function completeMemberSetup(phone: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });
  await prisma.user.update({ where: { id: user.id }, data: { biometricEnrolledAt: new Date(), securitySetupCompletedAt: new Date() } });
}

async function createPendingWithdrawal(app: ReturnType<typeof appFixture>['app'], barcodeId: string, phone: string, couponsGross = '150000') {
  await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone, barcodeId });
  const systems = await addSystemAccounts();
  const user = await prisma.user.findUniqueOrThrow({ where: { barcodeId } });
  const userAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
  await postDeposit(prisma, {
    externalRef: `admin-deposit:${barcodeId}`,
    userId: user.id,
    userCouponAccountId: userAccount.id,
    externalOnchainAccountId: systems.external.id,
    vaultAccountId: systems.vault.id,
    issuanceAccountId: systems.issuance.id,
    amountMicroUsdt: 20_000_000_000n,
  });
  const balanceBeforeWithdrawal = (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: userAccount.id } })).balance;
  const result = await request(app).post('/v1/withdrawals').set('Authorization', `Bearer ${token}`).send({
    barcodeId,
    destinationAddress: getAddress(`0x${'33'.repeat(20)}`),
    couponsGross,
  });
  expect(result.status).toBe(201);
  return { id: result.body.id as string, userId: user.id, userAccountId: userAccount.id, balanceBeforeWithdrawal };
}

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "MediaAsset", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
  await prisma.systemSetting.createMany({ data: [
    { key: 'WITHDRAWAL_BASE_FEE_BPS', value: '100' },
    { key: 'WITHDRAWAL_MIN_FEE_USDT', value: '0.20' },
    { key: 'MIN_WITHDRAWAL_USDT', value: '1' },
    { key: 'AUTO_APPROVAL_LIMIT_USDT', value: '1000' },
  ] });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('member API', () => {
  it('returns the configured withdrawal fee quote and rejects invalid quotes', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000129', barcodeId: 'api-quote' });
    const accessToken = await memberToken(app, '+1555000129');
    const quote = await request(app).get('/v1/me/withdrawals/quote').query({ couponsGross: '200' }).set('Authorization', `Bearer ${accessToken}`);
    expect(quote.status).toBe(200);
    expect(quote.body).toEqual({
      grossMicroUsdt: '2000000',
      feeMicroUsdt: '200000',
      netMicroUsdt: '1800000',
      baseFeeBps: '100',
      minimumFeeMicroUsdt: '200000',
    });
    const belowMinimum = await request(app).get('/v1/me/withdrawals/quote').query({ couponsGross: '100' }).set('Authorization', `Bearer ${accessToken}`);
    expect(belowMinimum.status).toBe(400);
    expect(belowMinimum.body).toEqual({ error: 'withdrawal is below minimum' });
    await prisma.systemSetting.update({ where: { key: 'WITHDRAWAL_MIN_FEE_USDT' }, data: { value: '2.1' } });
    const excessiveFee = await request(app).get('/v1/me/withdrawals/quote').query({ couponsGross: '200' }).set('Authorization', `Bearer ${accessToken}`);
    expect(excessiveFee.status).toBe(400);
    expect(excessiveFee.body).toEqual({ error: 'withdrawal fee must be less than gross amount' });
  });

  it('supports PIN signup and token-scoped profile reads', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000120', pin: '2468', displayName: 'Coupon User' });
    expect(registered.status).toBe(201);
    expect(registered.body).not.toHaveProperty('pin');
    expect(registered.body.member).toMatchObject({ displayName: 'Coupon User', barcodeId: expect.stringMatching(/^TC[0-9ABCDEFGHJKMNPQRSTVWXYZ]{14}$/), phone: '*-*-0120', isRestricted: false });
    const profile = await request(app).get('/v1/me').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`);
    expect(profile.status).toBe(403);
    expect(profile.body).toEqual({ error: 'setup_incomplete', remaining: ['biometric_enrolment'] });
    expect((await request(app).get('/v1/me/security-setup').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`)).status).toBe(200);
    expect((await request(app).post('/v1/member/security/biometric').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`).send({ pin: '2468', biometricEnrolled: true })).status).toBe(200);
    expect((await request(app).get('/v1/me').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`)).status).toBe(200);
    expect(await prisma.ledgerAccount.count({ where: { user: { phoneNumber: '+1555000120' } } })).toBe(2);
    expect(await prisma.depositAddress.count({ where: { user: { phoneNumber: '+1555000120' } } })).toBe(1);
    expect((await request(app).post('/v1/auth/login').send({ phone: '+1555000120', pin: '2468' })).status).toBe(200);
    expect((await request(app).post('/v1/auth/register').send({ phone: '+1555000120', pin: '2468', email: 'duplicate@example.com' })).status).toBe(409);
  });

  it('allows registration without email by default and reports only biometric setup remaining', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000119', pin: '2468' });
    expect(registered.status).toBe(201);
    const setup = await request(app).get('/v1/me/security-setup').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`);
    expect(setup.status).toBe(200);
    expect(setup.body.remaining).toEqual(['biometric_enrolment']);
    expect(setup.body.requiresEmailVerification).toBe(false);
  });

  it('searches demo and real barcodes with the same identity-only shape', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000115', pin: '2468' });
    expect(registered.status).toBe(201);
    await request(app).post('/v1/member/security/biometric')
      .set('Authorization', `Bearer ${registered.body.tokens.accessToken}`)
      .send({ pin: '2468', biometricEnrolled: true });
    await provisionUser(prisma, { depositXpub: config.depositXpub }, { phoneNumber: '+9900000000001', displayName: 'Demo 000001', isDemo: true });
    const real = await provisionUser(prisma, { depositXpub: config.depositXpub }, { phoneNumber: '+1555000114', displayName: 'Real 000001' });
    const token = registered.body.tokens.accessToken as string;
    const search = await request(app).get('/v1/me/barcodes?query=demo&limit=25').set('Authorization', `Bearer ${token}`);
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([{ barcodeId: expect.any(String), displayName: 'Demo 000001', isDemo: true }]);
    const shortQuery = await request(app).get('/v1/me/barcodes?query=ab').set('Authorization', `Bearer ${token}`);
    expect(shortQuery.status).toBe(400);
    const caseInsensitive = await request(app).get(`/v1/me/barcodes?query=${real.barcodeId.toLowerCase()}`).set('Authorization', `Bearer ${token}`);
    expect(caseInsensitive.body.items).toEqual([{ barcodeId: real.barcodeId, displayName: 'Real 000001', isDemo: false }]);
    const detail = await request(app).get(`/v1/me/barcodes/${real.barcodeId}`).set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ barcodeId: real.barcodeId, displayName: 'Real 000001', isDemo: false, kycStatus: 'UNVERIFIED' });
    expect(detail.body).not.toHaveProperty('balance');
  });

  it('rejects biometric setup with the wrong PIN without changing enrollment state', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000117', pin: '2468' });
    const response = await request(app)
      .post('/v1/member/security/biometric')
      .set('Authorization', `Bearer ${registered.body.tokens.accessToken}`)
      .send({ pin: '1357', biometricEnrolled: true });
    expect(response.status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000117' } })).biometricEnrolledAt).toBeNull();
  });

  it('requires email only when mandatory verification is enabled', async () => {
    const { app } = appFixture(undefined, undefined, { requireEmailVerification: true });
    const response = await request(app).post('/v1/auth/register').send({ phone: '+1555000118', pin: '2468' });
    expect(response.status).toBe(201);
    const setup = await request(app).get('/v1/me/security-setup').set('Authorization', `Bearer ${response.body.tokens.accessToken}`);
    expect(setup.body.remaining).toEqual(['email_verification', 'biometric_enrolment']);
  });

  it('acknowledges setup without claiming biometric enrollment', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000116', pin: '2468' });
    const response = await request(app)
      .post('/v1/member/security/biometric')
      .set('Authorization', `Bearer ${registered.body.tokens.accessToken}`)
      .send({ pin: '2468', biometricEnrolled: false });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      biometricEnrolled: false,
      biometricPending: true,
      remaining: [],
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000116' } });
    expect(user.biometricEnrolledAt).toBeNull();
    expect(user.setupAcknowledgedAt).not.toBeNull();
    expect(user.securitySetupCompletedAt).not.toBeNull();
    expect((await request(app).get('/v1/me').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`)).status).toBe(200);
  });

  it('rejects weak PINs and keeps unknown login indistinguishable', async () => {
    const { app } = appFixture();
    for (const pin of ['0000', '1111', '1234', '4321']) {
      expect((await request(app).post('/v1/auth/register').send({ phone: `+15550001${pin}`, pin })).status).toBe(400);
    }
    const unknown = await request(app).post('/v1/auth/login').send({ phone: '+1555000121', pin: '2468' });
    const wrong = await request(app).post('/v1/auth/login').send({ phone: '+1555000121', pin: '1357' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('locks PIN attempts and rejects the locked account before bcrypt', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/auth/register').send({ phone: '+1555000122', pin: '2468' });
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await request(app).post('/v1/auth/login').send({ phone: '+1555000122', pin: '1357' })).status).toBe(401);
    const locked = await request(app).post('/v1/auth/login').send({ phone: '+1555000122', pin: '1357' });
    expect(locked.status).toBe(423);
    expect(locked.body.retryAfter).toEqual(expect.any(Number));
    expect((await request(app).post('/v1/auth/login').send({ phone: '+1555000122', pin: '2468' })).status).toBe(423);
  });

  it('registers with an unverified email when delivery is unavailable', async () => {
    const { app } = appFixture(undefined, undefined, { emailDelivery: 'none' });
    const response = await request(app).post('/v1/auth/register').send({ phone: '+1555000125', pin: '2468', email: 'member@example.com' });
    expect(response.status).toBe(201);
    expect(response.body.member.emailVerified).toBe(false);
    expect(response.body).not.toHaveProperty('code');
  });

  it('logs email codes in log mode without returning them', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write);
    try {
      const { app } = appFixture(undefined, undefined, { emailDelivery: 'log' }, false);
      const response = await request(app).post('/v1/auth/register').send({ phone: '+1555000125', pin: '2468', email: 'logged@example.com' });
      expect(response.status).toBe(201);
      const code = writes.join('').match(/member email code (\d{6})/)?.[1];
      expect(code).toMatch(/^\d{6}$/);
      expect(response.text).not.toContain(code);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a verified email until a replacement code is confirmed and rejects a taken address', async () => {
    const { app, emailCodes } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000133', pin: '2468', email: 'old@example.com' });
    const accessToken = registered.body.tokens.accessToken as string;
    expect((await request(app).post('/v1/me/email/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: emailCodes.get('old@example.com') })).status).toBe(200);
    const replacement = await request(app).post('/v1/me/email').set('Authorization', `Bearer ${accessToken}`).send({ email: 'typo@example.com' });
    expect(replacement.status).toBe(202);
    expect(await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000133' } })).toMatchObject({ email: 'old@example.com', emailVerifiedAt: expect.any(Date) });
    const replacementVerified = await request(app).post('/v1/me/email/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: emailCodes.get('typo@example.com') });
    expect(replacementVerified.status).toBe(200);
    const taken = await request(app).post('/v1/auth/register').send({ phone: '+1555000134', pin: '2468', email: 'taken@example.com' });
    expect(taken.status).toBe(201);
    expect((await request(app).post('/v1/me/email').set('Authorization', `Bearer ${accessToken}`).send({ email: 'taken@example.com' })).status).toBe(409);
  });

  it('rotates refresh tokens and revokes every device on reuse', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000126', pin: '2468' });
    const firstRefresh = registered.body.tokens.refreshToken as string;
    const rotated = await request(app).post('/v1/auth/refresh').send({ refreshToken: firstRefresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.tokens.refreshToken).not.toBe(firstRefresh);
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: firstRefresh })).status).toBe(401);
    const devices = await prisma.memberDevice.findMany({ where: { user: { phoneNumber: '+1555000126' } } });
    expect(devices.every((device) => device.revokedAt !== null)).toBe(true);
  });

  it('verifies email and resets the PIN while revoking old devices', async () => {
    const { app, emailCodes } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000127', pin: '2468', email: 'reset@example.com' });
    expect(registered.status).toBe(201);
    expect(emailCodes.get('reset@example.com')).toMatch(/^\d{6}$/);
    const accessToken = registered.body.tokens.accessToken as string;
    await prisma.user.update({ where: { phoneNumber: '+1555000127' }, data: { biometricEnrolledAt: new Date(), securitySetupCompletedAt: new Date() } });
    const verified = await request(app).post('/v1/me/email/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: emailCodes.get('reset@example.com') });
    expect(verified.status).toBe(200);
    expect(verified.body.emailVerified).toBe(true);
    const requested = await request(app).post('/v1/auth/pin-reset/request').send({ email: 'reset@example.com' });
    expect(requested.status).toBe(202);
    const malformedCode = await request(app).post('/v1/auth/pin-reset/confirm').send({ email: 'reset@example.com', code: '1234', pin: '0000' });
    expect(malformedCode.status).toBe(400);
    expect(malformedCode.body.error).toBe('code must be exactly six digits');
    const reset = await request(app).post('/v1/auth/pin-reset/confirm').send({ email: 'reset@example.com', code: emailCodes.get('reset@example.com'), pin: '1357' });
    expect(reset.status).toBe(200);
    const resetUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000127' } });
    expect(resetUser).toMatchObject({
      biometricEnrolledAt: null,
      securitySetupCompletedAt: null,
      pinResetQuarantineUntil: expect.any(Date),
    });
    expect(resetUser.pinResetQuarantineUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await prisma.memberDevice.findMany({ where: { userId: resetUser.id } })).some((device) => device.revokedAt !== null)).toBe(true);
    expect((await request(app).get('/v1/me').set('Authorization', `Bearer ${accessToken}`)).status).toBe(401);
    expect((await request(app).post('/v1/auth/login').send({ phone: '+1555000127', pin: '1357' })).status).toBe(200);
  });

  it('requires PIN step-up for member transfers', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000128', barcodeId: 'step-up-a' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000129', barcodeId: 'step-up-b' });
    const actorToken = await memberToken(app, '+1555000128');
    const missing = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${actorToken}`).send({ toBarcodeId: 'step-up-b', amountCoupons: '1', idempotencyKey: 'missing-pin' });
    expect(missing.status).toBe(400);
    const wrong = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${actorToken}`).send({ toBarcodeId: 'step-up-b', amountCoupons: '1', idempotencyKey: 'wrong-pin', pin: '1357' });
    expect(wrong.status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000128' } })).pinAttempts).toBe(1);
  });

  it('keeps Restricted Mode active on /v1/me while allowing loan repayment', async () => {
    const { app } = appFixture();
    for (const [phone, barcode] of [['+1555000136', 'restricted-borrower'], ['+1555000137', 'restricted-guarantor'], ['+1555000138', 'restricted-lender']] as const) {
      expect((await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone, barcodeId: barcode })).status).toBe(201);
    }
    const borrower = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'restricted-borrower' } });
    const guarantor = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'restricted-guarantor' } });
    const lender = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'restricted-lender' } });
    const systems = await addSystemAccounts();
    await account(AccountType.GUARANTEE_LOCK, Asset.COUPON);
    for (const [user, amount, externalRef] of [[guarantor, 10_000_000n, 'restricted-guarantor-fund'], [lender, 10_000_000n, 'restricted-lender-fund']] as const) {
      const userAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
      await postDeposit(prisma, { externalRef, userId: user.id, userCouponAccountId: userAccount.id, externalOnchainAccountId: systems.external.id, vaultAccountId: systems.vault.id, issuanceAccountId: systems.issuance.id, amountMicroUsdt: amount });
    }
    const borrowerToken = await memberToken(app, borrower.phoneNumber);
    const guarantorToken = await memberToken(app, guarantor.phoneNumber);
    const loanResponse = await request(app).post('/v1/me/loans').set('Authorization', `Bearer ${borrowerToken}`).send({
      principalCoupons: '2',
      installments: [{ amountCoupons: '2', dueAt: new Date(Date.now() + 86_400_000).toISOString() }],
      guarantors: [{ barcodeId: guarantor.barcodeId, amountCoupons: '2' }],
    });
    expect(loanResponse.status).toBe(201);
    const loanId = loanResponse.body.id as string;
    const guaranteeId = loanResponse.body.guarantees[0].id as string;
    expect((await request(app).post(`/v1/me/guarantees/${guaranteeId}/approve`).set('Authorization', `Bearer ${guarantorToken}`).send({ code: '1234', pin: '2468' })).status).toBe(200);
    expect((await request(app).post(`/v1/me/guarantees/${guaranteeId}/activate`).set('Authorization', `Bearer ${borrowerToken}`).send({ code: '1234' })).status).toBe(200);
    expect((await request(app).post(`/v1/loans/${loanId}/disburse`).set('Authorization', `Bearer ${token}`).send({ barcodeId: lender.barcodeId })).status).toBe(200);
    const blockedTransfer = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${guarantorToken}`).send({ toBarcodeId: borrower.barcodeId, amountCoupons: '1', idempotencyKey: 'restricted-transfer', pin: '2468' });
    expect(blockedTransfer.status).toBe(400);
    expect(blockedTransfer.body.error).toContain('restricted');
    const repayment = await request(app).post(`/v1/me/loans/${loanId}/repay`).set('Authorization', `Bearer ${borrowerToken}`).send({ amountCoupons: '1', idempotencyKey: 'restricted-repayment' });
    expect(repayment.status).toBe(200);
    expect(repayment.body.outstandingCoupons).toBe('1');
  });

  it('rejects service, admin, malformed, and expired tokens on /v1/me', async () => {
    const { app } = appFixture();
    const admin = await createAdmin(AdminRole.ADMIN);
    const adminLogin = await request(app).post('/admin/login').send({ username: admin.username, password: 'correct-password' });
    const expired = `${adminLogin.body.token}.invalid`;
    for (const authorization of [undefined, `Bearer ${token}`, `Bearer ${adminLogin.body.token}`, 'Bearer garbage', `Bearer ${expired}`]) {
      const query = request(app).get('/v1/me');
      if (authorization !== undefined) query.set('Authorization', authorization);
      const response = await query;
      expect(response.status).toBe(401);
    }
    const sameSecretAdmin = createAdminJwt(admin.id, admin.username, admin.role, config.memberJwtSecret, config.adminJwtTtlSeconds);
    expect((await request(app).get('/v1/me').set('Authorization', `Bearer ${sameSecretAdmin}`)).status).toBe(401);
  });

  it('returns 404 for malformed member resource ids', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/auth/register').send({ phone: '+1555000135', pin: '2468' });
    await completeMemberSetup('+1555000135');
    const accessToken = (await request(app).post('/v1/auth/login').send({ phone: '+1555000135', pin: '2468' })).body.tokens.accessToken as string;
    const response = await request(app).delete('/v1/me/devices/not-a-uuid').set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(404);
  });

  it('rejects an expired member JWT', async () => {
    const { app } = appFixture();
    const user = await prisma.user.create({ data: { phoneNumber: '+1555000124', barcodeId: 'expired-member' } });
    const device = await prisma.memberDevice.create({ data: { userId: user.id, label: 'test', refreshTokenHash: 'expired', expiresAt: new Date(Date.now() + 60_000) } });
    const response = await request(app).get('/v1/me').set('Authorization', `Bearer ${createMemberJwt(user.id, device.id, config.memberJwtSecret, -1)}`);
    expect(response.status).toBe(401);
  });

  it('scopes transfers to the token actor and exposes stable transaction history', async () => {
    const { app } = appFixture();
    const createdA = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000126', barcodeId: 'member-a' });
    const createdB = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000127', barcodeId: 'member-b' });
    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    await prisma.user.update({ where: { barcodeId: 'member-b' }, data: { displayName: 'Bob' } });
    const systems = await addSystemAccounts();
    const userA = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'member-a' } });
    const accountA = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: userA.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, { externalRef: 'member-history-fund', userId: userA.id, userCouponAccountId: accountA.id, externalOnchainAccountId: systems.external.id, vaultAccountId: systems.vault.id, issuanceAccountId: systems.issuance.id, amountMicroUsdt: 100_000_000n });
    const tokenA = await memberToken(app, '+1555000126', 'Alice');
    const tokenB = await memberToken(app, '+1555000127', 'Bob');
    const malicious = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${tokenA}`).send({ fromBarcodeId: 'member-b', toBarcodeId: 'member-b', amountCoupons: '1', idempotencyKey: 'malicious', pin: '2468' });
    expect(malicious.status).toBe(201);
    const balanceA = await request(app).get('/v1/me/balance').set('Authorization', `Bearer ${tokenA}`);
    expect(balanceA.body.coupons).toBe('9999');
    const reverse = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${tokenB}`).send({ toBarcodeId: 'member-a', amountCoupons: '1', idempotencyKey: 'reverse', pin: '2468' });
    expect(reverse.status).toBe(201);
    const sharedKeyA = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${tokenA}`).send({ toBarcodeId: 'member-b', amountCoupons: '1', idempotencyKey: 'shared-key', pin: '2468' });
    const sharedKeyB = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${tokenB}`).send({ toBarcodeId: 'member-a', amountCoupons: '1', idempotencyKey: 'shared-key', pin: '2468' });
    expect(sharedKeyA.status).toBe(201);
    expect(sharedKeyB.status).toBe(201);
    expect(sharedKeyB.body.transactionId).not.toBe(sharedKeyA.body.transactionId);
    const history = await request(app).get('/v1/me/transactions?limit=1').set('Authorization', `Bearer ${tokenA}`);
    expect(history.status).toBe(200);
    expect(history.body.items[0]).toMatchObject({ direction: 'in', amountCoupons: '1', counterparty: { displayName: 'Bob', barcodeId: 'member-b' } });
    expect(history.body.nextCursor).toEqual(expect.any(String));
    const next = await request(app).get(`/v1/me/transactions?limit=10&cursor=${encodeURIComponent(history.body.nextCursor)}`).set('Authorization', `Bearer ${tokenA}`);
    expect(next.status).toBe(200);
    expect(next.body.items.some((item: { direction: string; amountCoupons: string }) => item.direction === 'out' && item.amountCoupons === '1')).toBe(true);
  });

  it('exposes escrow purchase refund metadata and resolved counterparties', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000140', barcodeId: 'escrow-buyer' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000141', barcodeId: 'escrow-merchant' });
    await prisma.user.update({ where: { barcodeId: 'escrow-merchant' }, data: { displayName: 'Merchant' } });
    const systems = await addSystemAccounts();
    const buyer = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'escrow-buyer' } });
    const buyerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: buyer.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, {
      externalRef: 'escrow-history-fund',
      userId: buyer.id,
      userCouponAccountId: buyerAccount.id,
      externalOnchainAccountId: systems.external.id,
      vaultAccountId: systems.vault.id,
      issuanceAccountId: systems.issuance.id,
      amountMicroUsdt: 100_000_000n,
    });
    const buyerToken = await memberToken(app, '+1555000140');
    const merchantToken = await memberToken(app, '+1555000141');
    const active = await request(app).post('/v1/me/escrows').set('Authorization', `Bearer ${buyerToken}`).send({
      recipientBarcodeId: 'escrow-merchant',
      amountCoupons: '2',
      code: '1234',
      pin: '2468',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(active.status).toBe(201);
    const releasedHold = await request(app).post('/v1/me/escrows').set('Authorization', `Bearer ${buyerToken}`).send({
      recipientBarcodeId: 'escrow-merchant',
      amountCoupons: '3',
      code: '1234',
      pin: '2468',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(releasedHold.status).toBe(201);
    expect((await request(app).post(`/v1/me/escrows/${releasedHold.body.id}/release`).set('Authorization', `Bearer ${merchantToken}`).send({ code: '1234' })).status).toBe(200);
    const releaseTransaction = await prisma.transaction.findUniqueOrThrow({ where: { externalRef: `escrow:${releasedHold.body.id}:release` } });
    const buyerHistory = await request(app).get('/v1/me/transactions?limit=100').set('Authorization', `Bearer ${buyerToken}`);
    expect(buyerHistory.status).toBe(200);
    const releasedItem = buyerHistory.body.items.find((item: { refundableTransactionId: string | null }) => item.refundableTransactionId === releaseTransaction.id);
    expect(releasedItem).toMatchObject({
      counterparty: { displayName: 'Merchant', barcodeId: 'escrow-merchant' },
      refundableTransactionId: releaseTransaction.id,
      transaction: { type: 'ESCROW_HOLD' },
      refund: null,
    });
    const activeItem = buyerHistory.body.items.find((item: { transactionId: string; amountCoupons: string }) => item.amountCoupons === '2' && item.transactionId !== releasedItem.transactionId);
    expect(activeItem).toMatchObject({ refundableTransactionId: null, counterparty: { displayName: 'Merchant', barcodeId: 'escrow-merchant' } });
    const merchantHistory = await request(app).get('/v1/me/transactions?limit=100').set('Authorization', `Bearer ${merchantToken}`);
    const releaseItem = merchantHistory.body.items.find((item: { transactionId: string }) => item.transactionId === releaseTransaction.id);
    expect(releaseItem).toMatchObject({ counterparty: { displayName: buyer.displayName, barcodeId: 'escrow-buyer' }, refundableTransactionId: null });
    const refund = await request(app).post('/v1/me/refunds').set('Authorization', `Bearer ${buyerToken}`).send({ transactionId: releaseTransaction.id, amountCoupons: '1', reason: 'کالا رسید' });
    expect(refund.status).toBe(201);
    const updatedHistory = await request(app).get('/v1/me/transactions?limit=100').set('Authorization', `Bearer ${buyerToken}`);
    const updatedItem = updatedHistory.body.items.find((item: { refundableTransactionId: string | null }) => item.refundableTransactionId === releaseTransaction.id);
    expect(updatedItem.refund).toMatchObject({ status: 'PENDING', amountCoupons: '1' });
  });

  it('supports private contact aliases, search, duplicate protection, and owner scoping', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000128', barcodeId: 'contact-owner' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000129', barcodeId: 'contact-target' });
    await prisma.user.update({ where: { barcodeId: 'contact-target' }, data: { displayName: 'Target Name' } });
    const ownerToken = await memberToken(app, '+1555000128');
    const otherToken = await memberToken(app, '+1555000129');
    const created = await request(app).post('/v1/me/contacts').set('Authorization', `Bearer ${ownerToken}`).send({ barcodeId: 'contact-target', alias: 'Work' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ alias: 'Work', barcodeId: 'contact-target', displayName: 'Target Name' });
    expect(created.body).not.toHaveProperty('phone');
    expect((await request(app).post('/v1/me/contacts').set('Authorization', `Bearer ${ownerToken}`).send({ barcodeId: 'contact-target', alias: 'Again' })).status).toBe(409);
    expect((await request(app).post('/v1/me/contacts').set('Authorization', `Bearer ${ownerToken}`).send({ barcodeId: 'contact-owner', alias: 'Self' })).status).toBe(400);
    expect((await request(app).patch(`/v1/me/contacts/${created.body.id}`).set('Authorization', `Bearer ${otherToken}`).send({ alias: 'Hacked' })).status).toBe(403);
    expect((await request(app).patch(`/v1/me/contacts/${created.body.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ alias: 'Personal' })).status).toBe(200);
    expect((await request(app).get('/v1/me/contacts?query=Personal&sort=alias').set('Authorization', `Bearer ${ownerToken}`)).body.items[0].alias).toBe('Personal');
    expect((await request(app).delete(`/v1/me/contacts/${created.body.id}`).set('Authorization', `Bearer ${otherToken}`)).status).toBe(403);
    expect((await request(app).delete(`/v1/me/contacts/${created.body.id}`).set('Authorization', `Bearer ${ownerToken}`)).status).toBe(204);
  });

  it('returns 403 for every member operation attempted by the wrong actor', async () => {
    const { app } = appFixture();
    for (const [phone, barcode] of [['+1555000130', 'actor-a'], ['+1555000131', 'actor-b'], ['+1555000132', 'actor-c']]) {
      await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone, barcodeId: barcode });
    }
    const actorA = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'actor-a' } });
    const actorB = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'actor-b' } });
    const actorC = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'actor-c' } });
    const tokenA = await memberToken(app, actorA.phoneNumber);
    const tokenB = await memberToken(app, actorB.phoneNumber);
    const tokenC = await memberToken(app, actorC.phoneNumber);
    const systems = await addSystemAccounts();
    const accountA = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: actorA.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, { externalRef: 'wrong-actor-fund', userId: actorA.id, userCouponAccountId: accountA.id, externalOnchainAccountId: systems.external.id, vaultAccountId: systems.vault.id, issuanceAccountId: systems.issuance.id, amountMicroUsdt: 100_000_000n });
    const escrow = await request(app).post('/v1/me/escrows').set('Authorization', `Bearer ${tokenA}`).send({ recipientBarcodeId: actorB.barcodeId, amountCoupons: '1', code: '1234', pin: '2468', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(escrow.status).toBe(201);
    expect((await request(app).post(`/v1/me/escrows/${escrow.body.id}/release`).set('Authorization', `Bearer ${tokenC}`).send({ code: '1234' })).status).toBe(403);
    expect((await request(app).post(`/v1/me/escrows/${escrow.body.id}/cancel`).set('Authorization', `Bearer ${tokenB}`)).status).toBe(403);
    const loan = await createLoanRequest(prisma, {
      borrowerId: actorA.id,
      principalCoupons: 10n,
      installments: [{ amountCoupons: 10n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: actorB.id, amountCoupons: 10n }],
    });
    await prisma.loan.update({ where: { id: loan.id }, data: { lenderId: actorC.id, status: 'ACTIVE' } });
    const guarantee = await prisma.guarantee.findUniqueOrThrow({ where: { loanId_guarantorId: { loanId: loan.id, guarantorId: actorB.id } } });
    expect((await request(app).post(`/v1/me/guarantees/${guarantee.id}/approve`).set('Authorization', `Bearer ${tokenA}`).send({ code: '1234', pin: '2468' })).status).toBe(403);
    expect((await request(app).post(`/v1/me/guarantees/${guarantee.id}/decline`).set('Authorization', `Bearer ${tokenA}`)).status).toBe(403);
    expect((await request(app).post(`/v1/me/guarantees/${guarantee.id}/activate`).set('Authorization', `Bearer ${tokenB}`).send({ code: '1234' })).status).toBe(403);
    expect((await request(app).post(`/v1/me/loans/${loan.id}/repay`).set('Authorization', `Bearer ${tokenC}`).send({ amountCoupons: '1', idempotencyKey: 'wrong-repay' })).status).toBe(403);
  });

  it('generates a barcode when omitted while preserving caller-supplied values', async () => {
    const { app } = appFixture();
    const generated = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000109' });
    expect(generated.status).toBe(201);
    expect(generated.body.barcodeId).toMatch(/^TC[0-9ABCDEFGHJKMNPQRSTVWXYZ]{14}$/);
    const supplied = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000110', barcodeId: 'back-office-free-form' });
    expect(supplied.status).toBe(201);
    expect(supplied.body.barcodeId).toBe('back-office-free-form');
  });

  it('retries a generated barcode after a barcode unique collision', async () => {
    await prisma.user.create({ data: { phoneNumber: '+1555000111', barcodeId: 'TC00000000000000' } });
    const generated = await provisionUser(prisma, config, { phoneNumber: '+1555000112' }, (() => {
      const values = ['TC00000000000000', 'TC00000000000001'];
      return () => values.shift()!;
    })());
    expect(generated.barcodeId).toBe('TC00000000000001');
  });

  it('requires the service token and creates an idempotent member', async () => {
    const { app } = appFixture();
    await expect(request(app).post('/v1/users').send({ phone: '+1555000100', barcodeId: 'api-1' })).resolves.toHaveProperty('status', 401);
    const created = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000100', barcodeId: 'api-1', alias: 'Member' });
    expect(created.status).toBe(201);
    expect(created.body.depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const replay = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000100', barcodeId: 'api-1' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(created.body.id);
  });

  it('validates checksummed destinations and minimum withdrawals', async () => {
    const { app } = appFixture();
    const created = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000101', barcodeId: 'api-2' });
    const systems = await addSystemAccounts();
    const user = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'api-2' } });
    const userAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, {
      externalRef: 'api-deposit-1',
      userId: user.id,
      userCouponAccountId: userAccount.id,
      externalOnchainAccountId: systems.external.id,
      vaultAccountId: systems.vault.id,
      issuanceAccountId: systems.issuance.id,
      amountMicroUsdt: 2_000_000n,
    });
    const invalidAddress = await request(app).post('/v1/withdrawals').set('Authorization', `Bearer ${token}`).send({ barcodeId: 'api-2', destinationAddress: `0x${'11'.repeat(20)}`, couponsGross: '100' });
    expect(invalidAddress.status).toBe(400);
    const belowMinimum = await request(app).post('/v1/withdrawals').set('Authorization', `Bearer ${token}`).send({ barcodeId: 'api-2', destinationAddress: getAddress(`0x${'11'.repeat(20)}`), couponsGross: '100' });
    expect(belowMinimum.status).toBe(400);
    expect(created.body.id).toBeDefined();
  });

  it('leaves withdrawals above the auto-approval limit pending and unqueued', async () => {
    const { app, calls } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000102', barcodeId: 'api-3' });
    const systems = await addSystemAccounts();
    const user = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'api-3' } });
    const userAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, {
      externalRef: 'api-deposit-2',
      userId: user.id,
      userCouponAccountId: userAccount.id,
      externalOnchainAccountId: systems.external.id,
      vaultAccountId: systems.vault.id,
      issuanceAccountId: systems.issuance.id,
      amountMicroUsdt: 20_000_000_000n,
    });
    const result = await request(app).post('/v1/withdrawals').set('Authorization', `Bearer ${token}`).send({ barcodeId: 'api-3', destinationAddress: getAddress(`0x${'22'.repeat(20)}`), couponsGross: '150000' });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('PENDING_APPROVAL');
    expect(calls).toHaveLength(0);
  });

  it('reports readiness against the real isolated Redis service', async () => {
    const redis = new Redis(config.redisUrl);
    try {
      const app = createApp({ config, prisma, queue: { add: async () => ({}) } as unknown as ApiDependencies['queue'], redis });
      const result = await request(app).get('/readyz');
      expect(result.status).toBe(200);
      expect(result.body.status).toBe('ready');
    } finally {
      await redis.quit();
    }
  });

  it('runs a guarantee lifecycle over HTTP', async () => {
    const { app } = appFixture();
    for (const [phone, barcodeId] of [['+1555000110', 'loan-borrower'], ['+1555000111', 'loan-guarantor'], ['+1555000112', 'loan-lender']] as const) {
      const created = await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone, barcodeId });
      expect(created.status).toBe(201);
    }
    const systems = await addSystemAccounts();
    const lock = await account(AccountType.GUARANTEE_LOCK, Asset.COUPON);
    const members = await Promise.all(['loan-borrower', 'loan-guarantor', 'loan-lender'].map((barcodeId) => prisma.user.findUniqueOrThrow({ where: { barcodeId } })));
    const accounts = await Promise.all(members.map((member) => prisma.ledgerAccount.findFirstOrThrow({ where: { userId: member.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } })));
    for (let index = 1; index < accounts.length; index += 1) {
      await postDeposit(prisma, {
        externalRef: `loan-http-fund:${index}`,
        userId: members[index]!.id,
        userCouponAccountId: accounts[index]!.id,
        externalOnchainAccountId: systems.external.id,
        vaultAccountId: systems.vault.id,
        issuanceAccountId: systems.issuance.id,
        amountMicroUsdt: 10_000_000n,
      });
    }
    const loanResponse = await request(app).post('/v1/loans').set('Authorization', `Bearer ${token}`).send({
      barcodeId: 'loan-borrower',
      principalCoupons: '100',
      installments: [{ amountCoupons: '100', dueAt: new Date(Date.now() + 86_400_000).toISOString() }],
      guarantors: [{ barcodeId: 'loan-guarantor', amountCoupons: '100' }],
    });
    expect(loanResponse.status).toBe(201);
    const loanId = loanResponse.body.id as string;
    const guaranteeId = loanResponse.body.guarantees[0].id as string;
    const approved = await request(app).post(`/v1/guarantees/${guaranteeId}/approve`).set('Authorization', `Bearer ${token}`).send({ code: '1234' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const activated = await request(app).post(`/v1/guarantees/${guaranteeId}/activate`).set('Authorization', `Bearer ${token}`).send({ code: '1234' });
    expect(activated.status).toBe(200);
    const disbursed = await request(app).post(`/v1/loans/${loanId}/disburse`).set('Authorization', `Bearer ${token}`).send({ barcodeId: 'loan-lender' });
    expect(disbursed.status).toBe(200);
    const repaid = await request(app).post(`/v1/loans/${loanId}/repay`).set('Authorization', `Bearer ${token}`).send({ amountCoupons: '100', idempotencyKey: 'full' });
    expect(repaid.status).toBe(200);
    expect(repaid.body.status).toBe('SETTLED');
    expect(lock.id).toBeDefined();
  });

  it('uploads evidence, creates a refund, and lets the counterparty approve it', async () => {
    const { app } = appFixture();
    const seller = await request(app).post('/v1/auth/register').send({ phone: '+1555000301', pin: '2468' });
    const buyer = await request(app).post('/v1/auth/register').send({ phone: '+1555000302', pin: '2468' });
    await completeMemberSetup('+1555000301');
    await completeMemberSetup('+1555000302');
    const systems = await addSystemAccounts();
    const sellerUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000301' } });
    const sellerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: sellerUser.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, { externalRef: 'refund-http-deposit', userId: sellerUser.id, userCouponAccountId: sellerAccount.id, externalOnchainAccountId: systems.external.id, vaultAccountId: systems.vault.id, issuanceAccountId: systems.issuance.id, amountMicroUsdt: 1_000_000n });
    const evidence = await request(app).post('/v1/me/media').set('Authorization', `Bearer ${seller.body.tokens.accessToken}`).field('kind', 'image').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'proof.bin');
    expect(evidence.status).toBe(201);
    const transfer = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${seller.body.tokens.accessToken}`).send({ toBarcodeId: buyer.body.member.barcodeId, amountCoupons: '100', idempotencyKey: 'refund-transfer', pin: '2468' });
    expect(transfer.status).toBe(201);
    const created = await request(app).post('/v1/me/refunds').set('Authorization', `Bearer ${seller.body.tokens.accessToken}`).send({ transactionId: transfer.body.transactionId, amountCoupons: '100', reason: 'returned', mediaIds: [evidence.body.id] });
    expect(created.status).toBe(201);
    const approved = await request(app).post(`/v1/me/refunds/${created.body.id}/approve`).set('Authorization', `Bearer ${buyer.body.tokens.accessToken}`).send({ pin: '2468' });
    expect(approved.status).toBe(200);
    const downloaded = await request(app).get(`/v1/me/media/${evidence.body.id}`).set('Authorization', `Bearer ${buyer.body.tokens.accessToken}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
  });

  it('creates charity accounts, audits agent writes, and disburses donated coupons', async () => {
    const { app } = appFixture();
    const admin = await createAdmin(AdminRole.ADMIN);
    const adminJwt = await adminToken(app, admin.username);
    const donor = await request(app).post('/v1/auth/register').send({ phone: '+1555000303', pin: '2468' });
    const applicant = await request(app).post('/v1/auth/register').send({ phone: '+1555000304', pin: '2468' });
    const agent = await request(app).post('/v1/auth/register').send({ phone: '+1555000305', pin: '2468' });
    await completeMemberSetup('+1555000303');
    await completeMemberSetup('+1555000304');
    await completeMemberSetup('+1555000305');
    const systems = await addSystemAccounts();
    const donorUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000303' } });
    const donorAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: donorUser.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, { externalRef: 'charity-http-deposit', userId: donorUser.id, userCouponAccountId: donorAccount.id, externalOnchainAccountId: systems.external.id, vaultAccountId: systems.vault.id, issuanceAccountId: systems.issuance.id, amountMicroUsdt: 1_000_000n });
    const charity = await request(app).post('/admin/charities').set('Authorization', `Bearer ${adminJwt}`).send({ name: 'HTTP Help' });
    expect(charity.status).toBe(201);
    const added = await request(app).post(`/admin/charities/${charity.body.id}/agents`).set('Authorization', `Bearer ${adminJwt}`).send({ barcodeId: agent.body.member.barcodeId, role: 'AGENT' });
    expect(added.status).toBe(201);
    expect(await prisma.adminAuditLog.count({ where: { entityType: 'Charity' } })).toBe(1);
    const donation = await request(app).post(`/v1/me/charities/${charity.body.id}/donations`).set('Authorization', `Bearer ${donor.body.tokens.accessToken}`).send({ amountCoupons: '50', pin: '2468' });
    expect(donation.status).toBe(201);
    const donationRetry = await request(app).post(`/v1/me/charities/${charity.body.id}/donations`).set('Authorization', `Bearer ${donor.body.tokens.accessToken}`).send({ amountCoupons: '50', pin: '2468', idempotencyKey: 'donation-once' });
    const donationRetryAgain = await request(app).post(`/v1/me/charities/${charity.body.id}/donations`).set('Authorization', `Bearer ${donor.body.tokens.accessToken}`).send({ amountCoupons: '50', pin: '2468', idempotencyKey: 'donation-once' });
    expect(donationRetry.status).toBe(201);
    expect(donationRetryAgain.status).toBe(201);
    expect(donationRetryAgain.body.transactionId).toBe(donationRetry.body.transactionId);
    const aid = await request(app).post('/v1/me/aid-requests').set('Authorization', `Bearer ${applicant.body.tokens.accessToken}`).send({ charityId: charity.body.id, amountCoupons: '20', description: 'food' });
    expect(aid.status).toBe(201);
    await request(app).post('/v1/auth/register').send({ phone: '+1555000310', pin: '2468' });
    await request(app).post('/v1/auth/register').send({ phone: '+1555000311', pin: '2468' });
    await completeMemberSetup('+1555000310');
    await completeMemberSetup('+1555000311');
    const foreignUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000310' } });
    const foreignGuarantorUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000311' } });
    const foreignLoan = await createLoanRequest(prisma, {
      borrowerId: foreignUser.id,
      principalCoupons: 5n,
      installments: [{ amountCoupons: 5n, dueAt: new Date(Date.now() + 60_000) }],
      guarantors: [{ guarantorId: foreignGuarantorUser.id, amountCoupons: 5n }],
    });
    const foreignLoanAid = await request(app).post('/v1/me/aid-requests').set('Authorization', `Bearer ${applicant.body.tokens.accessToken}`).send({ charityId: charity.body.id, amountCoupons: '5', description: 'foreign loan', loanId: foreignLoan.id });
    expect(foreignLoanAid.status).toBe(404);
    const approval = await request(app).post(`/v1/me/charity-requests/${aid.body.id}/approve`).set('Authorization', `Bearer ${agent.body.tokens.accessToken}`).send({ approvedCoupons: '15', pin: '2468' });
    expect(approval.status).toBe(200);
    expect(approval.body.approvedCoupons).toBe('15');
    expect((await request(app).post(`/v1/me/charity-requests/${aid.body.id}/approve`).set('Authorization', `Bearer ${donor.body.tokens.accessToken}`).send({ pin: '2468' })).status).toBe(404);
    const updated = await request(app).patch(`/admin/charities/${charity.body.id}`).set('Authorization', `Bearer ${adminJwt}`).send({ description: 'Updated help' });
    expect(updated.status).toBe(200);
    const revoked = await request(app).delete(`/admin/charities/${charity.body.id}/agents/${agent.body.member.id}`).set('Authorization', `Bearer ${adminJwt}`);
    expect(revoked.status).toBe(200);
    expect((await request(app).get('/v1/me/charity-requests').set('Authorization', `Bearer ${agent.body.tokens.accessToken}`)).body.items).toHaveLength(0);
    expect((await request(app).post(`/v1/me/charity-requests/${aid.body.id}/approve`).set('Authorization', `Bearer ${agent.body.tokens.accessToken}`).send({ pin: '2468' })).status).toBe(404);
    expect(await prisma.adminAuditLog.count({ where: { entityType: 'Charity' } })).toBe(2);
    expect(await prisma.adminAuditLog.count({ where: { entityType: 'CharityAgent' } })).toBe(2);
  });

  it('enforces refund ownership and magic-byte media rules', async () => {
    const { app } = appFixture();
    const payer = await request(app).post('/v1/auth/register').send({ phone: '+1555000306', pin: '2468' });
    const payee = await request(app).post('/v1/auth/register').send({ phone: '+1555000307', pin: '2468' });
    const unrelated = await request(app).post('/v1/auth/register').send({ phone: '+1555000308', pin: '2468' });
    await completeMemberSetup('+1555000306');
    await completeMemberSetup('+1555000307');
    await completeMemberSetup('+1555000308');
    const systems = await addSystemAccounts();
    const payerUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000306' } });
    const payerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: payerUser.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    const deposit = await postDeposit(prisma, { externalRef: 'refund-rules-deposit', userId: payerUser.id, userCouponAccountId: payerAccount.id, externalOnchainAccountId: systems.external.id, vaultAccountId: systems.vault.id, issuanceAccountId: systems.issuance.id, amountMicroUsdt: 1_000_000n });
    const invalidTransaction = await request(app).post('/v1/me/refunds').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).send({ transactionId: deposit.id, amountCoupons: '10', reason: 'not a transfer' });
    expect(invalidTransaction.status).toBe(400);
    const disguised = await request(app).post('/v1/me/media').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).field('kind', 'image').attach('file', Buffer.from('not an image'), 'proof.jpg');
    expect(disguised.status).toBe(415);
    const oversized = await request(app).post('/v1/me/media').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).field('kind', 'image').attach('file', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10 * 1024 * 1024)]), 'large.jpg');
    expect(oversized.status).toBe(413);
    const evidence = await request(app).post('/v1/me/media').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).field('kind', 'image').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'proof.jpg');
    expect(evidence.status).toBe(201);
    const foreignEvidence = await request(app).post('/v1/me/media').set('Authorization', `Bearer ${unrelated.body.tokens.accessToken}`).field('kind', 'image').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'foreign.jpg');
    expect(foreignEvidence.status).toBe(201);
    const transfer = await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).send({ toBarcodeId: payee.body.member.barcodeId, amountCoupons: '10', idempotencyKey: 'refund-rules-transfer', pin: '2468' });
    expect(transfer.status).toBe(201);
    const nonPayer = await request(app).post('/v1/me/refunds').set('Authorization', `Bearer ${unrelated.body.tokens.accessToken}`).send({ transactionId: transfer.body.transactionId, amountCoupons: '10', reason: 'not mine' });
    expect(nonPayer.status).toBe(400);
    const foreignMedia = await request(app).post('/v1/me/refunds').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).send({ transactionId: transfer.body.transactionId, amountCoupons: '10', reason: 'foreign evidence', mediaIds: [foreignEvidence.body.id] });
    expect(foreignMedia.status).toBe(400);
    const created = await request(app).post('/v1/me/refunds').set('Authorization', `Bearer ${payer.body.tokens.accessToken}`).send({ transactionId: transfer.body.transactionId, amountCoupons: '10', reason: 'returned', mediaIds: [evidence.body.id] });
    expect(created.status).toBe(201);
    expect((await request(app).get(`/v1/me/media/${evidence.body.id}`).set('Authorization', `Bearer ${unrelated.body.tokens.accessToken}`)).status).toBe(404);
    expect((await request(app).post(`/v1/me/refunds/${created.body.id}/approve`).set('Authorization', `Bearer ${unrelated.body.tokens.accessToken}`).send({ pin: '2468' })).status).toBe(404);
    expect((await request(app).post(`/v1/me/refunds/${created.body.id}/approve`).set('Authorization', `Bearer ${payee.body.tokens.accessToken}`).send({})).status).toBe(400);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await request(app).post(`/v1/me/refunds/${created.body.id}/approve`).set('Authorization', `Bearer ${payee.body.tokens.accessToken}`).send({ pin: '1357' })).status).toBe(401);
    }
    expect((await request(app).post(`/v1/me/refunds/${created.body.id}/approve`).set('Authorization', `Bearer ${payee.body.tokens.accessToken}`).send({ pin: '1357' })).status).toBe(423);
    const paged = await request(app).get(`/v1/me/refunds?role=seller&status=PENDING&limit=1`).set('Authorization', `Bearer ${payee.body.tokens.accessToken}`);
    expect(paged.status).toBe(200);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.nextCursor).toBeNull();
    expect((await request(app).get('/v1/me/refunds?role=buyer').set('Authorization', `Bearer ${unrelated.body.tokens.accessToken}`)).body.items).toHaveLength(0);
  });
});

describe('admin API', () => {
  it('authenticates admins without distinguishing login failures and enforces roles', async () => {
    const { app } = appFixture();
    await createAdmin(AdminRole.VIEWER, 'correct-password', 'operator-1');
    const success = await request(app).post('/admin/login').send({ username: 'operator-1', password: 'correct-password' });
    expect(success.status).toBe(200);
    expect(success.body.token).toEqual(expect.any(String));
    const wrongPassword = await request(app).post('/admin/login').send({ username: 'operator-1', password: 'wrong-password' });
    const unknownUsername = await request(app).post('/admin/login').send({ username: 'unknown-operator', password: 'wrong-password' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUsername.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUsername.body);
    const tokenValue = success.body.token as string;
    const settings = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${tokenValue}`).send({ withdrawalBaseFeeBps: '200' });
    expect(settings.status).toBe(403);
  });

  it('returns precise status codes without leaking unexpected errors', async () => {
    const { app } = appFixture();
    const missingMember = await request(app)
      .get('/v1/users/does-not-exist/balance')
      .set('Authorization', `Bearer ${token}`);
    expect(missingMember.status).toBe(404);

    await createAdmin(AdminRole.APPROVER);
    const withdrawal = await createPendingWithdrawal(app, 'admin-conflict', '+1555000204');
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: WithdrawalStatus.APPROVED } });
    const jwt = await adminToken(app, 'approver@example.com');
    const conflict = await request(app)
      .post(`/admin/withdrawals/${withdrawal.id}/approve`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(conflict.status).toBe(409);

    const failingQueue = {
      add: async () => {
        throw new Error('internal queue details');
      },
    } as unknown as ApiDependencies['queue'];
    const failingApp = appFixture(undefined, failingQueue).app;
    const internalWithdrawal = await createPendingWithdrawal(app, 'admin-internal', '+1555000205');
    const internal = await request(failingApp)
      .post(`/admin/withdrawals/${internalWithdrawal.id}/approve`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(internal.status).toBe(500);
    expect(internal.body).toEqual({ error: 'internal server error' });
    expect(JSON.stringify(internal.body)).not.toContain('internal queue details');
  });

  it('rejects malformed admin pagination cursors', async () => {
    const { app } = appFixture();
    await createAdmin(AdminRole.VIEWER);
    const jwt = await adminToken(app, 'viewer@example.com');
    const result = await request(app)
      .get('/admin/withdrawals')
      .query({ cursor: 'not-a-valid-cursor' })
      .set('Authorization', `Bearer ${jwt}`);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid cursor');
  });

  it('approves a pending withdrawal once and audits the successful mutation', async () => {
    const { app, calls } = appFixture();
    await createAdmin(AdminRole.APPROVER);
    const withdrawal = await createPendingWithdrawal(app, 'admin-approve', '+1555000200');
    const jwt = await adminToken(app, 'approver@example.com');
    const results = await Promise.all([
      request(app).post(`/admin/withdrawals/${withdrawal.id}/approve`).set('Authorization', `Bearer ${jwt}`),
      request(app).post(`/admin/withdrawals/${withdrawal.id}/approve`).set('Authorization', `Bearer ${jwt}`),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['dispatch', { withdrawalId: withdrawal.id }, { jobId: withdrawal.id }]);
    expect(await prisma.adminAuditLog.count({ where: { entityId: withdrawal.id, action: 'withdrawal.approve' } })).toBe(1);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe(WithdrawalStatus.APPROVED);
  });

  it('rejects and refunds pending withdrawals, but refuses chain-hashed withdrawals', async () => {
    const { app } = appFixture();
    await createAdmin(AdminRole.APPROVER);
    const first = await createPendingWithdrawal(app, 'admin-reject', '+1555000201');
    const jwt = await adminToken(app, 'approver@example.com');
    const rejected = await request(app).post(`/admin/withdrawals/${first.id}/reject`).set('Authorization', `Bearer ${jwt}`);
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe(WithdrawalStatus.REJECTED);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: first.userAccountId } })).balance).toBe(first.balanceBeforeWithdrawal);
    expect(await prisma.adminAuditLog.count({ where: { entityId: first.id, action: 'withdrawal.reject' } })).toBe(1);

    const second = await createPendingWithdrawal(app, 'admin-hashed', '+1555000202');
    await prisma.withdrawal.update({ where: { id: second.id }, data: { status: WithdrawalStatus.PROCESSING, chainTxHash: `0x${'44'.repeat(32)}` } });
    const refused = await request(app).post(`/admin/withdrawals/${second.id}/reject`).set('Authorization', `Bearer ${jwt}`);
    expect(refused.status).toBe(400);
    expect(await prisma.adminAuditLog.count({ where: { entityId: second.id } })).toBe(0);
  });

  it('returns overview arithmetic and degrades chain sections independently', async () => {
    const chainProvider: AdminChainProvider = {
      getBlockNumber: async () => 250,
      getNativeBalance: async () => 2_000_000_000_000_000_000n,
      getTokenBalance: async () => 10_000_000n,
    };
    const { app } = appFixture(chainProvider);
    await createAdmin(AdminRole.VIEWER);
    await addSystemAccounts();
    await prisma.chainCursor.create({ data: { id: 1, nextBlock: 240n } });
    const result = await request(app).get('/admin/overview').set('Authorization', `Bearer ${await adminToken(app, 'viewer@example.com')}`);
    expect(result.status).toBe(200);
    expect(result.body.chain).toMatchObject({ available: true, headBlock: 250, nextBlock: '240', lag: '10' });
    expect(result.body.hotWallet).toMatchObject({ available: true, usdt: '10', nativeWei: '2000000000000000000' });
    expect(result.body.solvency.isSolvent).toBe(true);
    expect(result.body.solvency).toMatchObject({
      custodyUsdt: '0',
      obligationsUsdt: '0',
      surplusUsdt: '0',
      components: { vaultUsdt: '0', withdrawalPendingUsdt: '0', feesUsdt: '0', couponsUsdt: '0', dustUsdt: '0' },
    });

    const unavailable = appFixture({
      getBlockNumber: async () => { throw new Error('RPC unavailable'); },
      getNativeBalance: async () => { throw new Error('RPC unavailable'); },
      getTokenBalance: async () => { throw new Error('RPC unavailable'); },
    });
    const degraded = await request(unavailable.app).get('/admin/overview').set('Authorization', `Bearer ${await adminToken(unavailable.app, 'viewer@example.com')}`);
    expect(degraded.status).toBe(200);
    expect(degraded.body.chain).toEqual({ available: false });
    expect(degraded.body.hotWallet).toEqual({ available: false });
    expect(degraded.body.solvency).toBeDefined();
  });

  it('validates and audits settings changes and searches ledger entries', async () => {
    const { app } = appFixture();
    await createAdmin(AdminRole.ADMIN);
    const withdrawal = await createPendingWithdrawal(app, 'admin-ledger', '+1555000203');
    const jwt = await adminToken(app, 'admin@example.com');
    const settings = await request(app).get('/admin/settings').set('Authorization', `Bearer ${jwt}`);
    expect(settings.status).toBe(200);
    expect(settings.body.minimumWithdrawalMicroUsdt).toBe('1000000');
    expect(settings.body.minimumFeeMicroUsdt).toBe('200000');
    const updated = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({
      withdrawalBaseFeeBps: '250',
      minimumFeeMicroUsdt: '300000',
      minimumWithdrawalMicroUsdt: '2000000',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ withdrawalBaseFeeBps: '250', minimumFeeMicroUsdt: '300000', minimumWithdrawalMicroUsdt: '2000000' });
    expect(await prisma.adminAuditLog.count({ where: { action: 'settings.update' } })).toBe(1);
    const unknown = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ unexpected: '1' });
    expect(unknown.status).toBe(400);
    const invalidFee = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ withdrawalBaseFeeBps: '10001' });
    expect(invalidFee.status).toBe(400);
    expect(invalidFee.body).toEqual({
      error: 'validation failed',
      fields: [{ path: 'withdrawalBaseFeeBps', message: 'fee bps must be between 0 and 10000' }],
    });
    expect(await prisma.adminAuditLog.count({ where: { action: 'settings.update' } })).toBe(1);
    const invalidMinimumFee = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ minimumFeeMicroUsdt: '100000001' });
    expect(invalidMinimumFee.status).toBe(400);
    expect(invalidMinimumFee.body.fields[0]).toEqual({ path: 'minimumFeeMicroUsdt', message: 'minimum fee must be at most 100 USDT' });
    const ledger = await request(app).get('/admin/ledger').query({ search: `withdrawal:${withdrawal.id}:burn` }).set('Authorization', `Bearer ${jwt}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items[0].externalRef).toBe(`withdrawal:${withdrawal.id}:burn`);
    expect(ledger.body.items[0].entries[0].amount).toEqual(expect.any(String));
  });
});
