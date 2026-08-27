import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
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

function appFixture(chainProvider?: AdminChainProvider, queueOverride?: ApiDependencies['queue'], configOverride: Partial<typeof config> = {}) {
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
    logEmailCode: (email, code) => emailCodes.set(email, code),
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
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash('2468', 12), ...(displayName === undefined ? {} : { displayName }) } });
  const login = await request(app).post('/v1/auth/login').send({ phone, pin: '2468' });
  expect(login.status).toBe(200);
  return login.body.tokens.accessToken as string;
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
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
  await prisma.systemSetting.createMany({ data: [
    { key: 'WITHDRAWAL_BASE_FEE_BPS', value: '100' },
    { key: 'MIN_WITHDRAWAL_USDT', value: '1' },
    { key: 'AUTO_APPROVAL_LIMIT_USDT', value: '1000' },
  ] });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('member API', () => {
  it('supports PIN signup and token-scoped profile reads', async () => {
    const { app } = appFixture();
    const registered = await request(app).post('/v1/auth/register').send({ phone: '+1555000120', pin: '2468', displayName: 'Coupon User' });
    expect(registered.status).toBe(201);
    expect(registered.body).not.toHaveProperty('pin');
    expect(registered.body.member).toMatchObject({ displayName: 'Coupon User', barcodeId: expect.stringMatching(/^TC[0-9ABCDEFGHJKMNPQRSTVWXYZ]{14}$/), phone: '*-*-0120', isRestricted: false });
    const profile = await request(app).get('/v1/me').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`);
    expect(profile.status).toBe(200);
    expect(await prisma.ledgerAccount.count({ where: { user: { phoneNumber: '+1555000120' } } })).toBe(2);
    expect(await prisma.depositAddress.count({ where: { user: { phoneNumber: '+1555000120' } } })).toBe(1);
    expect((await request(app).post('/v1/auth/login').send({ phone: '+1555000120', pin: '2468' })).status).toBe(200);
    expect((await request(app).post('/v1/auth/register').send({ phone: '+1555000120', pin: '2468' })).status).toBe(409);
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

  it('returns 503 for email delivery none and never returns email codes', async () => {
    const { app } = appFixture(undefined, undefined, { emailDelivery: 'none' });
    const response = await request(app).post('/v1/auth/register').send({ phone: '+1555000125', pin: '2468', email: 'member@example.com' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'email delivery not configured' });
    expect(response.body).not.toHaveProperty('code');
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
    const verified = await request(app).post('/v1/me/email/verify').set('Authorization', `Bearer ${accessToken}`).send({ code: emailCodes.get('reset@example.com') });
    expect(verified.status).toBe(200);
    expect(verified.body.emailVerified).toBe(true);
    const requested = await request(app).post('/v1/auth/pin-reset/request').send({ email: 'reset@example.com' });
    expect(requested.status).toBe(202);
    const reset = await request(app).post('/v1/auth/pin-reset/confirm').send({ email: 'reset@example.com', code: emailCodes.get('reset@example.com'), pin: '1357' });
    expect(reset.status).toBe(200);
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
    const history = await request(app).get('/v1/me/transactions?limit=1').set('Authorization', `Bearer ${tokenA}`);
    expect(history.status).toBe(200);
    expect(history.body.items[0]).toMatchObject({ direction: 'in', amountCoupons: '1', counterparty: { displayName: 'Bob', barcodeId: 'member-b' } });
    expect(history.body.nextCursor).toEqual(expect.any(String));
    const next = await request(app).get(`/v1/me/transactions?limit=10&cursor=${encodeURIComponent(history.body.nextCursor)}`).set('Authorization', `Bearer ${tokenA}`);
    expect(next.status).toBe(200);
    expect(next.body.items.some((item: { direction: string; amountCoupons: string }) => item.direction === 'out' && item.amountCoupons === '1')).toBe(true);
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
    const updated = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${jwt}`).send({
      withdrawalBaseFeeBps: '250',
      minimumWithdrawalMicroUsdt: '2000000',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ withdrawalBaseFeeBps: '250', minimumWithdrawalMicroUsdt: '2000000' });
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
    const ledger = await request(app).get('/admin/ledger').query({ search: `withdrawal:${withdrawal.id}:burn` }).set('Authorization', `Bearer ${jwt}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items[0].externalRef).toBe(`withdrawal:${withdrawal.id}:burn`);
    expect(ledger.body.items[0].entries[0].amount).toEqual(expect.any(String));
  });
});
