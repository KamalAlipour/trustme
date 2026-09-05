import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getAddress, HDNodeWallet } from 'ethers';
import { Redis } from 'ioredis';
import bcrypt from 'bcryptjs';
import { AccountType, AdminRole, Asset, BalanceDisclosureStatus, IdentityCaptureStep, PayCodeStatus, PrismaClient, TransactionType, WithdrawalStatus } from '@trustme/db';
import { createLoanRequest, postDeposit } from '@trustme/core';
import { createApp, type ApiDependencies } from '../src/app.js';
import { HttpError } from '../src/http-error.js';
import { provisionUser } from '../src/user-provisioning.js';
import { createMemberJwt, verifyMemberJwt } from '../src/member-auth.js';
import { createAdminJwt } from '../src/admin-auth.js';
import type { AdminChainProvider } from '../src/admin.js';
import { hashIdentityValue } from '../src/identity.js';

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
  smsDelivery: 'log' as const,
  smsRelayUrl: 'https://id.hktp.ir',
  smsRelayKey: undefined,
  smsRelayOtpPattern: '61qgtphdqgtixtg',
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
  escrowChainId: 137,
  escrowContractAddress: undefined,
  walletConnectProjectId: undefined,
  web3AuthClientId: undefined,
  transakApiKey: undefined,
  transakApiSecret: undefined,
  transakEnvironment: 'staging' as const,
  transakReferrerDomain: 'app-trustcoupon.komasi.as',
  hotWalletAddress: getAddress(`0x${'aa'.repeat(20)}`),
  port: 3100,
  bodyLimit: '32kb',
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100,
  bindHost: '127.0.0.1',
  failoverMarkerPath: '/tmp/trustme-marker',
  mediaStorageDir: '/tmp/trustme-media',
  allowedOrigins: [],
  googleOAuthClientIds: ['google-client'],
  appleOAuthAudiences: ['as.komasi.trustcoupon'],
  shahkarApiToken: undefined,
  shahkarBaseUrl: 'https://provider.test',
  ibanMatchBaseUrl: 'https://iban-provider.test',
  identityHashPepper: undefined,
  partnerSecretKey: 'test-partner-secret-key-that-is-at-least-32-characters',
  confirmations: 12,
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
    couponFees: await getOrCreate(AccountType.SYSTEM_FEE_COLLECTION, Asset.COUPON),
    issuance: await getOrCreate(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON),
  };
}

function appFixture(
  chainProvider?: AdminChainProvider,
  queueOverride?: ApiDependencies['queue'],
  configOverride: Partial<typeof config> = {},
  captureEmailCode = true,
  socialOverrides: Pick<ApiDependencies, 'verifyGoogleIdToken' | 'verifyAppleIdToken' | 'checkShahkarMatch' | 'checkIbanMatch'> = {},
  transakClient: ApiDependencies['transakClient'] = undefined,
) {
  const calls: unknown[][] = [];
  const emailCodes = new Map<string, string>();
  const smsCodes = new Map<string, string>();
  const queue = { add: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as ApiDependencies['queue'];
  const smsQueue = { add: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as ApiDependencies['smsQueue'];
  const redis = { ping: async () => 'PONG' };
  const app = createApp({
    config: { ...config, ...configOverride },
    prisma,
    queue: queueOverride ?? queue,
    smsQueue,
    redis,
    chainProvider,
    ...(captureEmailCode ? { logEmailCode: (email: string, code: string) => emailCodes.set(email, code) } : {}),
    logSmsCode: (phone: string, code: string) => smsCodes.set(phone, code),
    ...(transakClient === undefined ? {} : { transakClient }),
    ...socialOverrides,
  });
  return { app, calls, emailCodes, smsCodes };
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

async function memberToken(app: ReturnType<typeof appFixture>['app'], phone: string, displayName?: string, verifyPhone = false) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12), biometricEnrolledAt: new Date(), securitySetupCompletedAt: new Date(), ...(phone.startsWith('09') ? { country: 'IR' } : {}), ...(verifyPhone ? { phoneVerifiedAt: new Date() } : {}), ...(displayName === undefined ? {} : { displayName }) } });
  const login = await request(app).post('/v1/auth/login').send({ phone, pin: '2468' });
  expect(login.status).toBe(200);
  return login.body.tokens.accessToken as string;
}

async function memberTokenForUser(userId: string) {
  const device = await prisma.memberDevice.create({ data: { userId, label: 'test', refreshTokenHash: `${userId}-token`, expiresAt: new Date(Date.now() + 60_000) } });
  return createMemberJwt(userId, device.id, config.memberJwtSecret, 900);
}

async function completeMemberSetup(phone: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });
  await prisma.user.update({ where: { id: user.id }, data: { biometricEnrolledAt: new Date(), securitySetupCompletedAt: new Date() } });
}

async function createCaptureFixture(userId: string, name: string, expiresAt = new Date(Date.now() + 5 * 60_000)) {
  const session = await prisma.identityCaptureSession.create({
    data: {
      userId,
      challengeCode: '1234',
      steps: [IdentityCaptureStep.DOCUMENT_FRONT, IdentityCaptureStep.SELFIE_NEUTRAL, IdentityCaptureStep.SELFIE_TURNED, IdentityCaptureStep.SELFIE_WITH_DOCUMENT],
      expiresAt,
    },
  });
  const steps = [IdentityCaptureStep.DOCUMENT_FRONT, IdentityCaptureStep.SELFIE_NEUTRAL, IdentityCaptureStep.SELFIE_TURNED, IdentityCaptureStep.SELFIE_WITH_DOCUMENT];
  for (const [index, step] of steps.entries()) {
    await prisma.mediaAsset.create({
      data: {
        ownerId: userId,
        kind: 'IMAGE',
        mimeType: 'image/jpeg',
        byteSize: 10,
        sha256: `capture-${name}-${step}`,
        storageKey: `identity/${name}-${step}.jpg`,
        captureSessionId: session.id,
        captureStep: step,
        createdAt: new Date(Date.now() - (steps.length - index) * 1000),
      },
    });
  }
  return session;
}

async function uploadCaptureFrame(app: ReturnType<typeof appFixture>['app'], accessToken: string, sessionId: string, step: IdentityCaptureStep) {
  return request(app)
    .post('/v1/me/media')
    .set('Authorization', `Bearer ${accessToken}`)
    .field('kind', 'image')
    .field('captureSessionId', sessionId)
    .field('step', step)
    .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), `${step}.jpg`);
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
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ApiKey", "EscrowChainEvent", "EscrowUnload", "EscrowSettlement", "PayCode", "EscrowBalance", "MemberWallet", "BalanceDisclosureRequest", "MediaAsset", "IdentityReview", "IdentityCaptureSession", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
  await prisma.systemSetting.createMany({ data: [
    { key: 'WITHDRAWAL_BASE_FEE_BPS', value: '100' },
    { key: 'WITHDRAWAL_MIN_FEE_USDT', value: '0.20' },
    { key: 'MIN_WITHDRAWAL_USDT', value: '1' },
    { key: 'AUTO_APPROVAL_LIMIT_USDT', value: '1000' },
    { key: 'REQUIRE_IDENTITY_FOR_WITHDRAWAL', value: 'false' },
  ] });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('member API', () => {
  const nationalCode = '3141592659';
  const mismatchingNationalCode = '2718281820';
  const identityConfig = { shahkarApiToken: 'test-shahkar-token', identityHashPepper: 'identity-test-pepper-that-is-at-least-32-characters' };

  it('rejects a commission rate below the configured floor', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000091', barcodeId: 'commission-floor-member' });
    const accessToken = await memberToken(app, '+1555000091');
    const result = await request(app)
      .put('/v1/me/commission-rate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ratePercent: '2', pin: '2468' });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('commission rate is below the floor');
  });

  it('issues, rate-limits, and verifies an Iranian phone code', async () => {
    const { app, smsCodes } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000410', barcodeId: 'phone-verify-member' });
    const accessToken = await memberToken(app, '+1555000410');
    const saved = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '09000000410', pin: '2468' });
    expect(saved.status).toBe(202);
    expect(smsCodes.get('09000000410')).toMatch(/^\d{6}$/);
    expect((await prisma.phoneVerification.findFirstOrThrow({ where: { phone: '09000000410' } })).deliveryStatus).toBe('SENT');
    expect(saved.body.phoneVerified).toBe(false);
    const wrong = await request(app).post('/v1/me/phone/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: '000000' });
    expect(wrong.status).toBe(401);
    const limited = await request(app).post('/v1/me/phone/resend').set('Authorization', `Bearer ${accessToken}`).send();
    expect(limited.status).toBe(429);
    const verified = await request(app).post('/v1/me/phone/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: smsCodes.get('09000000410') });
    expect(verified.status).toBe(200);
    expect(verified.body.phoneVerified).toBe(true);
    expect((await request(app).get('/v1/me').set('Authorization', `Bearer ${accessToken}`)).body.phoneVerified).toBe(true);
  });

  it('keeps non-Iranian phone saves synchronous without issuing an SMS code', async () => {
    const { app, smsCodes } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000411', barcodeId: 'phone-non-iranian' });
    const accessToken = await memberToken(app, '+1555000411');
    const result = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '+1555000412', pin: '2468' });
    expect(result.status).toBe(200);
    expect(smsCodes.size).toBe(0);
    expect(await prisma.phoneVerification.count()).toBe(0);
  });

  it('enqueues relay delivery without storing the raw code in the database', async () => {
    const { app, calls } = appFixture(undefined, undefined, { smsDelivery: 'relay', smsRelayKey: 'test-relay-key' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000413', barcodeId: 'phone-relay-member' });
    const accessToken = await memberToken(app, '+1555000413');
    expect((await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '09000000413', pin: '2468' })).status).toBe(202);
    const row = await prisma.phoneVerification.findFirstOrThrow({ where: { phone: '09000000413' } });
    const job = calls.find((args) => args[0] === 'send-otp');
    expect(job?.[2]).toMatchObject({ jobId: row.id, attempts: 3, removeOnFail: true, removeOnComplete: true, backoff: { type: 'sms-relay' } });
    expect(job?.[1]).toMatchObject({ phoneVerificationId: row.id, phone: '09000000413' });
    expect(row.codeHash).not.toMatch(/^\d{6}$/);
  });

  it('consumes a phone verification after five wrong codes and rejects expired codes', async () => {
    const { app, smsCodes } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000414', barcodeId: 'phone-attempts-member' });
    const accessToken = await memberToken(app, '+1555000414');
    expect((await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '09000000414', pin: '2468' })).status).toBe(202);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request(app).post('/v1/me/phone/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: '000000' })).status).toBe(401);
    }
    const row = await prisma.phoneVerification.findFirstOrThrow({ where: { phone: '09000000414' } });
    expect(row.consumedAt).not.toBeNull();

    await prisma.phoneVerification.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 61 * 60_000) } });
    await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '09000000414', pin: '2468' });
    const expired = await prisma.phoneVerification.findFirstOrThrow({ where: { phone: '09000000414', consumedAt: null } });
    await prisma.phoneVerification.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect((await request(app).post('/v1/me/phone/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: smsCodes.get('09000000414') })).status).toBe(401);
  });

  it('does not expose the network commission average publicly', async () => {
    const { app } = appFixture();
    const result = await request(app).get('/v1/public/commission-average').set('Authorization', `Bearer ${token}`);
    expect(result.status).toBe(404);
  });

  it('sets a trainer and includes trainer and referral summaries in the member profile', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000094', barcodeId: 'trainer-member' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000095', barcodeId: 'trainer-coach' });
    const accessToken = await memberToken(app, '+1555000094');
    const result = await request(app)
      .put('/v1/me/trainer')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ trainerBarcodeId: 'trainer-coach', pin: '2468' });
    expect(result.status).toBe(200);
    expect(result.body.commission.trainer).toEqual({ barcodeId: 'trainer-coach', displayName: null });
    expect(result.body.referrals).toEqual({
      marketers: { count: 0, earnedCoupons: '0' },
      sellers: { count: 0, earnedCoupons: '0' },
      customers: { count: 0, earnedCoupons: '0' },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000096', barcodeId: 'trainer-self' });
    const selfToken = await memberToken(app, '+1555000096');
    const self = await request(app)
      .put('/v1/me/trainer')
      .set('Authorization', `Bearer ${selfToken}`)
      .send({ trainerBarcodeId: 'trainer-self', pin: '2468' });
    expect(self.status).toBe(400);
  });

  it('disables prepaid escrow operations when no contract is configured', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+15550000001', barcodeId: 'escrow-disabled' });
    const accessToken = await memberToken(app, '+15550000001');
    const configResult = await request(app).get('/v1/me/escrow/config').set('Authorization', `Bearer ${accessToken}`);
    expect(configResult.status).toBe(200);
    expect(configResult.body).toMatchObject({ enabled: false, contractAddress: null, chainId: 137, decimals: 6, rpcUrl: null, cardTopUpEnabled: false });
    expect(configResult.body).not.toHaveProperty('polygonRpcUrl');
    expect(JSON.stringify(configResult.body)).not.toContain(config.polygonRpcUrl);
    const configuredApp = appFixture(undefined, undefined, { transakApiKey: 'test-transak-key', transakApiSecret: 'test-transak-secret' }).app;
    const configuredResult = await request(configuredApp).get('/v1/me/escrow/config').set('Authorization', `Bearer ${accessToken}`);
    expect(configuredResult.status).toBe(200);
    expect(configuredResult.body.cardTopUpEnabled).toBe(true);
    const walletResult = await request(app).post('/v1/me/wallets').set('Authorization', `Bearer ${accessToken}`).send({
      address: `0x${'11'.repeat(20)}`,
      kind: 'EXTERNAL',
    });
    expect(walletResult.status).toBe(503);
    expect(walletResult.body).toEqual({ error: 'escrow_not_configured' });
  });

  it('creates Transak sessions only for verified members', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000092', barcodeId: 'transak-session-member' });
    const accessToken = await memberToken(app, '+1555000092');
    expect((await request(app).post('/v1/me/card-topup/session').set('Authorization', `Bearer ${accessToken}`).send({})).status).toBe(503);

    const createWidgetSession = vi.fn(async () => ({
      url: 'https://global-stg.transak.com/?sessionId=test-session',
      expiresAt: '2026-01-15T10:35:00.000Z',
    }));
    const configuredApp = appFixture(undefined, undefined, { transakApiKey: 'test-transak-key', transakApiSecret: 'test-transak-secret' }, true, {}, { createWidgetSession }).app;
    const unverified = await request(configuredApp).post('/v1/me/card-topup/session').set('Authorization', `Bearer ${accessToken}`).send({});
    expect(unverified.status).toBe(403);
    expect(unverified.body.error).toBe('identity_verification_required');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000092' } });
    await prisma.user.update({ where: { id: user.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } });

    const invalid = await request(configuredApp).post('/v1/me/card-topup/session').set('Authorization', `Bearer ${accessToken}`).send({ amountUsdt: '1.234' });
    expect(invalid.status).toBe(400);
    const session = await request(configuredApp).post('/v1/me/card-topup/session').set('Authorization', `Bearer ${accessToken}`).send({ amountUsdt: '12.50' });
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ url: 'https://global-stg.transak.com/?sessionId=test-session', expiresAt: '2026-01-15T10:35:00.000Z' });
    expect(createWidgetSession).toHaveBeenCalledWith({ walletAddress: expect.any(String), userId: user.id, amountUsdt: '12.50' });
  });

  it('requires verified identity for wallet registration and escrow unloads regardless of country', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'46'.repeat(20)}`) });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000320', barcodeId: 'unverified-escrow' });
    const user = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'unverified-escrow' } });
    const accessToken = await memberToken(app, '+1555000320');
    const walletBody = { address: getAddress(`0x${'46'.repeat(20)}`), kind: 'IN_APP' };
    const unverifiedWallet = await request(app).post('/v1/me/wallets').set('Authorization', `Bearer ${accessToken}`).send(walletBody);
    expect(unverifiedWallet.status).toBe(403);
    expect(unverifiedWallet.body).toEqual({ error: 'identity_verification_required' });
    await prisma.escrowBalance.create({ data: { userId: user.id, lockedMicroUsdt: 1_000_000n } });
    const unverifiedUnload = await request(app).post('/v1/me/escrow/unloads').set('Authorization', `Bearer ${accessToken}`).send({ amount: '1', pin: '2468' });
    expect(unverifiedUnload.status).toBe(403);
    expect(unverifiedUnload.body).toEqual({ error: 'identity_verification_required' });

    await prisma.user.update({ where: { id: user.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } });
    const verifiedToken = await memberTokenForUser(user.id);
    const verifiedWallet = await request(app).post('/v1/me/wallets').set('Authorization', `Bearer ${verifiedToken}`).send(walletBody);
    expect(verifiedWallet.status).toBe(201);
    const verifiedUnload = await request(app).post('/v1/me/escrow/unloads').set('Authorization', `Bearer ${verifiedToken}`).send({ amount: '1', pin: '2468' });
    expect(verifiedUnload.status).toBe(201);
  });

  it('returns 503 when identity verification is not configured', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000001', barcodeId: 'identity-unconfigured' });
    const accessToken = await memberToken(app, '09000000001');
    const result = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'identity verification is not configured' });
  });

  it('rejects identity checks for accounts without a phone number', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => ({ status: 'MATCH', providerCode: 0 }),
    });
    const user = await prisma.user.create({
      data: {
        phoneNumber: null,
        barcodeId: 'identity-no-phone',
        pinHash: await bcrypt.hash('2468', 12),
        biometricEnrolledAt: new Date(),
        securitySetupCompletedAt: new Date(),
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { country: 'IR' } });
    const device = await prisma.memberDevice.create({ data: { userId: user.id, label: 'test', refreshTokenHash: 'identity-no-phone-token', expiresAt: new Date(Date.now() + 60_000) } });
    const accessToken = createMemberJwt(user.id, device.id, config.memberJwtSecret, 900);
    const result = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'identity verification requires a phone number' });
  });

  it('records a match, upgrades only unverified KYC, and stores hashes in the audit row', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => ({ status: 'MATCH', providerCode: 0 }),
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000002', barcodeId: 'identity-match' });
    const accessToken = await memberToken(app, '09000000002', undefined, true);
    const result = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'VERIFIED', verifiedAt: expect.any(String) });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000002' } });
    expect(user.kycStatus).toBe('VERIFIED');
    expect(user.nationalIdHash).toBe(hashIdentityValue(nationalCode, identityConfig.identityHashPepper));
    expect(user.identityCheckCount).toBe(1);
    const audit = await prisma.identityCheck.findUniqueOrThrow({ where: { id: (await prisma.identityCheck.findFirstOrThrow()).id } });
    expect(audit.status).toBe('VERIFIED');
    expect(audit.nationalIdHash).toBe(hashIdentityValue(nationalCode, identityConfig.identityHashPepper));
    expect(audit.mobileHash).toBe(hashIdentityValue('09000000002', identityConfig.identityHashPepper));
    expect(audit.nationalIdHash).not.toContain(nationalCode);
    expect(audit.mobileHash).not.toContain('09000000002');
    expect(result.body).not.toHaveProperty('message');
  });

  it.each(['PENDING', 'VERIFIED', 'REJECTED'])('preserves admin KYC decision %s on a match', async (kycStatus) => {
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => ({ status: 'MATCH', providerCode: 0 }),
    });
    const phone = `0900000000${3 + ['PENDING', 'VERIFIED', 'REJECTED'].indexOf(kycStatus)}`;
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone, barcodeId: `identity-${kycStatus.toLowerCase()}` });
    await prisma.user.update({ where: { phoneNumber: phone }, data: { kycStatus: kycStatus as 'PENDING' | 'VERIFIED' | 'REJECTED' } });
    const accessToken = await memberToken(app, phone, undefined, true);
    expect((await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } })).kycStatus).toBe(kycStatus);
  });

  it('leaves KYC untouched on mismatch and short-circuits a repeated verified check', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => {
        calls += 1;
        return { status: 'MISMATCH', providerCode: 1 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000006', barcodeId: 'identity-mismatch' });
    const mismatchToken = await memberToken(app, '09000000006', undefined, true);
    expect((await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${mismatchToken}`).send({ nationalCode })).status).toBe(200);
    const mismatchUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000006' } });
    expect(mismatchUser.identityVerificationStatus).toBe('MISMATCH');
    expect(mismatchUser.kycStatus).toBe('UNVERIFIED');
    expect(mismatchUser.nationalIdHash).toBeNull();

    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000007', barcodeId: 'identity-short-circuit' });
    const verified = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000007' } });
    await prisma.user.update({ where: { id: verified.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date(), nationalIdHash: hashIdentityValue(nationalCode, identityConfig.identityHashPepper) } });
    const verifiedToken = await memberToken(app, '09000000007', undefined, true);
    const shortCircuit = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${verifiedToken}`).send({ nationalCode });
    expect(shortCircuit.status).toBe(200);
    expect(shortCircuit.body.status).toBe('VERIFIED');
    expect(calls).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: verified.id } })).identityCheckCount).toBe(0);
  });

  it('preserves a verified identity after a later mismatching check', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => {
        calls += 1;
        return calls === 1 ? { status: 'MATCH', providerCode: 0 } : { status: 'MISMATCH', providerCode: 1 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000011', barcodeId: 'identity-mismatch-verified' });
    const accessToken = await memberToken(app, '09000000011', undefined, true);
    const first = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(first.body.status).toBe('VERIFIED');
    const verified = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000011' } });
    const verifiedAt = verified.identityVerifiedAt;
    const nationalIdHash = verified.nationalIdHash;
    const second = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode: mismatchingNationalCode });
    expect(second.body.status).toBe('VERIFIED');
    const afterMismatch = await prisma.user.findUniqueOrThrow({ where: { id: verified.id } });
    expect(afterMismatch.identityVerificationStatus).toBe('VERIFIED');
    expect(afterMismatch.identityVerifiedAt).toEqual(verifiedAt);
    expect(afterMismatch.nationalIdHash).toBe(nationalIdHash);
    expect(await prisma.identityCheck.count({ where: { userId: verified.id, status: 'MISMATCH' } })).toBe(1);
  });

  it('verifies and stores a matching IBAN for a Shahkar-verified member', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, { ...identityConfig, ibanMatchBaseUrl: 'https://iban-provider.test' }, true, {
      checkIbanMatch: async () => {
        calls += 1;
        return { status: 'MATCH', providerCode: 0 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000012', barcodeId: 'iban-match' });
    const accessToken = await memberToken(app, '09000000012');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000012' } });
    await prisma.user.update({ where: { id: user.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date(), nationalIdHash: hashIdentityValue(nationalCode, identityConfig.identityHashPepper) } });
    const result = await request(app).post('/v1/me/identity/iban').set('Authorization', `Bearer ${accessToken}`).send({
      iban: 'IR123456789012345678901234',
      nationalCode,
      birthDate: '1378/1/12',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'VERIFIED', iban: 'IR123456789012345678901234', ibanVerifiedAt: expect.any(String) });
    expect(calls).toBe(1);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.ibanNumber).toBe('IR123456789012345678901234');
    expect(await prisma.bankAccountCheck.count({ where: { userId: user.id, status: 'VERIFIED' } })).toBe(1);
  });

  it('preserves an existing verified IBAN after a mismatch', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkIbanMatch: async () => ({ status: 'MISMATCH', providerCode: 12 }),
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000013', barcodeId: 'iban-mismatch' });
    const accessToken = await memberToken(app, '09000000013');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000013' } });
    const verifiedAt = new Date(Date.now() - 1_000);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        identityVerificationStatus: 'VERIFIED',
        identityVerifiedAt: new Date(),
        nationalIdHash: hashIdentityValue(nationalCode, identityConfig.identityHashPepper),
        ibanNumber: 'IR987654321098765432109876',
        ibanVerifiedAt: verifiedAt,
      },
    });
    const result = await request(app).post('/v1/me/identity/iban').set('Authorization', `Bearer ${accessToken}`).send({
      iban: 'IR123456789012345678901234',
      nationalCode,
      birthDate: '1378/1/12',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'MISMATCH', iban: 'IR987654321098765432109876', ibanVerifiedAt: verifiedAt.toISOString() });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.ibanNumber).toBe('IR987654321098765432109876');
    expect(stored.ibanVerifiedAt).toEqual(verifiedAt);
  });

  it('rejects an IBAN check when the national code differs from the verified identity', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkIbanMatch: async () => {
        calls += 1;
        return { status: 'MATCH', providerCode: 0 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000014', barcodeId: 'iban-national-mismatch' });
    const accessToken = await memberToken(app, '09000000014');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000014' } });
    await prisma.user.update({ where: { id: user.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date(), nationalIdHash: hashIdentityValue(nationalCode, identityConfig.identityHashPepper) } });
    const result = await request(app).post('/v1/me/identity/iban').set('Authorization', `Bearer ${accessToken}`).send({
      iban: 'IR123456789012345678901234',
      nationalCode: mismatchingNationalCode,
      birthDate: '1378/1/12',
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'national code does not match the verified identity' });
    expect(calls).toBe(0);
  });

  it('requires a verified Shahkar identity before adding a bank account', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkIbanMatch: async () => ({ status: 'MATCH', providerCode: 0 }),
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000015', barcodeId: 'iban-unverified' });
    const accessToken = await memberToken(app, '09000000015');
    const result = await request(app).post('/v1/me/identity/iban').set('Authorization', `Bearer ${accessToken}`).send({
      iban: 'IR123456789012345678901234',
      nationalCode,
      birthDate: '1378/1/12',
    });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'verify your identity with Shahkar before adding a bank account' });
  });

  it('exposes the verified IBAN in the identity response', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig);
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000016', barcodeId: 'iban-identity' });
    const accessToken = await memberToken(app, '09000000016');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000016' } });
    const verifiedAt = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        identityVerificationStatus: 'VERIFIED',
        identityVerifiedAt: verifiedAt,
        nationalIdHash: hashIdentityValue(nationalCode, identityConfig.identityHashPepper),
        ibanNumber: 'IR123456789012345678901234',
        ibanVerifiedAt: verifiedAt,
      },
    });
    const result = await request(app).get('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ iban: 'IR123456789012345678901234', ibanVerifiedAt: verifiedAt.toISOString() });
  });

  it('rejects non-Iranian stored phones and enforces the rolling 24-hour provider-call cap', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => {
        calls += 1;
        return { status: 'MATCH', providerCode: 0 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000008', barcodeId: 'identity-invalid-phone' });
    await prisma.user.update({ where: { phoneNumber: '+1555000008' }, data: { country: 'IR' } });
    const invalidToken = await memberToken(app, '+1555000008', undefined, true);
    const invalid = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${invalidToken}`).send({ nationalCode });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'phone number must be a valid Iranian mobile number' });

    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000009', barcodeId: 'identity-cap' });
    const capped = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000009' } });
    await prisma.identityCheck.createMany({
      data: Array.from({ length: 10 }, (_, index) => ({
        userId: capped.id,
        status: 'MISMATCH' as const,
        nationalIdHash: `cap-national-hash-${index}`,
        mobileHash: `cap-mobile-hash-${index}`,
        createdAt: new Date(),
      })),
    });
    const cappedToken = await memberToken(app, '09000000009', undefined, true);
    const cappedResult = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${cappedToken}`).send({ nationalCode });
    expect(cappedResult.status).toBe(429);
    expect(calls).toBe(0);
  });

  it('preserves a verified identity status after an inconclusive provider result', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => ({ status: 'INCONCLUSIVE', providerCode: 0 }),
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000010', barcodeId: 'identity-inconclusive' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000010' } });
    await prisma.user.update({ where: { id: user.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date(), nationalIdHash: 'different-hash' } });
    const accessToken = await memberToken(app, '09000000010', undefined, true);
    const result = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(result.body.status).toBe('VERIFIED');
    expect(await prisma.identityCheck.count({ where: { userId: user.id, status: 'INCONCLUSIVE' } })).toBe(1);
  });

  it('updates and normalizes the account country, but locks it after verification', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000020', barcodeId: 'country-update' });
    const accessToken = await memberToken(app, '+1555000020');
    const updated = await request(app).put('/v1/me/country').set('Authorization', `Bearer ${accessToken}`).send({ country: ' no ' });
    expect(updated.status).toBe(200);
    expect(updated.body.member?.country ?? updated.body.country).toBe('NO');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000020' } });
    expect(user.country).toBe('NO');
    await prisma.user.update({ where: { id: user.id }, data: { identityVerificationStatus: 'VERIFIED' } });
    const locked = await request(app).put('/v1/me/country').set('Authorization', `Bearer ${accessToken}`).send({ country: 'SE' });
    expect(locked.status).toBe(409);
    expect(locked.body).toEqual({ error: 'country cannot be changed after identity verification' });
  });

  it('rejects unknown account countries', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000021', barcodeId: 'country-invalid' });
    const accessToken = await memberToken(app, '+1555000021');
    const result = await request(app).put('/v1/me/country').set('Authorization', `Bearer ${accessToken}`).send({ country: 'ZZ' });
    expect(result.status).toBe(400);
  });

  it('requires a valid PIN to set an account phone number', async () => {
    const { app } = appFixture();
    const user = await prisma.user.create({
      data: {
        phoneNumber: null,
        barcodeId: 'phone-pin',
        pinHash: await bcrypt.hash('2468', 12),
        biometricEnrolledAt: new Date(),
        securitySetupCompletedAt: new Date(),
      },
    });
    const accessToken = await memberTokenForUser(user.id);
    const missingPin = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '+15550000901' });
    expect(missingPin.status).toBe(400);
    const wrongPin = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '+15550000901', pin: '1357' });
    expect(wrongPin.status).toBe(401);
  });

  it('rejects duplicate phone numbers and changing a verified identity phone', async () => {
    const { app } = appFixture();
    const target = await prisma.user.create({
      data: {
        phoneNumber: null,
        barcodeId: 'phone-duplicate-target',
        pinHash: await bcrypt.hash('2468', 12),
        biometricEnrolledAt: new Date(),
        securitySetupCompletedAt: new Date(),
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+15550000902', barcodeId: 'phone-duplicate-owner' });
    const accessToken = await memberTokenForUser(target.id);
    const duplicate = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '+15550000902', pin: '2468' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: 'phone already registered' });

    await prisma.user.update({ where: { id: target.id }, data: { identityVerificationStatus: 'VERIFIED' } });
    const locked = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send({ phone: '+15550000903', pin: '2468' });
    expect(locked.status).toBe(409);
    expect(locked.body).toEqual({ error: 'phone cannot be changed after identity verification' });
  });

  it('sets an account phone number idempotently and returns the member policy', async () => {
    const { app } = appFixture();
    const user = await prisma.user.create({
      data: {
        phoneNumber: null,
        barcodeId: 'phone-success',
        pinHash: await bcrypt.hash('2468', 12),
        biometricEnrolledAt: new Date(),
        securitySetupCompletedAt: new Date(),
      },
    });
    const accessToken = await memberTokenForUser(user.id);
    const body = { phone: '+15550000904', pin: '2468' };
    const updated = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send(body);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: user.id, phone: '*-*-0904', identityVerification: { status: 'UNVERIFIED' } });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ phoneNumber: body.phone });

    const repeated = await request(app).post('/v1/me/phone').set('Authorization', `Bearer ${accessToken}`).send(body);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ id: user.id, phone: '*-*-0904' });
  });

  it('does not call Shahkar for a country whose active path is not Shahkar', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => {
        calls += 1;
        return { status: 'MATCH', providerCode: 0 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000022', barcodeId: 'identity-non-shahkar' });
    const accessToken = await memberToken(app, '+1555000022');
    expect((await request(app).put('/v1/me/country').set('Authorization', `Bearer ${accessToken}`).send({ country: 'NO' })).status).toBe(200);
    const result = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'shahkar is not the active identity path for this account' });
    expect(calls).toBe(0);
  });

  it('requires an account country before attempting identity verification', async () => {
    let calls = 0;
    const { app } = appFixture(undefined, undefined, identityConfig, true, {
      checkShahkarMatch: async () => {
        calls += 1;
        return { status: 'MATCH', providerCode: 0 };
      },
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000023', barcodeId: 'identity-no-country' });
    const accessToken = await memberToken(app, '+1555000023');
    const result = await request(app).post('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`).send({ nationalCode });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'account country is required' });
    expect(calls).toBe(0);
  });

  it('reports the derived identity path and withdrawal requirement setting', async () => {
    const { app } = appFixture(undefined, undefined, identityConfig);
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000024', barcodeId: 'identity-info' });
    const accessToken = await memberToken(app, '09000000024');
    const manual = await request(app).get('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`);
    expect(manual.status).toBe(200);
    expect(manual.body).toMatchObject({ country: 'IR', mode: 'AUTOMATED', provider: 'SHAHKAR', requiredForWithdrawal: false });
    await prisma.systemSetting.update({ where: { key: 'REQUIRE_IDENTITY_FOR_WITHDRAWAL' }, data: { value: 'true' } });
    const enabled = await request(app).get('/v1/me/identity').set('Authorization', `Bearer ${accessToken}`);
    expect(enabled.body.requiredForWithdrawal).toBe(true);
  });

  it('guards live identity capture submission and keeps asset IDs out of identity responses', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000030', barcodeId: 'manual-no-country' });
    const noCountryToken = await memberToken(app, '+1555000030');
    const noCountry = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${noCountryToken}`).send({});
    expect(noCountry.status).toBe(400);

    const automatedApp = appFixture(undefined, undefined, identityConfig).app;
    await request(automatedApp).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000031', barcodeId: 'manual-automated' });
    const automatedToken = await memberToken(automatedApp, '09000000031');
    const automated = await request(automatedApp).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${automatedToken}`).send({});
    expect(automated.status).toBe(409);

    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000032', barcodeId: 'manual-submit' });
    const submitToken = await memberToken(app, '+1555000032');
    expect((await request(app).put('/v1/me/country').set('Authorization', `Bearer ${submitToken}`).send({ country: 'NO' })).status).toBe(200);
    const submitUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000032' } });
    const session = await createCaptureFixture(submitUser.id, 'capture-32');
    const submitted = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${submitToken}`).send({ captureSessionId: session.id });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ status: 'PENDING', submittedAt: expect.any(String) });
    expect(submitted.body).not.toHaveProperty('documentAssetId');
    const duplicate = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${submitToken}`).send({ captureSessionId: session.id });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: 'identity capture session is expired or already used' });
    const pendingSession = await createCaptureFixture(submitUser.id, 'pending-32');
    const pendingReview = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${submitToken}`).send({ captureSessionId: pendingSession.id });
    expect(pendingReview.status).toBe(409);
    expect(pendingReview.body).toEqual({ error: 'identity review already pending' });
    const identity = await request(app).get('/v1/me/identity').set('Authorization', `Bearer ${submitToken}`);
    expect(identity.body.review).toMatchObject({ status: 'PENDING', submittedAt: expect.any(String), decidedAt: null, decisionNote: null });
    expect(identity.body.review).not.toHaveProperty('documentAssetId');
    expect(identity.body.review).not.toHaveProperty('selfieAssetId');

    await prisma.user.update({ where: { id: submitUser.id }, data: { identityVerificationStatus: 'VERIFIED' } });
    const verified = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${submitToken}`).send({ captureSessionId: session.id });
    expect(verified.status).toBe(409);

    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000033', barcodeId: 'manual-foreign' });
    const foreignToken = await memberToken(app, '+1555000033');
    await request(app).put('/v1/me/country').set('Authorization', `Bearer ${foreignToken}`).send({ country: 'NO' });
    const foreignUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000033' } });
    await createCaptureFixture(foreignUser.id, 'foreign-33');
    const foreignResult = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${foreignToken}`).send({ captureSessionId: session.id });
    expect(foreignResult.status).toBe(403);
    const expired = await createCaptureFixture(submitUser.id, 'expired-32', new Date(Date.now() - 1000));
    const expiredResult = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${submitToken}`).send({ captureSessionId: expired.id });
    expect(expiredResult.status).toBe(409);
  });

  it('enforces live capture ownership, steps, expiry, and consumption', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000034', barcodeId: 'live-capture-one' });
    const accessToken = await memberToken(app, '+1555000034');
    await request(app).put('/v1/me/country').set('Authorization', `Bearer ${accessToken}`).send({ country: 'NO' });
    const created = await request(app).post('/v1/me/identity/live-capture-session').set('Authorization', `Bearer ${accessToken}`);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: expect.any(String), challengeCode: expect.stringMatching(/^\d{4}$/), expiresAt: expect.any(String), steps: expect.arrayContaining(Object.values(IdentityCaptureStep)) });
    const sessionId = created.body.id as string;
    const ordinary = await request(app).post('/v1/me/media').set('Authorization', `Bearer ${accessToken}`).field('kind', 'image').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'ordinary.jpg');
    expect(ordinary.status).toBe(201);
    expect((await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${accessToken}`).send({ captureSessionId: sessionId })).status).toBe(400);
    for (const step of Object.values(IdentityCaptureStep)) {
      expect((await uploadCaptureFrame(app, accessToken, sessionId, step)).status).toBe(201);
    }
    expect((await uploadCaptureFrame(app, accessToken, sessionId, IdentityCaptureStep.DOCUMENT_FRONT)).status).toBe(409);
    const submitted = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${accessToken}`).send({ captureSessionId: sessionId });
    expect(submitted.status).toBe(201);
    const persisted = await prisma.identityReview.findUniqueOrThrow({ where: { id: submitted.body.id }, include: { captureSession: true } });
    expect(persisted).toMatchObject({ challengeCode: created.body.challengeCode, captureSessionId: sessionId, documentFrontCapturedAt: expect.any(Date), selfieNeutralCapturedAt: expect.any(Date), selfieTurnedCapturedAt: expect.any(Date), selfieWithDocumentCapturedAt: expect.any(Date) });
    expect(persisted.captureSession?.consumedAt).toEqual(expect.any(Date));
    expect((await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${accessToken}`).send({ captureSessionId: sessionId })).status).toBe(409);

    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000035', barcodeId: 'live-capture-two' });
    const foreignToken = await memberToken(app, '+1555000035');
    await request(app).put('/v1/me/country').set('Authorization', `Bearer ${foreignToken}`).send({ country: 'NO' });
    const foreignAttempt = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${foreignToken}`).send({ captureSessionId: sessionId });
    expect(foreignAttempt.status).toBe(403);
  });

  it('creates and reuses Google identities and requires first-time PIN setup', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyGoogleIdToken: async () => ({ subject: 'google-subject', email: 'social@example.com', emailVerified: true }),
    });
    const first = await request(app).post('/v1/auth/google').set('x-device-label', 'Google device').send({ idToken: 'verified-token' });
    expect(first.status).toBe(200);
    expect(first.body.member).toMatchObject({ phone: null, email: 's****@example.com' });
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'social@example.com' } })).toMatchObject({ emailVerifiedAt: expect.any(Date) });
    expect(await prisma.userIdentity.count()).toBe(1);
    expect((await request(app).get('/v1/me/security-setup').set('Authorization', `Bearer ${first.body.tokens.accessToken}`)).body.remaining).toEqual(['pin', 'biometric_enrolment']);

    const second = await request(app).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(second.status).toBe(200);
    expect(second.body.member.id).toBe(first.body.member.id);
    expect(await prisma.user.count()).toBe(1);

    const pin = await request(app).post('/v1/member/security/pin')
      .set('Authorization', `Bearer ${first.body.tokens.accessToken}`)
      .send({ pin: '2468' });
    expect(pin.status).toBe(204);
    const duplicate = await request(app).post('/v1/member/security/pin')
      .set('Authorization', `Bearer ${first.body.tokens.accessToken}`)
      .send({ pin: '2468' });
    expect(duplicate.status).toBe(409);
  });

  it('reuses one active device row for repeated logins from one installation', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000130', barcodeId: 'installation-same' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000130' } });
    await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12) } });

    const first = await request(app).post('/v1/auth/login').set('x-installation-id', 'installation-one').send({ phone: '+1555000130', pin: '2468' });
    const firstDevice = await prisma.memberDevice.findFirstOrThrow({ where: { userId: user.id } });
    const firstHash = firstDevice.refreshTokenHash;
    const second = await request(app).post('/v1/auth/login').set('x-installation-id', 'installation-one').send({ phone: '+1555000130', pin: '2468' });
    const activeDevices = await prisma.memberDevice.findMany({ where: { userId: user.id, revokedAt: null } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(activeDevices).toHaveLength(1);
    expect(verifyMemberJwt(second.body.tokens.accessToken, config.memberJwtSecret)?.sid).toBe(firstDevice.id);
    expect(activeDevices[0]?.refreshTokenHash).not.toBe(firstHash);
  });

  it('creates separate device rows for different installations', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000131', barcodeId: 'installation-diff' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000131' } });
    await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12) } });

    const first = await request(app).post('/v1/auth/login').set('x-installation-id', 'installation-one').send({ phone: '+1555000131', pin: '2468' });
    const second = await request(app).post('/v1/auth/login').set('x-installation-id', 'installation-two').send({ phone: '+1555000131', pin: '2468' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.memberDevice.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
  });

  it('creates a new device row when logins omit an installation ID', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000132', barcodeId: 'installation-none' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000132' } });
    await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12) } });

    const first = await request(app).post('/v1/auth/login').send({ phone: '+1555000132', pin: '2468' });
    const second = await request(app).post('/v1/auth/login').send({ phone: '+1555000132', pin: '2468' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.memberDevice.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
  });

  it('preserves the installation ID while rotating a refresh session', async () => {
    const { app } = appFixture();
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000133', barcodeId: 'installation-refresh' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000133' } });
    await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12) } });

    const login = await request(app).post('/v1/auth/login').set('x-installation-id', 'installation-one').send({ phone: '+1555000133', pin: '2468' });
    const original = await prisma.memberDevice.findFirstOrThrow({ where: { userId: user.id, revokedAt: null } });
    const rotated = await request(app).post('/v1/auth/refresh').send({ refreshToken: login.body.tokens.refreshToken });
    const replacement = await prisma.memberDevice.findUniqueOrThrow({ where: { id: (await prisma.memberDevice.findUniqueOrThrow({ where: { id: original.id } })).replacedById as string } });

    expect(rotated.status).toBe(200);
    expect(replacement.installationId).toBe('installation-one');
  });

  it('does not auto-link a social identity by email', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyAppleIdToken: async () => ({ subject: 'apple-subject', email: 'taken@example.com', emailVerified: false }),
    });
    const existing = await request(app).post('/v1/auth/register').send({ phone: '+1555000990', pin: '2468', email: 'taken@example.com' });
    expect(existing.status).toBe(201);
    const social = await request(app).post('/v1/auth/apple').send({ idToken: 'verified-token', displayName: 'Apple Member' });
    expect(social.status).toBe(200);
    expect(social.body.member.id).not.toBe(existing.body.member.id);
    expect(social.body.member.email).toBeNull();
    const identity = await prisma.userIdentity.findUniqueOrThrow({ where: { provider_subject: { provider: 'APPLE', subject: 'apple-subject' } } });
    expect(identity.email).toBe('taken@example.com');
  });

  it('does not mark an unverified Apple email as verified', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyAppleIdToken: async () => ({ subject: 'apple-unverified', email: 'apple@example.com', emailVerified: false }),
    });
    const social = await request(app).post('/v1/auth/apple').send({ idToken: 'verified-token', displayName: 'Apple Member' });
    expect(social.status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'apple@example.com' } })).toMatchObject({ emailVerifiedAt: null });
  });

  it('does not mark an Apple account without an email as verified', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyAppleIdToken: async () => ({ subject: 'apple-no-email', email: null, emailVerified: false }),
    });
    const social = await request(app).post('/v1/auth/apple').send({ idToken: 'verified-token', displayName: 'Apple Member' });
    expect(social.status).toBe(200);
    const identity = await prisma.userIdentity.findFirstOrThrow({
      where: { provider: 'APPLE', subject: 'apple-no-email' },
    });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: identity.userId } })).toMatchObject({ email: null, emailVerifiedAt: null });
  });

  it('backfills verification for an existing matching social account', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyGoogleIdToken: async () => ({ subject: 'google-backfill', email: 'backfill@example.com', emailVerified: true }),
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000991', barcodeId: 'social-backfill' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000991' } });
    await prisma.user.update({ where: { id: user.id }, data: { email: 'backfill@example.com' } });
    await prisma.userIdentity.create({ data: { userId: user.id, provider: 'GOOGLE', subject: 'google-backfill', email: 'backfill@example.com' } });
    const social = await request(app).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(social.status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ email: 'backfill@example.com', emailVerifiedAt: expect.any(Date) });
  });

  it('does not backfill verification when an existing social account email differs', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyGoogleIdToken: async () => ({ subject: 'google-mismatch', email: 'claims@example.com', emailVerified: true }),
    });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000992', barcodeId: 'social-mismatch' });
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000992' } });
    await prisma.user.update({ where: { id: user.id }, data: { email: 'stored@example.com' } });
    await prisma.userIdentity.create({ data: { userId: user.id, provider: 'GOOGLE', subject: 'google-mismatch', email: 'claims@example.com' } });
    const social = await request(app).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(social.status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ email: 'stored@example.com', emailVerifiedAt: null });
  });

  it('returns provider_disabled when a provider has no configured audiences', async () => {
    const { app } = appFixture(undefined, undefined, { googleOAuthClientIds: [] });
    const response = await request(app).post('/v1/auth/google').send({ idToken: 'token' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'provider_disabled' });
  });

  it('rejects an invalid verified-provider audience', async () => {
    const { app } = appFixture(undefined, undefined, {}, true, {
      verifyGoogleIdToken: async () => { throw new HttpError(401, 'invalid Google identity token'); },
    });
    const response = await request(app).post('/v1/auth/google').send({ idToken: 'verified-token' });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'invalid Google identity token' });
  });

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

  it('keeps member spending permissive by default and gates only configured countries', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'44'.repeat(20)}`) });
    for (const [phone, barcode] of [
      ['09000000101', 'gate-ir'],
      ['+1555000102', 'gate-recipient'],
      ['+1555000103', 'gate-no'],
      ['+1555000104', 'gate-null'],
      ['+1555000105', 'gate-merchant'],
    ] as const) {
      expect((await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone, barcodeId: barcode })).status).toBe(201);
    }
    const buyer = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'gate-ir' } });
    const recipient = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'gate-recipient' } });
    const noUser = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'gate-no' } });
    const nullUser = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'gate-null' } });
    const merchant = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'gate-merchant' } });
    await prisma.user.update({ where: { id: noUser.id }, data: { country: 'NO' } });
    const systems = await addSystemAccounts();
    for (const user of [buyer, noUser, nullUser]) {
      const userAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
      await postDeposit(prisma, {
        externalRef: `gate-fund:${user.barcodeId}`,
        userId: user.id,
        userCouponAccountId: userAccount.id,
        externalOnchainAccountId: systems.external.id,
        vaultAccountId: systems.vault.id,
        issuanceAccountId: systems.issuance.id,
        amountMicroUsdt: 10_000_000n,
      });
      await prisma.escrowBalance.create({ data: { userId: user.id, lockedMicroUsdt: 10_000_000n } });
    }
    const buyerToken = await memberToken(app, buyer.phoneNumber);
    const noToken = await memberToken(app, noUser.phoneNumber);
    const nullToken = await memberToken(app, nullUser.phoneNumber);
    const merchantToken = await memberToken(app, merchant.phoneNumber);

    expect((await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${buyerToken}`).send({ toBarcodeId: recipient.barcodeId, amountCoupons: '1', idempotencyKey: 'gate-default-transfer', pin: '2468' })).status).toBe(201);
    expect((await request(app).post('/v1/me/escrow/pay-codes').set('Authorization', `Bearer ${buyerToken}`).send({ code: '1234', maxAmount: '1', pin: '2468' })).status).toBe(201);

    await prisma.systemSetting.upsert({ where: { key: 'IDENTITY_REQUIRED_COUNTRIES' }, update: { value: 'IR' }, create: { key: 'IDENTITY_REQUIRED_COUNTRIES', value: 'IR' } });
    for (const [path, body] of [
      ['/v1/me/transfers', { toBarcodeId: recipient.barcodeId, amountCoupons: '1', idempotencyKey: 'gate-transfer', pin: '2468' }],
      ['/v1/me/escrows', { recipientBarcodeId: recipient.barcodeId, amountCoupons: '1', code: '5678', expiresAt: new Date(Date.now() + 60_000).toISOString(), pin: '2468' }],
      ['/v1/me/escrow/pay-codes', { code: '2345', maxAmount: '1', pin: '2468' }],
      ['/v1/me/escrow/unloads', { amount: '1', pin: '2468' }],
    ] as const) {
      const result = await request(app).post(path).set('Authorization', `Bearer ${buyerToken}`).send(body);
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: 'identity_verification_required' });
    }

    await prisma.user.update({ where: { id: buyer.id }, data: { identityVerificationStatus: 'VERIFIED' } });
    await prisma.memberWallet.create({ data: { userId: buyer.id, address: getAddress(`0x${'55'.repeat(20)}`), kind: 'IN_APP', chainId: 137 } });
    const verifiedBuyerToken = await memberTokenForUser(buyer.id);
    expect((await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${verifiedBuyerToken}`).send({ toBarcodeId: recipient.barcodeId, amountCoupons: '1', idempotencyKey: 'gate-verified-transfer', pin: '2468' })).status).toBe(201);
    expect((await request(app).post('/v1/me/escrows').set('Authorization', `Bearer ${verifiedBuyerToken}`).send({ recipientBarcodeId: recipient.barcodeId, amountCoupons: '1', code: '6789', expiresAt: new Date(Date.now() + 60_000).toISOString(), pin: '2468' })).status).toBe(201);
    expect((await request(app).post('/v1/me/escrow/pay-codes').set('Authorization', `Bearer ${verifiedBuyerToken}`).send({ code: '3456', maxAmount: '1', pin: '2468' })).status).toBe(201);
    expect((await request(app).post('/v1/me/escrow/unloads').set('Authorization', `Bearer ${verifiedBuyerToken}`).send({ amount: '1', pin: '2468' })).status).toBe(201);

    expect((await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${noToken}`).send({ toBarcodeId: recipient.barcodeId, amountCoupons: '1', idempotencyKey: 'gate-no-transfer', pin: '2468' })).status).toBe(201);
    expect((await request(app).post('/v1/me/transfers').set('Authorization', `Bearer ${nullToken}`).send({ toBarcodeId: recipient.barcodeId, amountCoupons: '1', idempotencyKey: 'gate-null-transfer', pin: '2468' })).status).toBe(201);

    await prisma.user.update({ where: { id: buyer.id }, data: { identityVerificationStatus: 'UNVERIFIED' } });
    await prisma.payCode.create({ data: { buyerId: buyer.id, codeHash: await bcrypt.hash('7890', 10), maxAmountMicroUsdt: 1_000_000n, expiresAt: new Date(Date.now() + 60_000), status: PayCodeStatus.ACTIVE } });
    const settlement = await request(app).post('/v1/me/escrow/settlements').set('Authorization', `Bearer ${merchantToken}`).send({ buyerBarcodeId: buyer.barcodeId, code: '7890', amount: '1', idempotencyKey: 'gate-settlement', pin: '2468' });
    expect(settlement.status).toBe(201);
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
      sourceBarcodeId: lender.barcodeId,
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

  it('creates and disburses a source-directed member loan after guarantee activation', async () => {
    const { app } = appFixture();
    const borrower = await request(app).post('/v1/auth/register').send({ phone: '+1555000400', pin: '2468' });
    const source = await request(app).post('/v1/auth/register').send({ phone: '+1555000401', pin: '2468' });
    const guarantor = await request(app).post('/v1/auth/register').send({ phone: '+1555000402', pin: '2468' });
    expect(borrower.status).toBe(201);
    expect(source.status).toBe(201);
    expect(guarantor.status).toBe(201);
    await completeMemberSetup('+1555000400');
    await completeMemberSetup('+1555000401');
    await completeMemberSetup('+1555000402');
    const systems = await addSystemAccounts();
    await account(AccountType.GUARANTEE_LOCK, Asset.COUPON);
    const sourceUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000401' } });
    const sourceAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: sourceUser.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, {
      externalRef: 'source-directed-loan-fund',
      userId: sourceUser.id,
      userCouponAccountId: sourceAccount.id,
      externalOnchainAccountId: systems.external.id,
      vaultAccountId: systems.vault.id,
      issuanceAccountId: systems.issuance.id,
      amountMicroUsdt: 1_000_000n,
    });
    const guarantorUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000402' } });
    const guarantorAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: guarantorUser.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, {
      externalRef: 'source-directed-loan-guarantor-fund',
      userId: guarantorUser.id,
      userCouponAccountId: guarantorAccount.id,
      externalOnchainAccountId: systems.external.id,
      vaultAccountId: systems.vault.id,
      issuanceAccountId: systems.issuance.id,
      amountMicroUsdt: 1_000_000n,
    });
    const borrowerToken = await memberToken(app, '+1555000400');
    const sourceToken = await memberToken(app, '+1555000401');
    const guarantorToken = await memberToken(app, '+1555000402');
    const created = await request(app).post('/v1/me/loans').set('Authorization', `Bearer ${borrowerToken}`).send({
      principalCoupons: '50',
      sourceBarcodeId: source.body.member.barcodeId,
      description: 'Emergency household expenses',
      installments: [{ dueAt: new Date(Date.now() + 86_400_000).toISOString(), amountCoupons: '50' }],
      guarantors: [{ barcodeId: guarantor.body.member.barcodeId, amountCoupons: '50' }],
    });
    expect(created.status).toBe(201);
    expect(created.body.requestedLenderId).toBe(sourceUser.id);
    expect(created.body.description).toBe('Emergency household expenses');
    const guaranteeId = created.body.guarantees[0].id as string;
    const approved = await request(app).post(`/v1/me/guarantees/${guaranteeId}/approve`).set('Authorization', `Bearer ${guarantorToken}`).send({ code: '1234', pin: '2468' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const activated = await request(app).post(`/v1/me/guarantees/${guaranteeId}/activate`).set('Authorization', `Bearer ${borrowerToken}`).send({ code: '1234' });
    expect(activated.status).toBe(200);
    const disbursed = await request(app).post(`/v1/me/loans/${created.body.id}/disburse`).set('Authorization', `Bearer ${sourceToken}`).send({ pin: '2468' });
    expect(disbursed.status).toBe(200);
    expect(disbursed.body.status).toBe('ACTIVE');
    expect(disbursed.body.lenderId).toBe(sourceUser.id);
    expect(await prisma.transaction.count({ where: { type: 'LOAN_DISBURSE', externalRef: `loan:${created.body.id}:disburse` } })).toBe(1);
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
      const app = createApp({
        config,
        prisma,
        queue: { add: async () => ({}) } as unknown as ApiDependencies['queue'],
        smsQueue: { add: async () => ({}) } as unknown as ApiDependencies['smsQueue'],
        redis,
      });
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

  it('approves and revokes a charity purchase guarantee over HTTP', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'48'.repeat(20)}`) });
    const admin = await createAdmin(AdminRole.ADMIN);
    const adminJwt = await adminToken(app, admin.username);
    const beneficiary = await request(app).post('/v1/auth/register').send({ phone: '+1555000320', pin: '2468' });
    const agent = await request(app).post('/v1/auth/register').send({ phone: '+1555000321', pin: '2468' });
    await completeMemberSetup('+1555000320');
    await completeMemberSetup('+1555000321');
    const agentUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000321' } });
    await prisma.escrowBalance.create({ data: { userId: agentUser.id, lockedMicroUsdt: 10_000_000n } });
    const charity = await request(app).post('/admin/charities').set('Authorization', `Bearer ${adminJwt}`).send({ name: 'Guarantee HTTP Help' });
    expect(charity.status).toBe(201);
    const added = await request(app).post(`/admin/charities/${charity.body.id}/agents`).set('Authorization', `Bearer ${adminJwt}`).send({ barcodeId: agent.body.member.barcodeId, role: 'AGENT' });
    expect(added.status).toBe(201);
    const aid = await request(app).post('/v1/me/aid-requests').set('Authorization', `Bearer ${beneficiary.body.tokens.accessToken}`).send({ charityId: charity.body.id, amountCoupons: '500', description: 'purchase backing' });
    expect(aid.status).toBe(201);
    const approval = await request(app).post(`/v1/me/charity-requests/${aid.body.id}/approve`).set('Authorization', `Bearer ${agent.body.tokens.accessToken}`).send({ approvedCoupons: '500', mode: 'GUARANTEE', pin: '2468' });
    expect(approval.status).toBe(200);
    expect(approval.body).toMatchObject({ status: 'GUARANTEED', guaranteeId: expect.any(String) });
    const escrow = await request(app).get('/v1/me/escrow').set('Authorization', `Bearer ${beneficiary.body.tokens.accessToken}`);
    expect(escrow.status).toBe(200);
    expect(escrow.body.guaranteedCoupons).toBe('500');
    expect(escrow.body.guarantees).toHaveLength(1);
    expect(escrow.body.guarantees[0]).toMatchObject({ id: approval.body.guaranteeId, charityName: 'Guarantee HTTP Help', remainingCoupons: '500' });
    const backed = await request(app).get('/v1/me/charity-guarantees').set('Authorization', `Bearer ${agent.body.tokens.accessToken}`);
    expect(backed.status).toBe(200);
    expect(backed.body.items).toHaveLength(1);
    expect(backed.body.items[0]).toMatchObject({ id: approval.body.guaranteeId, status: 'ACTIVE', remainingCoupons: '500' });
    const revoked = await request(app).post(`/v1/me/charity-guarantees/${approval.body.guaranteeId}/revoke`).set('Authorization', `Bearer ${agent.body.tokens.accessToken}`).send({ pin: '2468' });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('REVOKED');
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

describe('scoped API keys', () => {
  it('allows admins to create scoped keys and protects partner routes', async () => {
    const { app } = appFixture();
    const admin = await createAdmin(AdminRole.ADMIN, 'correct-password', 'api-keys-admin@example.com');
    const adminJwt = await adminToken(app, admin.username);
    const created = await request(app).post('/admin/api-keys').set('Authorization', `Bearer ${adminJwt}`).send({
      name: 'Market child',
      scopes: ['read:market_average'],
    });
    expect(created.status).toBe(201);
    expect(created.body.rawKey).toMatch(/^tck_[A-Za-z0-9_-]{40}$/);
    expect(created.body.keyHash).toBeUndefined();
    const listed = await request(app).get('/admin/api-keys').set('Authorization', `Bearer ${adminJwt}`);
    expect(listed.status).toBe(200);
    expect(listed.body[0]).not.toHaveProperty('rawKey');
    expect(listed.body[0]).not.toHaveProperty('keyHash');
    expect(listed.body[0].createdBy).toEqual({ username: admin.username });
    expect((await request(app).get('/v1/partner/market-average').set('Authorization', `Bearer ${created.body.rawKey}`)).status).toBe(200);
    const insufficient = await request(app).post('/admin/api-keys').set('Authorization', `Bearer ${adminJwt}`).send({ name: 'Reserves child', scopes: ['read:reserves'] });
    const denied = await request(app).get('/v1/partner/market-average').set('Authorization', `Bearer ${insufficient.body.rawKey}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: 'insufficient_scope', required: ['read:market_average'] });
    expect((await request(app).get('/v1/partner/market-average')).status).toBe(401);
    expect((await request(app).get('/v1/partner/market-average').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).post(`/admin/api-keys/${created.body.id}/revoke`).set('Authorization', `Bearer ${adminJwt}`)).status).toBe(200);
    expect((await request(app).get('/v1/partner/market-average').set('Authorization', `Bearer ${created.body.rawKey}`)).status).toBe(401);
    expect(await prisma.adminAuditLog.count({ where: { action: 'api_key.revoke', entityId: created.body.id } })).toBe(1);
  });

  it('requires the ADMIN role and rejects expired partner keys', async () => {
    const { app } = appFixture();
    const approver = await createAdmin(AdminRole.APPROVER, 'correct-password', 'api-keys-approver@example.com');
    const approverJwt = await adminToken(app, approver.username);
    expect((await request(app).get('/admin/api-keys').set('Authorization', `Bearer ${approverJwt}`)).status).toBe(403);
    expect((await request(app).post('/admin/api-keys').set('Authorization', `Bearer ${approverJwt}`).send({ name: 'Nope', scopes: ['read:reserves'] })).status).toBe(403);
    const admin = await createAdmin(AdminRole.ADMIN, 'correct-password', 'api-keys-expired@example.com');
    const adminJwt = await adminToken(app, admin.username);
    const expired = await request(app).post('/admin/api-keys').set('Authorization', `Bearer ${adminJwt}`).send({
      name: 'Expired child',
      scopes: ['read:reserves'],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(expired.status).toBe(201);
    expect((await request(app).get('/v1/partner/reserves').set('Authorization', `Bearer ${expired.body.rawKey}`)).status).toBe(401);
  });
});

describe('directed escrow API', () => {
  it('lists only active incoming directed pay codes for the authenticated merchant', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'44'.repeat(20)}`) });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000310', barcodeId: 'directed-buyer' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000311', barcodeId: 'directed-merchant' });
    const buyerToken = await memberToken(app, '+1555000310');
    const merchantToken = await memberToken(app, '+1555000311');
    const buyer = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'directed-buyer' } });
    await prisma.escrowBalance.create({ data: { userId: buyer.id, lockedMicroUsdt: 5_000_000n } });
    const created = await request(app).post('/v1/me/escrow/pay-codes').set('Authorization', `Bearer ${buyerToken}`).send({ code: '1234', merchantBarcodeId: 'directed-merchant', amount: '1.25', pin: '2468' });
    expect(created.status).toBe(201);
    const incoming = await request(app).get('/v1/me/escrow/pay-codes/incoming').set('Authorization', `Bearer ${merchantToken}`);
    expect(incoming.status).toBe(200);
    expect(incoming.body.items).toMatchObject([{ id: created.body.id, amount: '1.25', buyerBarcodeId: 'directed-buyer' }]);
    await prisma.payCode.update({ where: { id: created.body.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect((await request(app).get('/v1/me/escrow/pay-codes/incoming').set('Authorization', `Bearer ${merchantToken}`)).body.items).toHaveLength(0);
  });

  it('creates coupon-denominated directed pay codes and returns coupon amounts', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'45'.repeat(20)}`) });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000315', barcodeId: 'coupon-buyer' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000316', barcodeId: 'coupon-merchant' });
    const buyerToken = await memberToken(app, '+1555000315');
    const merchantToken = await memberToken(app, '+1555000316');
    const buyer = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'coupon-buyer' } });
    await prisma.escrowBalance.create({ data: { userId: buyer.id, lockedMicroUsdt: 5_000_000n } });
    const created = await request(app).post('/v1/me/escrow/pay-codes').set('Authorization', `Bearer ${buyerToken}`).send({ code: '2345', merchantBarcodeId: 'coupon-merchant', amountCoupons: '125', pin: '2468' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ amount: '1.25', amountCoupons: '125', merchantBarcodeId: 'coupon-merchant' });
    const stored = await prisma.payCode.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.amountMicroUsdt).toBe(1_250_000n);
    const incoming = await request(app).get('/v1/me/escrow/pay-codes/incoming').set('Authorization', `Bearer ${merchantToken}`);
    expect(incoming.status).toBe(200);
    expect(incoming.body.items).toMatchObject([{ id: created.body.id, amount: '1.25', amountCoupons: '125' }]);
  });

  it('preserves decimal coupon amounts through pay-code settlement', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'47'.repeat(20)}`) });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000321', barcodeId: 'decimal-buyer' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000322', barcodeId: 'decimal-merchant' });
    const buyerToken = await memberToken(app, '+1555000321');
    const merchantToken = await memberToken(app, '+1555000322');
    const buyer = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'decimal-buyer' } });
    await addSystemAccounts();
    await prisma.escrowBalance.create({ data: { userId: buyer.id, lockedMicroUsdt: 5_000_000n } });
    const created = await request(app).post('/v1/me/escrow/pay-codes').set('Authorization', `Bearer ${buyerToken}`).send({ code: '3456', merchantBarcodeId: 'decimal-merchant', amountCoupons: '12.5', pin: '2468' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ amount: '0.125', amountCoupons: '12.5' });
    const incoming = await request(app).get('/v1/me/escrow/pay-codes/incoming').set('Authorization', `Bearer ${merchantToken}`);
    expect(incoming.body.items).toMatchObject([{ amount: '0.125', amountCoupons: '12.5' }]);
    const settlement = await request(app).post('/v1/me/escrow/settlements').set('Authorization', `Bearer ${merchantToken}`).send({ payCodeId: created.body.id, code: '3456', pin: '2468', idempotencyKey: 'decimal-settlement' });
    expect(settlement.status).toBe(201);
    expect((await prisma.escrowSettlement.findUniqueOrThrow({ where: { payCodeId: created.body.id } })).amountMicroUsdt).toBe(125_000n);
  });

  it('removes an idle wallet and rejects locked or foreign wallets', async () => {
    const { app } = appFixture(undefined, undefined, { escrowContractAddress: getAddress(`0x${'55'.repeat(20)}`) });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000313', barcodeId: 'wallet-owner' });
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000314', barcodeId: 'wallet-other' });
    await prisma.user.update({ where: { barcodeId: 'wallet-owner' }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } });
    const ownerToken = await memberToken(app, '+1555000313');
    const otherToken = await memberToken(app, '+1555000314');
    const owner = await prisma.user.findUniqueOrThrow({ where: { barcodeId: 'wallet-owner' } });
    const idle = await request(app).post('/v1/me/wallets').set('Authorization', `Bearer ${ownerToken}`).send({ address: `0x${'66'.repeat(20)}`, kind: 'IN_APP' });
    expect(idle.status).toBe(201);
    expect((await request(app).delete(`/v1/me/wallets/${idle.body.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ pin: '2468' })).status).toBe(204);
    const locked = await request(app).post('/v1/me/wallets').set('Authorization', `Bearer ${ownerToken}`).send({ address: `0x${'77'.repeat(20)}`, kind: 'IN_APP' });
    await prisma.escrowBalance.create({ data: { userId: owner.id, lockedMicroUsdt: 1n } });
    const lockedResult = await request(app).delete(`/v1/me/wallets/${locked.body.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ pin: '2468' });
    expect(lockedResult.status).toBe(409);
    expect(lockedResult.body).toEqual({ error: 'unload your escrow balance before removing the wallet' });
    const foreign = await request(app).post('/v1/me/wallets').set('Authorization', `Bearer ${await memberToken(app, '+1555000314')}`).send({ address: `0x${'88'.repeat(20)}`, kind: 'IN_APP' });
    expect((await request(app).delete(`/v1/me/wallets/${foreign.body.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ pin: '2468' })).status).toBe(404);
    void otherToken;
  });
});

describe('public reserves and balance disclosure API', () => {
  async function createPublicUser(phone: string, barcodeId: string) {
    return provisionUser(prisma, { depositXpub: config.depositXpub }, { phoneNumber: phone, barcodeId });
  }

  it('publishes separate ledger-derived real and demo reserves and anonymized newest-first feed', async () => {
    const { app } = appFixture();
    const systems = await addSystemAccounts();
    const real = await createPublicUser('+15550003001', 'public-real');
    const demo = await createPublicUser('+15550003002', 'public-demo');
    await prisma.user.update({ where: { id: demo.id }, data: { isDemo: true } });
    const demoIssuance = await account(AccountType.SYSTEM_DEMO_ISSUANCE, Asset.COUPON);
    await prisma.ledgerAccount.update({ where: { id: demoIssuance.id }, data: { balance: -99n } });
    const realTransaction = await prisma.transaction.create({
      data: { type: TransactionType.TRANSFER, status: 'CONFIRMED', amountCoupons: 25n, amountMicroUsdt: 250_000n, externalRef: 'public-real-transfer', userId: real.id },
    });
    await prisma.transaction.create({
      data: { type: TransactionType.DEMO_ISSUE, status: 'CONFIRMED', amountCoupons: 99n, externalRef: 'public-demo-issue', userId: demo.id },
    });
    const realAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: real.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await prisma.ledgerAccount.update({ where: { id: realAccount.id }, data: { balance: 25n } });
    await prisma.ledgerEntry.create({ data: { transactionId: realTransaction.id, fromAccountId: systems.issuance.id, toAccountId: realAccount.id, amount: 25n, asset: Asset.COUPON } });
    const reserves = await request(app).get('/v1/public/reserves');
    expect(reserves.status).toBe(200);
    expect(reserves.body.real.couponsInCirculation).toBe('0');
    expect(reserves.body.demo.couponsInCirculation).toBe('99');
    expect(reserves.body.demo.userCount).toBe(1);
    const feed = await request(app).get('/v1/public/ledger?limit=1');
    expect(feed.status).toBe(200);
    expect(feed.body.items).toHaveLength(1);
    expect(feed.body.items[0]).toMatchObject({ type: 'TRANSFER', amountCoupons: '25', amountUsdt: '0.250000', isDemo: false });
    expect(feed.body.items[0]).not.toHaveProperty('userId');
    expect(feed.body.items[0]).not.toHaveProperty('transactionId');
  });

  it('returns barcode status only and enforces one-time disclosure confirmation', async () => {
    const { app } = appFixture();
    await createPublicUser('+15550003003', 'public-owner');
    const status = await request(app).get('/v1/public/barcodes/public-owner');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ barcodeId: 'public-owner', isDemo: false, valid: true });
    expect(status.body).not.toHaveProperty('balance');
    const missing = await request(app).get('/v1/public/barcodes/unknown-public');
    expect(missing.status).toBe(404);
    const created = await request(app).post('/v1/public/barcodes/public-owner/disclosure');
    expect(created.status).toBe(201);
    expect(created.body).toHaveProperty('requestId');
    expect(created.body).not.toHaveProperty('code');
    const duplicate = await request(app).post('/v1/public/barcodes/public-owner/disclosure');
    expect(duplicate.status).toBe(409);
    const direct = await prisma.balanceDisclosureRequest.create({
      data: { userId: (await createPublicUser('+15550003006', 'public-owner-two')).id, code: '000001', expiresAt: new Date(Date.now() + 600_000) },
    });
    const ownerToken = await memberToken(app, '+15550003006');
    const disclosures = await request(app).get('/v1/me/disclosures').set('Authorization', `Bearer ${ownerToken}`);
    expect(disclosures.status).toBe(200);
    expect(disclosures.body.items).toEqual([expect.objectContaining({ id: direct.id, code: '000001' })]);
    expect((await prisma.balanceDisclosureRequest.findUniqueOrThrow({ where: { id: direct.id } })).code).toBe('000001');
    await createPublicUser('+15550003004', 'public-stranger');
    const strangerToken = await memberToken(app, '+15550003004');
    const denied = await request(app).post(`/v1/me/disclosures/${direct.id}/deny`).set('Authorization', `Bearer ${strangerToken}`);
    expect(denied.status).toBe(404);
    const wrong = await request(app).post(`/v1/public/disclosures/${direct.id}/confirm`).send({ code: '999999' });
    expect(wrong.status).toBe(401);
    await prisma.balanceDisclosureRequest.update({ where: { id: direct.id }, data: { attempts: 4 } });
    const fifth = await request(app).post(`/v1/public/disclosures/${direct.id}/confirm`).send({ code: '999999' });
    expect(fifth.status).toBe(401);
    expect((await prisma.balanceDisclosureRequest.findUniqueOrThrow({ where: { id: direct.id } }))).toMatchObject({ status: BalanceDisclosureStatus.DENIED, code: null });
  });

  it('expires requests, denies pending owner requests, and returns confirmation history once', async () => {
    const { app } = appFixture();
    const systems = await addSystemAccounts();
    const owner = await createPublicUser('+15550003005', 'public-history');
    const ownerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: owner.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await prisma.ledgerAccount.update({ where: { id: ownerAccount.id }, data: { balance: 75n } });
    const historyBase = Date.now();
    const oldestCreatedAt = new Date(historyBase - 180_000);
    const newestCreatedAt = new Date(historyBase - 120_000);
    const heldCreatedAt = new Date(historyBase - 60_000);
    const oldestTransaction = await prisma.transaction.create({ data: { type: TransactionType.TRANSFER, status: 'COMPLETED', amountCoupons: 25n, externalRef: 'public-history-oldest', createdAt: oldestCreatedAt } });
    const newestTransaction = await prisma.transaction.create({ data: { type: TransactionType.TRANSFER, status: 'COMPLETED', amountCoupons: 50n, externalRef: 'public-history-newest', createdAt: newestCreatedAt } });
    const escrowAccount = await account(AccountType.ESCROW, Asset.COUPON);
    const heldTransaction = await prisma.transaction.create({ data: { type: TransactionType.ESCROW_HOLD, status: 'CONFIRMED', amountCoupons: 10n, externalRef: 'public-history-held', createdAt: heldCreatedAt } });
    await prisma.ledgerEntry.create({ data: { transactionId: oldestTransaction.id, fromAccountId: systems.issuance.id, toAccountId: ownerAccount.id, amount: 25n, asset: Asset.COUPON, createdAt: oldestCreatedAt } });
    await prisma.ledgerEntry.create({ data: { transactionId: newestTransaction.id, fromAccountId: systems.issuance.id, toAccountId: ownerAccount.id, amount: 50n, asset: Asset.COUPON, createdAt: newestCreatedAt } });
    await prisma.ledgerEntry.create({ data: { transactionId: heldTransaction.id, fromAccountId: ownerAccount.id, toAccountId: escrowAccount.id, amount: 10n, asset: Asset.COUPON, createdAt: heldCreatedAt } });
    const expired = await prisma.balanceDisclosureRequest.create({ data: { userId: owner.id, code: '000002', expiresAt: new Date(Date.now() - 1_000) } });
    const expiredResponse = await request(app).post(`/v1/public/disclosures/${expired.id}/confirm`).send({ code: '000002' });
    expect(expiredResponse.status).toBe(410);
    expect((await prisma.balanceDisclosureRequest.findUniqueOrThrow({ where: { id: expired.id } })).code).toBeNull();
    const pending = await prisma.balanceDisclosureRequest.create({ data: { userId: owner.id, code: '000003', expiresAt: new Date(Date.now() + 600_000) } });
    const ownerToken = await memberToken(app, '+15550003005');
    const denied = await request(app).post(`/v1/me/disclosures/${pending.id}/deny`).set('Authorization', `Bearer ${ownerToken}`);
    expect(denied.status).toBe(204);
    expect((await prisma.balanceDisclosureRequest.findUniqueOrThrow({ where: { id: pending.id } })).code).toBeNull();
    const success = await prisma.balanceDisclosureRequest.create({ data: { userId: owner.id, code: '000004', expiresAt: new Date(Date.now() + 600_000) } });
    const confirmed = await request(app).post(`/v1/public/disclosures/${success.id}/confirm`).send({ code: '000004' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ barcodeId: 'public-history', balanceCoupons: '75', totalReceivedCoupons: '75' });
    expect(confirmed.body.transactions[0]).toMatchObject({ type: 'ESCROW_HOLD', status: 'CONFIRMED', amountCoupons: '-10', balanceAfterCoupons: '75' });
    expect(confirmed.body.transactions[1]).toMatchObject({ amountCoupons: '50', balanceAfterCoupons: '85' });
    expect(confirmed.body.transactions[2]).toMatchObject({ amountCoupons: '25', balanceAfterCoupons: '35' });
    expect((await prisma.balanceDisclosureRequest.findUniqueOrThrow({ where: { id: success.id } })).code).toBeNull();
    const reused = await request(app).post(`/v1/public/disclosures/${success.id}/confirm`).send({ code: '000004' });
    expect(reused.status).toBe(410);
  });
});

describe('admin API', () => {
  it('round-trips country-specific commission floors through settings', async () => {
    const { app } = appFixture();
    const admin = await createAdmin(AdminRole.ADMIN, 'correct-password', 'commission-settings-admin');
    const jwt = await adminToken(app, admin.username);
    const updated = await request(app)
      .patch('/admin/settings')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ commissionFloorBps: 250, commissionFloorByCountry: [{ country: 'no', bps: 350 }], trainerCutBps: 2200 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      commissionFloorBps: 250,
      commissionFloorByCountry: [{ country: 'NO', bps: 350 }],
      trainerCutBps: 2200,
    });
    const read = await request(app).get('/admin/settings').set('Authorization', `Bearer ${jwt}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      commissionFloorBps: 250,
      commissionFloorByCountry: [{ country: 'NO', bps: 350 }],
      trainerCutBps: 2200,
    });
  });

  it('lists and decides manual identity reviews, purges media, and preserves rejected identity state', async () => {
    const { app } = appFixture();
    const admin = await createAdmin(AdminRole.APPROVER);
    const jwt = await adminToken(app, admin.username);
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000040', barcodeId: 'manual-admin-approve' });
    const memberJwt = await memberToken(app, '+1555000040');
    expect((await request(app).put('/v1/me/country').set('Authorization', `Bearer ${memberJwt}`).send({ country: 'NO' })).status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000040' } });
    const session = await createCaptureFixture(user.id, 'admin-capture-40');
    const captureAssets = await prisma.mediaAsset.findMany({ where: { captureSessionId: session.id } });
    const submitted = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${memberJwt}`).send({ captureSessionId: session.id });
    const reviewId = submitted.body.id as string;
    const listed = await request(app).get('/admin/identity-reviews').set('Authorization', `Bearer ${jwt}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ id: reviewId, barcodeId: 'manual-admin-approve', country: 'NO', status: 'PENDING', challengeCode: '1234' });
    expect(listed.body.items[0].frames.map((frame: { step: string }) => frame.step)).toEqual([
      'DOCUMENT_FRONT',
      'SELFIE_NEUTRAL',
      'SELFIE_TURNED',
      'SELFIE_WITH_DOCUMENT',
    ]);
    expect(listed.body.items[0].frames.every((frame: { capturedAt: string }) => typeof frame.capturedAt === 'string')).toBe(true);
    await prisma.user.update({ where: { id: user.id }, data: { kycStatus: 'PENDING' } });
    const approved = await request(app).post(`/admin/identity-reviews/${reviewId}/approve`).set('Authorization', `Bearer ${jwt}`);
    expect(approved.status).toBe(200);
    const approvedReview = await prisma.identityReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(approvedReview).toMatchObject({ status: 'APPROVED', documentAssetId: null, selfieAssetId: null, decidedByAdminId: admin.id });
    expect(approvedReview.decidedAt).toEqual(expect.any(Date));
    expect(await prisma.mediaAsset.count({ where: { id: { in: captureAssets.map((asset) => asset.id) } } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { entityId: reviewId, action: 'identity_review.approve' } })).toBe(1);
    const approvedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(approvedUser.identityVerificationStatus).toBe('VERIFIED');
    expect(approvedUser.identityVerifiedAt).toEqual(expect.any(Date));
    expect(approvedUser.kycStatus).toBe('PENDING');
    expect((await request(app).get(`/admin/identity-reviews/${reviewId}/media/${captureAssets[0]!.id}`).set('Authorization', `Bearer ${jwt}`)).status).toBe(404);

    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '+1555000041', barcodeId: 'manual-admin-reject' });
    const rejectMemberJwt = await memberToken(app, '+1555000041');
    await request(app).put('/v1/me/country').set('Authorization', `Bearer ${rejectMemberJwt}`).send({ country: 'NO' });
    const rejectUser = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '+1555000041' } });
    const rejectSession = await createCaptureFixture(rejectUser.id, 'admin-capture-41');
    const rejectAssets = await prisma.mediaAsset.findMany({ where: { captureSessionId: rejectSession.id } });
    const rejectSubmitted = await request(app).post('/v1/me/identity/manual-review').set('Authorization', `Bearer ${rejectMemberJwt}`).send({ captureSessionId: rejectSession.id });
    await prisma.user.update({ where: { id: rejectUser.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date(), nationalIdHash: 'preserve-me' } });
    const rejected = await request(app).post(`/admin/identity-reviews/${rejectSubmitted.body.id}/reject`).set('Authorization', `Bearer ${jwt}`).send({ note: 'The images do not match.' });
    expect(rejected.status).toBe(200);
    const afterReject = await prisma.user.findUniqueOrThrow({ where: { id: rejectUser.id } });
    expect(afterReject.identityVerificationStatus).toBe('VERIFIED');
    expect(afterReject.nationalIdHash).toBe('preserve-me');
    const rejectedReview = await prisma.identityReview.findUniqueOrThrow({ where: { id: rejectSubmitted.body.id } });
    expect(rejectedReview).toMatchObject({ status: 'REJECTED', decisionNote: 'The images do not match.', documentAssetId: null, selfieAssetId: null });
    expect(await prisma.mediaAsset.count({ where: { id: { in: rejectAssets.map((asset) => asset.id) } } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { entityId: rejectSubmitted.body.id, action: 'identity_review.reject' } })).toBe(1);
  });

  it('refuses approval after a country becomes automated and refuses decided reviews', async () => {
    const { app } = appFixture(undefined, undefined, { shahkarApiToken: 'configured', identityHashPepper: 'configured-pepper-at-least-32-characters' });
    const admin = await createAdmin(AdminRole.ADMIN);
    const jwt = await adminToken(app, admin.username);
    await request(app).post('/v1/users').set('Authorization', `Bearer ${token}`).send({ phone: '09000000042', barcodeId: 'manual-admin-conflict' });
    await memberToken(app, '09000000042');
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: '09000000042' } });
    const session = await createCaptureFixture(user.id, 'admin-capture-42');
    const assets = await prisma.mediaAsset.findMany({ where: { captureSessionId: session.id }, orderBy: { captureStep: 'asc' } });
    const review = await prisma.identityReview.create({ data: { userId: user.id, country: 'IR', captureSessionId: session.id, challengeCode: session.challengeCode, documentAssetId: assets.find((asset) => asset.captureStep === IdentityCaptureStep.DOCUMENT_FRONT)!.id, selfieAssetId: assets.find((asset) => asset.captureStep === IdentityCaptureStep.SELFIE_NEUTRAL)!.id, documentFrontCapturedAt: assets[0]!.createdAt, selfieNeutralCapturedAt: assets[1]!.createdAt, selfieTurnedCapturedAt: assets[2]!.createdAt, selfieWithDocumentCapturedAt: assets[3]!.createdAt } });
    const conflict = await request(app).post(`/admin/identity-reviews/${review.id}/approve`).set('Authorization', `Bearer ${jwt}`);
    expect(conflict.status).toBe(409);
    await prisma.identityReview.update({ where: { id: review.id }, data: { status: 'REJECTED' } });
    const decided = await request(app).post(`/admin/identity-reviews/${review.id}/approve`).set('Authorization', `Bearer ${jwt}`);
    expect(decided.status).toBe(409);
  });

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
    expect(result.body.commissionNetworkAverageBps).toBe(0);
    expect(result.body.hotWallet).toMatchObject({ available: true, usdt: '10', nativeWei: '2000000000000000000' });
    expect(result.body.solvency.isSolvent).toBe(true);
    expect(result.body.solvency).toMatchObject({
      custodyUsdt: '0',
      obligationsUsdt: '0',
      surplusUsdt: '0',
      components: { vaultUsdt: '0', withdrawalPendingUsdt: '0', feesUsdt: '0', couponsUsdt: '0', dustUsdt: '0' },
    });
    expect(result.body.commissionNetworkAverageBps).toBe(0);

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
    const defaultDisplayUnit = await request(app).get('/v1/public/display-unit');
    expect(defaultDisplayUnit.status).toBe(200);
    expect(defaultDisplayUnit.body).toEqual({
      en: { singular: 'US cent', plural: 'US cents' },
      fa: 'سنت دلار آمریکا',
    });
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
      identityRequiredCountries: ['ir', 'NO', 'ir'],
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ withdrawalBaseFeeBps: '250', minimumFeeMicroUsdt: '300000', minimumWithdrawalMicroUsdt: '2000000', identityRequiredCountries: ['IR', 'NO'] });
    const displayUnitUpdate = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({
      displayUnit: { en: { singular: 'Credit cent', plural: 'Credit cents' }, fa: 'سنت اعتبار' },
    });
    expect(displayUnitUpdate.status).toBe(200);
    expect(displayUnitUpdate.body.displayUnit).toEqual({
      en: { singular: 'Credit cent', plural: 'Credit cents' },
      fa: 'سنت اعتبار',
    });
    expect((await request(app).get('/admin/settings').set('Authorization', `Bearer ${jwt}`)).body.displayUnit).toEqual({
      en: { singular: 'Credit cent', plural: 'Credit cents' },
      fa: 'سنت اعتبار',
    });
    expect((await request(app).get('/v1/public/display-unit')).body).toEqual({
      en: { singular: 'Credit cent', plural: 'Credit cents' },
      fa: 'سنت اعتبار',
    });
    const invalidDisplayUnit = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({
      displayUnit: { en: { singular: '', plural: 'Credit cents' }, fa: 'سنت اعتبار' },
    });
    expect(invalidDisplayUnit.status).toBe(400);
    expect(await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'IDENTITY_REQUIRED_COUNTRIES' } })).toMatchObject({ value: 'IR,NO' });
    expect(await prisma.adminAuditLog.count({ where: { action: 'settings.update' } })).toBe(2);
    const unknown = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ unexpected: '1' });
    expect(unknown.status).toBe(400);
    const invalidFee = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ withdrawalBaseFeeBps: '10001' });
    expect(invalidFee.status).toBe(400);
    expect(invalidFee.body).toEqual({
      error: 'validation failed',
      fields: [{ path: 'withdrawalBaseFeeBps', message: 'fee bps must be between 0 and 10000' }],
    });
    const invalidCountry = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ identityRequiredCountries: ['IR', 'iran'] });
    expect(invalidCountry.status).toBe(400);
    expect(invalidCountry.body.fields[0]).toEqual({ path: 'identityRequiredCountries.1', message: 'country code must be exactly two letters' });
    expect(await prisma.adminAuditLog.count({ where: { action: 'settings.update' } })).toBe(2);
    const invalidMinimumFee = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({ minimumFeeMicroUsdt: '100000001' });
    expect(invalidMinimumFee.status).toBe(400);
    expect(invalidMinimumFee.body.fields[0]).toEqual({ path: 'minimumFeeMicroUsdt', message: 'minimum fee must be at most 100 USDT' });
    const ledger = await request(app).get('/admin/ledger').query({ search: `withdrawal:${withdrawal.id}:burn` }).set('Authorization', `Bearer ${jwt}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items[0].externalRef).toBe(`withdrawal:${withdrawal.id}:burn`);
    expect(ledger.body.items[0].entries[0].amount).toEqual(expect.any(String));
  });
});
