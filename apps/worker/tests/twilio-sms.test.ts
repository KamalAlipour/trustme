import { describe, expect, it, vi } from 'vitest';
import { sendTwilioSms } from '../src/twilio-sms.js';

const config = {
  twilioAccountSid: 'AC123',
  twilioAuthToken: 'auth-token',
  twilioFrom: '+15005550006',
};

describe('Twilio SMS', () => {
  it('sends a form-encoded message with basic authentication', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 }));
    await expect(sendTwilioSms(config, { to: '+4740174601', body: 'Trust Coupon: your six-digit verification code is 123456. It expires in 5 minutes.' }, fetchImpl))
      .resolves.toEqual({ kind: 'sent', messageId: 'SM123' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
      expect.objectContaining({
        headers: {
          Authorization: `Basic ${Buffer.from('AC123:auth-token').toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'To=%2B4740174601&From=%2B15005550006&Body=Trust+Coupon%3A+your+six-digit+verification+code+is+123456.+It+expires+in+5+minutes.',
      }),
    );
  });

  it.each([400, 401, 403, 404, 422])('classifies %s as terminal', async (status) => {
    await expect(sendTwilioSms(config, { to: '+4740174601', body: 'code' }, vi.fn().mockResolvedValue(new Response('', { status })))).resolves.toEqual({ kind: 'terminal', status });
  });

  it('classifies throttling, server, and network errors as retryable', async () => {
    await expect(sendTwilioSms(config, { to: '+4740174601', body: 'code' }, vi.fn().mockResolvedValue(new Response('', { status: 429 })))).resolves.toEqual({ kind: 'retryable', status: 429 });
    await expect(sendTwilioSms(config, { to: '+4740174601', body: 'code' }, vi.fn().mockResolvedValue(new Response('', { status: 502 })))).resolves.toEqual({ kind: 'retryable', status: 502 });
    await expect(sendTwilioSms(config, { to: '+4740174601', body: 'code' }, vi.fn().mockRejectedValue(new Error('network')))).resolves.toEqual({ kind: 'retryable', status: null });
  });

  it('classifies timeouts as retryable', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
          }),
      );
      const result = sendTwilioSms(config, { to: '+4740174601', body: 'code' }, fetchImpl);
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(result).resolves.toEqual({ kind: 'retryable', status: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
