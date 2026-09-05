import { describe, expect, it, vi } from 'vitest';
import { sendOtp } from '../src/sms-relay.js';

const config = { smsRelayUrl: 'https://relay.test', smsRelayKey: 'secret-key', smsRelayOtpPattern: 'fixed-pattern' };

describe('SMS relay', () => {
  it('parses a sent response and message id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'sent', message_outbox_ids: [42] }), { status: 200 }));
    await expect(sendOtp(config, { recipient: '09131234567', code: '123456' }, fetchImpl)).resolves.toEqual({ kind: 'sent', messageId: '42' });
    expect(fetchImpl).toHaveBeenCalledWith('https://relay.test/send', expect.objectContaining({
      headers: { Authorization: 'secret-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: '09131234567', pattern: 'fixed-pattern', params: { code: '123456' } }),
    }));
  });

  it.each([401, 403, 422, 429])('classifies %s as terminal', async (status) => {
    await expect(sendOtp(config, { recipient: '09131234567', code: '123456' }, vi.fn().mockResolvedValue(new Response('', { status })))).resolves.toEqual({ kind: 'terminal', status });
  });

  it('classifies 502 and network errors as retryable', async () => {
    await expect(sendOtp(config, { recipient: '09131234567', code: '123456' }, vi.fn().mockResolvedValue(new Response('', { status: 502 })))).resolves.toEqual({ kind: 'retryable', status: 502 });
    await expect(sendOtp(config, { recipient: '09131234567', code: '123456' }, vi.fn().mockRejectedValue(new Error('network')))).resolves.toEqual({ kind: 'retryable', status: null });
  });
});
