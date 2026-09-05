import { createHash, createHmac } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { getAddress, HDNodeWallet } from 'ethers';
import { AccountType, AdminRole, ApiKeyScope, Asset, PrismaClient } from '@trustme/db';
import { createApiKey, postDeposit, transferTopic } from '@trustme/core';
import { createApp, type ApiDependencies } from '../src/app.js';
import { createAdminJwt } from '../src/admin-auth.js';
import { provisionUser } from '../src/user-provisioning.js';

const prisma = new PrismaClient();
const partnerSecret = 'test-partner-secret-key-that-is-at-least-32-characters';
const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: 'redis://localhost:56379',
  apiServiceToken: 'partner-test-service-token',
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
  hotWalletAddress: getAddress(`0x${'aa'.repeat(20)}`),
  port: 3100,
  bodyLimit: '32kb',
  rateLimitWindowMs: 60_000,
  rateLimitMax: 1000,
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
  partnerSecretKey: partnerSecret,
  confirmations: 12,
};

type Receipt = {
  status: number | null;
  blockNumber: number;
  logs: { address: string; topics: string[]; data: string; index: number }[];
};

let receipt: Receipt | null = null;
let head = 111;
const chain = {
  getTransactionReceipt: async () => receipt,
  getBlockNumber: async () => head,
};

function appFixture(configOverride: Partial<typeof config> = {}) {
  const queue = { add: async () => ({}) } as unknown as ApiDependencies['queue'];
  const smsQueue = { add: async () => ({}) } as unknown as ApiDependencies['smsQueue'];
  return createApp({
    config: { ...config, ...configOverride },
    prisma,
    queue,
    smsQueue,
    redis: { ping: async () => 'PONG' },
    partnerChainReader: chain,
  });
}

function signedRequest(
  app: ReturnType<typeof appFixture>,
  method: string,
  url: string,
  body: unknown,
  credentials: { key: string; secret: string },
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const canonical = `${timestamp}\n${method}\n${url}\n${createHash('sha256').update(rawBody).digest('hex')}`;
  const signature = createHmac('sha256', credentials.secret).update(canonical).digest('hex');
  const call = (method.toUpperCase() === 'GET' ? request(app).get(url) : request(app).post(url))
    .set('Authorization', `Bearer ${credentials.key}`)
    .set('X-TC-Timestamp', timestamp)
    .set('X-TC-Signature', signature);
  return body === undefined ? call : call.send(body);
}

async function systems() {
  const get = async (type: AccountType, asset: Asset) => {
    const existing = await prisma.ledgerAccount.findFirst({ where: { type, asset, userId: null } });
    return existing ?? prisma.ledgerAccount.create({ data: { type, asset } });
  };
  return {
    external: await get(AccountType.EXTERNAL_ONCHAIN, Asset.USDT),
    vault: await get(AccountType.SYSTEM_VAULT_USDT, Asset.USDT),
    issuance: await get(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON),
    fees: await get(AccountType.SYSTEM_FEE_COLLECTION, Asset.COUPON),
  };
}

async function createPartnerKey(app: ReturnType<typeof appFixture>, partnerBarcodeId: string) {
  const admin = await prisma.adminUser.create({
    data: { username: `partner-admin-${partnerBarcodeId}`, passwordHash: await bcrypt.hash('password', 10), role: AdminRole.ADMIN },
  });
  const token = createAdminJwt(admin.id, admin.username, admin.role, config.adminJwtSecret, config.adminJwtTtlSeconds);
  const result = await request(app).post('/admin/api-keys').set('Authorization', `Bearer ${token}`).send({
    name: 'Partner',
    partnerBarcodeId,
    scopes: ['partner:buyers', 'partner:deposits', 'partner:checkout'],
  });
  expect(result.status).toBe(201);
  return { key: result.body.rawKey as string, secret: result.body.rawSecret as string };
}

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ApiKey", "PartnerCheckout", "PartnerDepositNotice", "PartnerBuyer", "CommissionPayout", "EscrowHold", "AdminAuditLog", "AdminUser", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "SystemSetting" CASCADE');
  receipt = null;
  head = 111;
  await systems();
});
afterAll(async () => prisma.$disconnect());

describe('partner gateway', () => {
  it('issues partner secrets, enforces HMAC, scopes, and the unlinked guard', async () => {
    const app = appFixture();
    const partner = await provisionUser(prisma, { depositXpub: config.depositXpub }, { barcodeId: 'partner-admin-member', isDemo: false });
    const credentials = await createPartnerKey(app, partner.barcodeId);
    const missing = await request(app).get('/api/v1/buyers/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${credentials.key}`);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('signature_required');
    const bad = await signedRequest(app, 'GET', '/api/v1/buyers/00000000-0000-0000-0000-000000000000', undefined, { ...credentials, secret: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_signature');
    const stale = await request(app).get('/api/v1/buyers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${credentials.key}`).set('X-TC-Timestamp', `${Math.floor(Date.now() / 1000) - 600}`).set('X-TC-Signature', '0'.repeat(64));
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe('stale_timestamp');
    const okay = await signedRequest(app, 'GET', '/api/v1/buyers/00000000-0000-0000-0000-000000000000', undefined, credentials);
    expect(okay.status).toBe(404);
    const admin = await prisma.adminUser.create({ data: { username: 'scope-admin', passwordHash: 'hash', role: AdminRole.ADMIN } });
    const unlinkedKey = await createApiKey(prisma, { name: 'Unlinked', scopes: [ApiKeyScope.PARTNER_BUYERS], createdById: admin.id });
    const unlinked = await request(app).get('/api/v1/buyers/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${unlinkedKey.rawKey}`);
    expect(unlinked.status).toBe(403);
    expect(unlinked.body.error).toBe('partner_not_linked');
    const noPartner = await request(app).post('/admin/api-keys').set('Authorization', `Bearer ${createAdminJwt(admin.id, admin.username, admin.role, config.adminJwtSecret, 3600)}`).send({ name: 'Missing', scopes: ['partner:buyers'] });
    expect(noPartner.status).toBe(400);
    const noSecret = appFixture({ partnerSecretKey: undefined });
    const noSecretResult = await request(noSecret).post('/admin/api-keys').set('Authorization', `Bearer ${createAdminJwt(admin.id, admin.username, admin.role, config.adminJwtSecret, 3600)}`).send({ name: 'No secret', scopes: ['partner:buyers'], partnerBarcodeId: partner.barcodeId });
    expect(noSecretResult.status).toBe(400);
    expect(noSecretResult.body.error).toBe('partner_secret_key_not_configured');
  });

  it('creates idempotent buyers, verifies deposits, and exposes the alias', async () => {
    const app = appFixture();
    const partner = await provisionUser(prisma, { depositXpub: config.depositXpub }, { barcodeId: 'partner-deposit-member', isDemo: false });
    const credentials = await createPartnerKey(app, partner.barcodeId);
    const body = { externalRef: 'buyer-1', displayName: 'Buyer One' };
    const first = await signedRequest(app, 'POST', '/api/v1/buyers', body, credentials);
    const second = await signedRequest(app, 'POST', '/api/v1/buyers', body, credentials);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.buyerId).toBe(first.body.buyerId);
    const buyer = await prisma.partnerBuyer.findUniqueOrThrow({ where: { id: first.body.buyerId }, include: { user: { include: { depositAddresses: true } } } });
    expect(buyer.user.marketerId).toBe(partner.id);
    const txHash = `0x${'11'.repeat(32)}`;
    const deposit = { buyerId: buyer.id, txHash };
    const pending = await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', deposit, credentials);
    expect(pending.status).toBe(202);
    receipt = { status: 0, blockNumber: 100, logs: [] };
    expect((await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', deposit, credentials)).body.reason).toBe('tx_failed');
    const txHash2 = `0x${'22'.repeat(32)}`;
    const deposit2 = { buyerId: buyer.id, txHash: txHash2 };
    receipt = { status: 1, blockNumber: 105, logs: [] };
    const few = await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', deposit2, credentials);
    expect(few.status).toBe(202);
    expect(typeof few.body.confirmations).toBe('number');
    expect(typeof few.body.required).toBe('number');
    const txHashWrong = `0x${'2a'.repeat(32)}`;
    receipt = { status: 1, blockNumber: 100, logs: [{ address: config.usdtContractAddress, topics: [transferTopic, `0x${'00'.repeat(12)}${'44'.repeat(20)}`, `0x${'00'.repeat(12)}${'55'.repeat(20)}`], data: `0x${5_000_000n.toString(16).padStart(64, '0')}`, index: 0 }] };
    const wrongDestination = await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', { buyerId: buyer.id, txHash: txHashWrong }, credentials);
    expect(wrongDestination.body.reason).toBe('no_transfer_to_buyer');
    const txHash3 = `0x${'33'.repeat(32)}`;
    const deposit3 = { buyerId: buyer.id, txHash: txHash3 };
    receipt = { status: 1, blockNumber: 100, logs: [{ address: config.usdtContractAddress, topics: [transferTopic, `0x${'00'.repeat(12)}${'44'.repeat(20)}`, `0x${'00'.repeat(12)}${buyer.user.depositAddresses[0]!.address.slice(2)}`], data: `0x${5_000_000n.toString(16).padStart(64, '0')}`, index: 0 }] };
    const credited = await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', deposit3, credentials);
    expect(credited.status).toBe(200);
    expect(credited.body.amountCoupons).toBe('500');
    expect(credited.body.balanceCoupons).toBe('500');
    expect((await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', deposit3, credentials)).body.balanceCoupons).toBe('500');
    expect((await signedRequest(app, 'GET', `/api/v1/webhooks/usdt-deposit/${txHash3}`, undefined, credentials)).body.status).toBe('CREDITED');
    const collisionHash = `0x${'44'.repeat(32)}`;
    const collisionExternalRef = `deposit:${collisionHash}:0`;
    await postDeposit(prisma, { externalRef: collisionExternalRef, userId: buyer.userId, userCouponAccountId: (await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: buyer.userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } })).id, externalOnchainAccountId: (await systems()).external.id, vaultAccountId: (await systems()).vault.id, issuanceAccountId: (await systems()).issuance.id, amountMicroUsdt: 1_000_000n, txHash: collisionHash });
    receipt = { status: 1, blockNumber: 100, logs: [{ address: config.usdtContractAddress, topics: [transferTopic, `0x${'00'.repeat(12)}${'44'.repeat(20)}`, `0x${'00'.repeat(12)}${buyer.user.depositAddresses[0]!.address.slice(2)}`], data: `0x${1_000_000n.toString(16).padStart(64, '0')}`, index: 0 }] };
    const collision = await signedRequest(app, 'POST', '/api/v1/webhooks/usdt-deposit', { buyerId: buyer.id, txHash: collisionHash }, credentials);
    expect(collision.body).toMatchObject({ status: 'credited', amountCoupons: '100' });
    const admin = await prisma.adminUser.create({ data: { username: 'alias-admin', passwordHash: 'hash', role: AdminRole.ADMIN } });
    const read = await createApiKey(prisma, { name: 'Average', scopes: [ApiKeyScope.READ_MARKET_AVERAGE], createdById: admin.id });
    const alias = await request(app).get('/v1/partner/market-average').set('Authorization', `Bearer ${read.rawKey}`);
    expect(alias.status).toBe(200);
  });

  it('runs checkout OTP, commission, replay, cancellation, expiry, and ownership rules', async () => {
    const app = appFixture();
    const partner = await provisionUser(prisma, { depositXpub: config.depositXpub }, { barcodeId: 'partner-checkout-member', isDemo: false });
    const seller = await provisionUser(prisma, { depositXpub: config.depositXpub }, { barcodeId: 'checkout-seller', isDemo: false });
    await prisma.user.update({ where: { id: seller.id }, data: { commissionRateBps: 300 } });
    const credentials = await createPartnerKey(app, partner.barcodeId);
    const buyerResult = await signedRequest(app, 'POST', '/api/v1/buyers', { externalRef: 'checkout-buyer' }, credentials);
    const buyer = await prisma.partnerBuyer.findUniqueOrThrow({ where: { id: buyerResult.body.buyerId } });
    const systemsRows = await systems();
    const buyerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: buyer.userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await postDeposit(prisma, { externalRef: 'fixture:checkout', userId: buyer.userId, userCouponAccountId: buyerAccount.id, externalOnchainAccountId: systemsRows.external.id, vaultAccountId: systemsRows.vault.id, issuanceAccountId: systemsRows.issuance.id, amountMicroUsdt: 100_000_000n });
    const checkoutBody = { buyerId: buyer.id, sellerBarcodeId: seller.barcodeId, amountCoupons: '500', externalRef: 'checkout-1' };
    const initiated = await signedRequest(app, 'POST', '/api/v1/checkout/initiate', checkoutBody, credentials);
    expect(initiated.status).toBe(201);
    expect(initiated.body.otp).toMatch(/^\d{4}$/);
    expect((await signedRequest(app, 'POST', '/api/v1/checkout/initiate', checkoutBody, credentials)).body).toMatchObject({ replayed: true, otp: null });
    expect((await signedRequest(app, 'POST', '/api/v1/checkout/initiate', { ...checkoutBody, amountCoupons: '12.5', externalRef: 'decimal' }, credentials)).status).toBe(400);
    expect((await signedRequest(app, 'POST', '/api/v1/checkout/capture', { checkoutId: initiated.body.checkoutId, otp: '0000' }, credentials)).body).toMatchObject({ error: 'invalid_otp', attemptsRemaining: 4 });
    for (let i = 0; i < 4; i += 1) await signedRequest(app, 'POST', '/api/v1/checkout/capture', { checkoutId: initiated.body.checkoutId, otp: '0000' }, credentials);
    expect((await signedRequest(app, 'POST', '/api/v1/checkout/capture', { checkoutId: initiated.body.checkoutId, otp: '0000' }, credentials)).status).toBe(423);
    const fresh = await signedRequest(app, 'POST', '/api/v1/checkout/initiate', { ...checkoutBody, externalRef: 'checkout-2' }, credentials);
    const released = await signedRequest(app, 'POST', '/api/v1/checkout/capture', { checkoutId: fresh.body.checkoutId, otp: fresh.body.otp }, credentials);
    expect(released.body.status).toBe('RELEASED');
    expect((await signedRequest(app, 'POST', '/api/v1/checkout/capture', { checkoutId: fresh.body.checkoutId, otp: fresh.body.otp }, credentials)).body.status).toBe('RELEASED');
    expect((await signedRequest(app, 'GET', `/api/v1/checkout/${fresh.body.checkoutId}`, undefined, credentials)).status).toBe(200);
    const sellerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: seller.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: sellerAccount.id } })).balance).toBe(485n);
    const partnerAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: partner.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: partnerAccount.id } })).balance).toBe(5n);
    const cancelled = await signedRequest(app, 'POST', '/api/v1/checkout/initiate', { ...checkoutBody, externalRef: 'checkout-cancel' }, credentials);
    expect((await signedRequest(app, 'POST', '/api/v1/checkout/cancel', { checkoutId: cancelled.body.checkoutId }, credentials)).body.status).toBe('CANCELLED');
    const tooMuch = await signedRequest(app, 'POST', '/api/v1/checkout/initiate', { ...checkoutBody, amountCoupons: '999999', externalRef: 'too-much' }, credentials);
    expect(tooMuch.status).toBe(400);
    const demo = await provisionUser(prisma, { depositXpub: config.depositXpub }, { barcodeId: 'checkout-demo', isDemo: true });
    const demoSeller = await signedRequest(app, 'POST', '/api/v1/checkout/initiate', { ...checkoutBody, sellerBarcodeId: demo.barcodeId, externalRef: 'demo-seller' }, credentials);
    expect(demoSeller.status).toBe(404);
    const expired = await signedRequest(app, 'POST', '/api/v1/checkout/initiate', { ...checkoutBody, externalRef: 'checkout-expired', expiresInSeconds: 60 }, credentials);
    await prisma.escrowHold.update({ where: { id: (await prisma.partnerCheckout.findUniqueOrThrow({ where: { id: expired.body.checkoutId } })).escrowHoldId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expiredCapture = await signedRequest(app, 'POST', '/api/v1/checkout/capture', { checkoutId: expired.body.checkoutId, otp: expired.body.otp }, credentials);
    expect(expiredCapture.status).toBe(410);
    const otherPartner = await provisionUser(prisma, { depositXpub: config.depositXpub }, { barcodeId: 'partner-other-member', isDemo: false });
    const otherCredentials = await createPartnerKey(app, otherPartner.barcodeId);
    expect((await signedRequest(app, 'GET', `/api/v1/buyers/${buyer.id}`, undefined, otherCredentials)).status).toBe(404);
  });
});
