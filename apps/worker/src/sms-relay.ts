import type { WorkerConfig } from './config.js';

export type SmsRelayResult =
  | { kind: 'sent'; messageId: string | null }
  | { kind: 'terminal'; status: number }
  | { kind: 'retryable'; status: number | null };

export async function sendOtp(
  config: Pick<WorkerConfig, 'smsRelayUrl' | 'smsRelayKey' | 'smsRelayOtpPattern'>,
  input: { recipient: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsRelayResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetchImpl(`${config.smsRelayUrl.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: { Authorization: config.smsRelayKey ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: input.recipient, pattern: config.smsRelayOtpPattern, params: { code: input.code } }),
      signal: controller.signal,
    });
    if ([401, 403, 422, 429].includes(response.status)) return { kind: 'terminal', status: response.status };
    if (response.status !== 200) return { kind: 'retryable', status: response.status };
    let body: unknown;
    try { body = await response.json(); } catch { return { kind: 'retryable', status: 200 }; }
    if (!body || typeof body !== 'object' || (body as { status?: unknown }).status !== 'sent') return { kind: 'retryable', status: 200 };
    const ids = (body as { message_outbox_ids?: unknown }).message_outbox_ids;
    const messageId = Array.isArray(ids) && ids.length > 0 && (typeof ids[0] === 'string' || typeof ids[0] === 'number') ? String(ids[0]) : null;
    return { kind: 'sent', messageId };
  } catch {
    return { kind: 'retryable', status: null };
  } finally {
    clearTimeout(timeout);
  }
}
