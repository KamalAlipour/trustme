import { describe, expect, it } from 'vitest';
import { checkShahkarMatch } from '../src/shahkar.js';

const input = { nationalCode: '3141592659', mobile: '09000000000' };
const dependencies = { token: 'test-token', baseUrl: 'https://provider.test', retryDelayMs: 0 };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Shahkar provider client', () => {
  it.each([
    [{ data: true, success: true, code: 0, message: 'ok' }, { status: 'MATCH', providerCode: 0 }],
    [{ data: false, success: true, code: 12, message: 'not matched' }, { status: 'MISMATCH', providerCode: 12 }],
    [{ data: false, success: true, code: 0, message: '' }, { status: 'INCONCLUSIVE', providerCode: 0 }],
    [{ data: false, success: true, code: 0 }, { status: 'INCONCLUSIVE', providerCode: 0 }],
    [{ data: true, success: false, code: 9, message: 'error' }, { status: 'INCONCLUSIVE', providerCode: 9 }],
  ])('maps a valid provider response', async (body, expected) => {
    const result = await checkShahkarMatch(input, { ...dependencies, fetchImpl: async () => response(body) });
    expect(result).toEqual(expected);
  });

  it.each([401, 403, 429, 500])('maps HTTP %s to inconclusive', async (status) => {
    let calls = 0;
    const result = await checkShahkarMatch(input, {
      ...dependencies,
      fetchImpl: async () => {
        calls += 1;
        return response({ data: false, success: false, code: status }, status);
      },
    });
    expect(result).toEqual({ status: 'INCONCLUSIVE', providerCode: status });
    expect(calls).toBe(2);
  });

  it('retries an inconclusive result exactly once and returns the final result', async () => {
    let calls = 0;
    const result = await checkShahkarMatch(input, {
      ...dependencies,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? response({ data: false, success: true, code: 0, message: '' }) : response({ data: true, success: true, code: 0, message: '' });
      },
    });
    expect(result).toEqual({ status: 'MATCH', providerCode: 0 });
    expect(calls).toBe(2);
  });

  it('maps non-JSON, invalid bodies, and timeout to inconclusive', async () => {
    const invalid = await checkShahkarMatch(input, { ...dependencies, fetchImpl: async () => new Response('not json') });
    expect(invalid.status).toBe('INCONCLUSIVE');
    const invalidSchema = await checkShahkarMatch(input, { ...dependencies, fetchImpl: async () => response({ data: 'yes', success: true }) });
    expect(invalidSchema.status).toBe('INCONCLUSIVE');
    let calls = 0;
    const timedOut = await checkShahkarMatch(input, {
      ...dependencies,
      timeoutMs: 1,
      fetchImpl: async (_url, init) => {
        calls += 1;
        await new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        throw new Error('unreachable');
      },
    });
    expect(timedOut.status).toBe('INCONCLUSIVE');
    expect(calls).toBe(2);
  });
});
