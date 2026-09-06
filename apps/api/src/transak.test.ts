import { describe, expect, it, vi } from 'vitest';
import { createTransakClient, TransakApiError } from './transak.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const options = {
  apiKey: 'transak-test-key',
  apiSecret: 'transak-test-secret',
  environment: 'staging' as const,
  referrerDomain: 'app-trustcoupon.komasi.as',
};

describe('Transak client', () => {
  it('refreshes a token and creates a session with wallet-pinned parameters', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-1', expiresAt: 2_000_000_000 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=one' } }));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => 1_700_000_000_000 });

    const result = await client.createWidgetSession({ product: 'BUY', walletAddress: '0xabc', userId: 'member-1', amountUsdt: '12.50' });

    expect(result).toEqual({ url: 'https://global-stg.transak.com/?sessionId=one', expiresAt: '2023-11-14T22:18:20.000Z' });
    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://api-stg.transak.com/partners/api/v2/refresh-token', expect.objectContaining({
      headers: expect.objectContaining({ 'api-secret': options.apiSecret, 'x-api-key': options.apiKey }),
      body: JSON.stringify({ apiKey: options.apiKey }),
    }));
    const sessionRequest = fetcher.mock.calls[1]![1] as RequestInit;
    expect(fetcher.mock.calls[1]![0]).toBe('https://api-gateway-stg.transak.com/api/v2/auth/session');
    expect(sessionRequest.headers).toEqual(expect.objectContaining({ 'access-token': 'token-1' }));
    expect(JSON.parse(sessionRequest.body as string)).toEqual({
      widgetParams: {
        apiKey: options.apiKey,
        referrerDomain: options.referrerDomain,
        productsAvailed: 'BUY',
        cryptoCurrencyCode: 'USDT',
        network: 'polygon',
        walletAddress: '0xabc',
        disableWalletAddressForm: true,
        defaultFiatCurrency: 'EUR',
        partnerCustomerId: 'member-1',
        defaultCryptoAmount: 12.5,
      },
    });
  });

  it('reuses a cached token on a second session', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-1', expiresAt: 2_000_000_000 } }))
      .mockImplementation(async () => jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=reused' } }));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => 1_700_000_000_000 });

    await client.createWidgetSession({ product: 'BUY', walletAddress: '0xabc', userId: 'member-1' });
    await client.createWidgetSession({ product: 'BUY', walletAddress: '0xdef', userId: 'member-2' });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([url]) => url === 'https://api-stg.transak.com/partners/api/v2/refresh-token')).toHaveLength(1);
  });

  it('refreshes a token when it is within 60 seconds of expiry', async () => {
    let now = 1_700_000_000_000;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-1', expiresAt: 1_700_000_061 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=one' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-2', expiresAt: 1_700_001_000 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=two' } }));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => now });

    await client.createWidgetSession({ product: 'BUY', walletAddress: '0xabc', userId: 'member-1' });
    now += 1_000;
    await client.createWidgetSession({ product: 'BUY', walletAddress: '0xdef', userId: 'member-2' });

    expect(fetcher.mock.calls[2]![0]).toBe('https://api-stg.transak.com/partners/api/v2/refresh-token');
  });

  it('refreshes once and retries a session after a 401', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-1', expiresAt: 2_000_000_000 } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-2', expiresAt: 2_000_000_000 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=retry' } }));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => 1_700_000_000_000 });

    await client.createWidgetSession({ product: 'BUY', walletAddress: '0xabc', userId: 'member-1' });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect((fetcher.mock.calls[3]![1] as RequestInit).headers).toEqual(expect.objectContaining({ 'access-token': 'token-2' }));
  });

  it('throws a typed error for a non-success response', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => 1_700_000_000_000 });

    const error = await client.createWidgetSession({ product: 'BUY', walletAddress: '0xabc', userId: 'member-1' }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TransakApiError);
    expect(error).toMatchObject({ name: 'TransakApiError', endpoint: 'refresh-token', status: 503 });
  });

  it('creates a SELL session without BUY wallet fields and supports redirect details', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-sell', expiresAt: 2_000_000_000 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=sell' } }));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => 1_700_000_000_000 });

    await client.createWidgetSession({
      product: 'SELL',
      userId: 'member-sell',
      amountUsdt: '25.50',
      redirectUrl: 'https://app-trustcoupon.komasi.as/tether',
    });

    const sessionRequest = fetcher.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(sessionRequest.body as string)).toEqual({
      widgetParams: {
        apiKey: options.apiKey,
        referrerDomain: options.referrerDomain,
        productsAvailed: 'SELL',
        cryptoCurrencyCode: 'USDT',
        network: 'polygon',
        defaultFiatCurrency: 'EUR',
        partnerCustomerId: 'member-sell',
        defaultCryptoAmount: 25.5,
        walletRedirection: true,
        redirectURL: 'https://app-trustcoupon.komasi.as/tether',
      },
    });
    expect(JSON.parse(sessionRequest.body as string).widgetParams).not.toHaveProperty('walletAddress');
    expect(JSON.parse(sessionRequest.body as string).widgetParams).not.toHaveProperty('disableWalletAddressForm');
  });

  it('creates a SELL session without redirect parameters when no redirect URL is given', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { accessToken: 'token-sell', expiresAt: 2_000_000_000 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=sell-no-redirect' } }));
    const client = createTransakClient({ ...options, fetch: fetcher, now: () => 1_700_000_000_000 });

    await client.createWidgetSession({ product: 'SELL', userId: 'member-sell' });

    const widgetParams = JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string).widgetParams;
    expect(widgetParams).toEqual({
      apiKey: options.apiKey,
      referrerDomain: options.referrerDomain,
      productsAvailed: 'SELL',
      cryptoCurrencyCode: 'USDT',
      network: 'polygon',
      defaultFiatCurrency: 'EUR',
      partnerCustomerId: 'member-sell',
    });
    expect(widgetParams).not.toHaveProperty('walletAddress');
  });
});
