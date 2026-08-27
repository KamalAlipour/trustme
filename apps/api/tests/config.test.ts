import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../src/config.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://trustme:trustme@localhost:55432/trustme',
  REDIS_URL: 'redis://localhost:56379',
  API_SERVICE_TOKEN: 'service-token',
  DEPOSIT_XPUB: 'xpub',
  ADMIN_JWT_SECRET: 'a'.repeat(32),
  MEMBER_JWT_SECRET: 'b'.repeat(32),
  POLYGON_RPC_URL: 'http://127.0.0.1:8545',
  USDT_CONTRACT_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7',
  HOT_WALLET_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7',
};

describe('API configuration', () => {
  it('rejects email-code logging in production', () => {
    expect(() => loadApiConfig({ ...validEnvironment, NODE_ENV: 'production', EMAIL_DELIVERY: 'log' })).toThrow('EMAIL_DELIVERY=log is not allowed in production');
  });
});
