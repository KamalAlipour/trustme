import { describe, expect, it } from 'vitest';
import { onramperWidgetUrl } from './onramper';

describe('Onramper widget URL', () => {
  it('builds an encoded buy URL with an optional amount', () => {
    const url = onramperWidgetUrl({
      apiKey: 'pk test/key',
      depositAddress: '0xabc+/=',
      amountUsdt: '12.50',
      language: 'fa',
      userId: 'user/id',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://buy.onramper.com');
    expect(parsed.searchParams.get('apiKey')).toBe('pk test/key');
    expect(parsed.searchParams.get('mode')).toBe('buy');
    expect(parsed.searchParams.get('onlyCryptos')).toBe('usdt_polygon');
    expect(parsed.searchParams.get('defaultCrypto')).toBe('usdt_polygon');
    expect(parsed.searchParams.get('wallets')).toBe('usdt_polygon:0xabc+/=');
    expect(parsed.searchParams.get('isAddressEditable')).toBe('false');
    expect(parsed.searchParams.get('defaultFiat')).toBe('eur');
    expect(parsed.searchParams.get('defaultAmount')).toBe('12.50');
    expect(parsed.searchParams.get('partnerContext')).toBe('user/id');
    expect(parsed.searchParams.get('language')).toBe('fa');
    expect(url).toContain('apiKey=pk+test%2Fkey');
    expect(url).toContain('wallets=usdt_polygon%3A0xabc%2B%2F%3D');
  });

  it('omits defaultAmount when no amount is provided', () => {
    const url = onramperWidgetUrl({
      apiKey: 'pk_test',
      depositAddress: '0x123',
      language: 'en',
      userId: 'user-1',
    });
    expect(new URL(url).searchParams.has('defaultAmount')).toBe(false);
  });
});
