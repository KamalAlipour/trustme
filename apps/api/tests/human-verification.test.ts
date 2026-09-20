import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { AccountType, Asset, IdentityProvider, PrismaClient, TransactionType } from '@trustme/db';
import { HDNodeWallet, getAddress } from 'ethers';
import { createApp, type ApiDependencies } from '../src/app.js';
import { provisionUser } from '../src/user-provisioning.js';
import { turnstileVerifier } from '../src/human-verification.js';

const prisma = new PrismaClient();
const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: 'redis://localhost:56379',
  apiServiceToken: 'test-service-token',
  depositXpub: HDNodeWallet.createRandom().neuter().extendedKey,
  adminJwtSecret: 'test-admin-jwt-secret-32-characters-long!',
  adminJwtTtlSeconds: 3600,
  memberJwtSecret: 'test-member-jwt-secret-32-characters-long!',
  memberJwtTtlSeconds: 900,
  memberRefreshTtlDays: 60,
  emailDelivery: 'none' as const,
  smsDelivery: 'none' as const,
  smsRelayUrl: 'https://id.hktp.ir',
  smsRelayKey: undefined,
  smsRelayOtpPattern: '61qgtphdqgtixtg',
  twilioAccountSid: undefined,
  twilioAuthToken: undefined,
  twilioFrom: undefined,
  twilioConfigured: false,
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
  escrowUsdtPermitName: 'USDT0',
  escrowUsdtPermitVersion: '1',
  escrowNativeCurrencySymbol: 'POL',
  escrowChainName: 'Polygon Mainnet',
  escrowContractAddress: undefined,
  walletConnectProjectId: undefined,
  web3AuthClientId: undefined,
  transakApiKey: undefined,
  transakApiSecret: undefined,
  transakEnvironment: 'staging' as const,
  transakReferrerDomain: 'app-trustcoupon.komasi.as',
  transakSellRedirectUrl: 'https://app-trustcoupon.komasi.as/tether',
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
  turnstileSecretKey: undefined,
  turnstileSiteKey: undefined,
  shahkarApiToken: undefined,
  shahkarBaseUrl: 'https://provider.test',
  ibanMatchBaseUrl: 'https://iban-provider.test',
  identityHashPepper: undefined,
  vippsClientId: undefined,
  vippsClientSecret: undefined,
  vippsSubscriptionKey: undefined,
  vippsMsn: undefined,
  vippsApiBase: 'https://api.vipps.no',
  vippsScope: 'openid name phoneNumber email',
  vippsRedirectUri: 'https://api-trustme.komasi.as/v1/me/identity/vipps/callback',
  vippsReturnUrl: 'https://app-trustcoupon.komasi.as/profile',
  partnerSecretKey: 'test-partner-secret-key-that-is-at-least-32-characters',
  confirmations: 12,
};

const dependencies = {
  queue: { add: vi.fn(async () => ({})) } as unknown as ApiDependencies['queue'],
  smsQueue: { add: vi.fn(async () => ({})) } as unknown as ApiDependencies['smsQueue'],
  redis: { ping: vi.fn(async () => 'PONG') } as unknown as ApiDependencies['redis'],
};

function fixture(overrides: Partial<ApiDependencies> = {}) {
  return createApp({ config, prisma, ...dependencies, ...overrides });
}

async function user(phone: string, isDemo = false) {
  return provisionUser(prisma, { depositXpub: config.depositXpub }, {
    phoneNumber: phone,
    pinHash: await bcrypt.hash('2468', 4),
    pinUpdatedAt: new Date(),
    isDemo,
  });
}

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "HumanVerificationEvent", "ApiKey", "EscrowPermitDeposit", "EscrowChainEvent", "EscrowUnload", "EscrowSettlement", "PayCode", "EscrowBalance", "MemberWallet", "BalanceDisclosureRequest", "MediaAsset", "IdentityReview", "IdentityCaptureSession", "IdentityLoginAttempt", "IdentityCheck", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAllowedEmail", "AdminAuditLog", "Withdrawal", "EscrowHold", "EmailVerification", "PhoneVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositSweep", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
});
afterAll(async () => prisma.$disconnect());

describe('human verification gate', () => {
  it('keeps registration disabled when no verifier is configured', async () => {
    const response = await request(fixture()).post('/v1/auth/register').send({ phone: '+15550001001', pin: '2468' });
    expect(response.status).toBe(201);
  });

  it('rejects registration before creating a user when verification fails', async () => {
    const app = fixture({ verifyHumanToken: async () => false });
    for (const body of [{ phone: '+15550001002', pin: '2468' }, { phone: '+15550001003', pin: '2468', humanToken: 'bad' }]) {
      const response = await request(app).post('/v1/auth/register').send(body);
      expect(response.status).toBe(403);
    }
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.humanVerificationEvent.count({ where: { outcome: 'failed' } })).toBe(2);
  });

  it('registers after a successful verification and exposes discovery settings', async () => {
    const app = createApp({ config: { ...config, turnstileSecretKey: 'secret', turnstileSiteKey: 'site' }, prisma, ...dependencies, verifyHumanToken: async () => true });
    const discovery = await request(app).get('/v1/auth/human-verification');
    expect(discovery.body).toEqual({ enabled: true, siteKey: 'site' });
    const response = await request(app).post('/v1/auth/register').send({ phone: '+15550001004', pin: '2468', humanToken: 'ok' });
    expect(response.status).toBe(201);
    expect(await prisma.humanVerificationEvent.findFirstOrThrow({ where: { outcome: 'passed' } })).toMatchObject({ route: '/register' });
  });

  it('deletes only a fresh non-demo account after a correct PIN and failed challenge', async () => {
    const created = await user('+15550001005');
    const response = await request(fixture({ verifyHumanToken: async () => false })).post('/v1/auth/login').send({ phone: created.phoneNumber, pin: '2468', humanToken: 'bad' });
    expect(response.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: created.id } })).toBeNull();
    expect(await prisma.humanVerificationEvent.findFirstOrThrow({ where: { outcome: 'failed_deleted' } })).toMatchObject({ userId: created.id });
  });

  it.each([
    ['demo', async () => user('+15550001006', true)],
    ['wallet', async () => { const value = await user('+15550001007'); await prisma.memberWallet.create({ data: { userId: value.id, address: getAddress(`0x${'12'.repeat(20)}`), kind: 'EXTERNAL', chainId: 137 } }); return value; }],
    ['verified', async () => { const value = await user('+15550001008'); await prisma.user.update({ where: { id: value.id }, data: { identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } }); return value; }],
    ['escrow', async () => { const value = await user('+15550001009'); await prisma.escrowBalance.create({ data: { userId: value.id, lockedMicroUsdt: 1n } }); return value; }],
  ])('keeps a %s account after a failed challenge', async (_name, create) => {
    const created = await create();
    const response = await request(fixture({ verifyHumanToken: async () => false })).post('/v1/auth/login').send({ phone: created.phoneNumber, pin: '2468', humanToken: 'bad' });
    expect(response.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: created.id } })).not.toBeNull();
    expect(await prisma.humanVerificationEvent.findFirstOrThrow({ where: { outcome: 'failed_kept' } })).toMatchObject({ userId: created.id });
  });

  it('does not delete on a wrong PIN', async () => {
    const created = await user('+15550001010');
    const response = await request(fixture({ verifyHumanToken: async () => false })).post('/v1/auth/login').send({ phone: created.phoneNumber, pin: '4321', humanToken: 'bad' });
    expect(response.status).toBe(401);
    expect(await prisma.user.findUnique({ where: { id: created.id } })).not.toBeNull();
    expect(await prisma.humanVerificationEvent.count()).toBe(0);
  });

  it('protects an account with a ledger entry', async () => {
    const created = await user('+15550001011');
    const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: created.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    const system = await prisma.ledgerAccount.create({ data: { type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON } });
    const transaction = await prisma.transaction.create({ data: { type: TransactionType.DEPOSIT, externalRef: 'human-verification-ledger' } });
    await prisma.ledgerEntry.create({ data: { transactionId: transaction.id, fromAccountId: system.id, toAccountId: account.id, amount: 1n, asset: Asset.COUPON } });
    const response = await request(fixture({ verifyHumanToken: async () => false })).post('/v1/auth/login').send({ phone: created.phoneNumber, pin: '2468', humanToken: 'bad' });
    expect(response.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: created.id } })).not.toBeNull();
  });

  it('blocks social registration before provisioning and deletes an existing empty identity', async () => {
    const noIdentity = await request(fixture({ verifyGoogleIdToken: async () => ({ subject: 'new-social', email: null, emailVerified: false }), verifyHumanToken: async () => false })).post('/v1/auth/google').send({ idToken: 'verified', humanToken: 'bad' });
    expect(noIdentity.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
    const created = await user('+15550001012');
    await prisma.userIdentity.create({ data: { userId: created.id, provider: IdentityProvider.GOOGLE, subject: 'existing-social' } });
    const existing = await request(fixture({ verifyGoogleIdToken: async () => ({ subject: 'existing-social', email: null, emailVerified: false }), verifyHumanToken: async () => false })).post('/v1/auth/google').send({ idToken: 'verified', humanToken: 'bad' });
    expect(existing.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: created.id } })).toBeNull();
  });
});

describe('Turnstile verifier', () => {
  it('handles success, rejection, and network errors', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }))) as typeof fetch;
      expect(await turnstileVerifier('secret')('token', '127.0.0.1')).toBe(true);
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ success: false }))) as typeof fetch;
      expect(await turnstileVerifier('secret')('token', undefined)).toBe(false);
      globalThis.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
      expect(await turnstileVerifier('secret')('token', undefined)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
