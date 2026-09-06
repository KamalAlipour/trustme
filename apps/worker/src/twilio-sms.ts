import type { WorkerConfig } from './config.js';

export type TwilioSmsResult =
  | { kind: 'sent'; messageId: string | null }
  | { kind: 'terminal'; status: number }
  | { kind: 'retryable'; status: number | null };

export async function sendTwilioSms(
  config: Pick<WorkerConfig, 'twilioAccountSid' | 'twilioAuthToken' | 'twilioFrom'>,
  input: { to: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TwilioSmsResult> {
  if (config.twilioAccountSid === undefined || config.twilioAuthToken === undefined || config.twilioFrom === undefined) {
    return { kind: 'terminal', status: 401 };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: input.to, From: config.twilioFrom, Body: input.body }).toString(),
        signal: controller.signal,
      },
    );
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return { kind: 'terminal', status: response.status };
    }
    if (!response.ok) return { kind: 'retryable', status: response.status };
    let body: unknown;
    try { body = await response.json(); } catch { return { kind: 'retryable', status: response.status }; }
    const messageId = body !== null && typeof body === 'object' && typeof (body as { sid?: unknown }).sid === 'string'
      ? (body as { sid: string }).sid
      : null;
    return { kind: 'sent', messageId };
  } catch {
    return { kind: 'retryable', status: null };
  } finally {
    clearTimeout(timeout);
  }
}
