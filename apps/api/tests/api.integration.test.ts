import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { getAddress, HDNodeWallet } from 'ethers';
import { Redis } from 'ioredis';
import bcrypt from 'bcryptjs';
import { AccountType, AdminRole, Asset, PrismaClient, WithdrawalStatus } from '@trustme/db';
import { postDeposit } from '@trustme/core';
import { createApp, type ApiDependencies } from '../src/app.js';
import type { AdminChainProvider } from '../src/admin.js';

const prisma = new PrismaClient();
const token = 'test-service-token';
const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: 'redis://localhost:56379',
  apiServiceToken: token,
  depositXpub: HDNodeWallet.createRandom().neuter().extendedKey,
  adminJwtSecret: 'test-admin-jwt-secret',
  adminJwtTtlSeconds: 3600,
  polygonRpcUrl: 'http://127.0.0.1:8545',
  usdtContractAddress: getAddress(`0x${'99'.repeat(20)}`),
  hotWalletAddress: getAddress(`0x${'aa'.repeat(20)}`),
  port: 3100,
  bodyLimit: '32kb',
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100,
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

function appFixture(chainProvider?: AdminChainProvider) {
  const calls: unknown[][] = [];
  const queue = { add: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as ApiDependencies['queue'];
  const redis = { ping: async () => 'PONG' };
  const app = createApp({ config, prisma, queue, redis, chainProvider });
  return { app, calls };
}

async function createAdmin(role: AdminRole, password = 'correct-password') {
  return prisma.adminUser.create({
    data: { username: `${role.toLowerCase()}@example.com`, passwordHash: await bcrypt.hash(password, 10), role },
  });
}

async function adminToken(app: ReturnType<typeof appFixture>['app'], email: string, password = 'correct-password') {
  const result = await request(app).post('/admin/login').send({ email, password });
  expect(result.status).toBe(200);
  return result.body.token as string;
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
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
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
});

describe('admin API', () => {
  it('authenticates admins without distinguishing login failures and enforces roles', async () => {
    const { app } = appFixture();
    await createAdmin(AdminRole.VIEWER);
    const success = await request(app).post('/admin/login').send({ email: 'viewer@example.com', password: 'correct-password' });
    expect(success.status).toBe(200);
    expect(success.body.token).toEqual(expect.any(String));
    const wrongPassword = await request(app).post('/admin/login').send({ email: 'viewer@example.com', password: 'wrong-password' });
    const unknownEmail = await request(app).post('/admin/login').send({ email: 'unknown@example.com', password: 'wrong-password' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    const tokenValue = success.body.token as string;
    const settings = await request(app).patch('/admin/settings').set('Authorization', `Bearer ${tokenValue}`).send({ withdrawalBaseFeeBps: '200' });
    expect(settings.status).toBe(403);
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
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
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
    expect(await prisma.adminAuditLog.count({ where: { action: 'settings.update' } })).toBe(1);
    const ledger = await request(app).get('/admin/ledger').query({ search: `withdrawal:${withdrawal.id}:burn` }).set('Authorization', `Bearer ${jwt}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items[0].externalRef).toBe(`withdrawal:${withdrawal.id}:burn`);
    expect(ledger.body.items[0].entries[0].amount).toEqual(expect.any(String));
  });
});
