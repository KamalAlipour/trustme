import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOnramperWidgetUrl } from './onramper.js';

describe('Onramper widget URL signing', () => {
  it('signs sorted core fields and uses the test widget host for test keys', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const now = new Date('2026-01-15T10:30:00.123Z');
    const nonce = '550e8400-e29b-41d4-a716-446655440000';
    const result = signOnramperWidgetUrl({
      baseUrl: 'https://buy.onramper.dev',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      now,
      nonce,
      fields: {
        apiKey: 'pk_test_key',
        mode: 'buy',
        onlyCryptos: 'usdt_polygon',
        defaultCrypto: 'usdt_polygon',
        wallets: 'usdt_polygon:0xabc+/=',
        isAddressEditable: 'false',
        defaultFiat: 'eur',
        partnerContext: 'member/id',
        defaultAmount: '12.50',
      },
    });
    const parsed = new URL(result.url);
    const fields = parsed.searchParams.get('sigV2Fields')?.split(',') ?? [];
    expect(fields).toEqual(['apiKey', 'defaultAmount', 'defaultCrypto', 'defaultFiat', 'isAddressEditable', 'mode', 'onlyCryptos', 'partnerContext', 'wallets']);
    expect(parsed.searchParams.get('sigV2Fields')).toBe('apiKey,defaultAmount,defaultCrypto,defaultFiat,isAddressEditable,mode,onlyCryptos,partnerContext,wallets');
    expect(parsed.searchParams.get('sigV2Timestamp')).toBe(now.toISOString());
    expect(parsed.searchParams.get('sigV2Nonce')).toBe(nonce);
    expect(parsed.searchParams.get('sigV2Expiry')).toBe('2026-01-15T10:45:00.123Z');
    expect(parsed.origin).toBe('https://buy.onramper.dev');
    expect(parsed.searchParams.get('sigV2')).toMatch(/^v2:[A-Za-z0-9+/]+=*$/);

    const signedQuery = new URLSearchParams();
    for (const field of fields) signedQuery.set(field, parsed.searchParams.get(field)!);
    const canonical = [
      'ONRAMPER-SIG-V2',
      now.toISOString(),
      nonce,
      'GET',
      '/',
      signedQuery.toString(),
      '',
      createHash('sha256').update('').digest('hex'),
    ].join('\n');
    expect(verify(null, Buffer.from(canonical), publicKey, Buffer.from(parsed.searchParams.get('sigV2')!.slice(3), 'base64'))).toBe(true);
    expect(result.expiresAt.toISOString()).toBe('2026-01-15T10:45:00.123Z');
  });
});
