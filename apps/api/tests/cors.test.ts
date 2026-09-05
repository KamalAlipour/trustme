import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, type ApiDependencies } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const config = {
  apiServiceToken: 'service-token',
  adminJwtSecret: 'a'.repeat(32),
  adminJwtTtlSeconds: 3600,
  memberJwtSecret: 'b'.repeat(32),
  memberJwtTtlSeconds: 900,
  memberRefreshTtlDays: 60,
  emailDelivery: 'none' as const,
  requireEmailVerification: true,
  pinResetQuarantineHours: 72,
  nodeEnv: 'test',
  polygonRpcUrl: 'http://127.0.0.1:8545',
  usdtContractAddress: '0x52908400098527886E0F7030069857D2E4169EE7',
  hotWalletAddress: '0x52908400098527886E0F7030069857D2E4169EE7',
  bindHost: '127.0.0.1',
  port: 3000,
  bodyLimit: '32kb',
  rateLimitWindowMs: 60_000,
  rateLimitMax: 60,
  failoverMarkerPath: '/tmp/trustme-marker',
  mediaStorageDir: '/tmp/trustme-media',
  allowedOrigins: ['https://app-trustcoupon.komasi.as'],
  partnerSecretKey: undefined,
  confirmations: 12,
} as ApiConfig;

const app = createApp({
  config,
  prisma: {} as ApiDependencies['prisma'],
  queue: { add: async () => ({}) } as ApiDependencies['queue'],
  smsQueue: { add: async () => ({}) } as ApiDependencies['smsQueue'],
  redis: { ping: async () => 'PONG' },
});

describe('API CORS', () => {
  it('allows configured browser origins for preflight requests', async () => {
    const response = await request(app)
      .options('/v1/auth/login')
      .set('Origin', 'https://app-trustcoupon.komasi.as')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app-trustcoupon.komasi.as');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('does not allow unconfigured origins', async () => {
    const response = await request(app)
      .options('/v1/auth/login')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
