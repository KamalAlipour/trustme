import { describe, expect, it, vi } from 'vitest';
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

  it.each([
    [401, 1],
    [403, 1],
    [429, 1],
    [500, 2],
  ])('maps HTTP %s to inconclusive without retrying terminal statuses', async (status, expectedCalls) => {
    let calls = 0;
    const result = await checkShahkarMatch(input, {
      ...dependencies,
      fetchImpl: async () => {
        calls += 1;
        return response({ data: false, success: false, code: status }, status);
      },
    });
    expect(result).toEqual({ status: 'INCONCLUSIVE', providerCode: status });
    expect(calls).toBe(expectedCalls);
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

  it('warns with only safe provider failure metadata', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await checkShahkarMatch(input, {
        ...dependencies,
        token: 'secret-token',
        fetchImpl: async () => response({ data: false, success: false, code: 401 }, 401),
      });
      expect(warn).toHaveBeenCalledWith('Shahkar identity check inconclusive', {
        status: 401,
        error: 'HttpError',
        providerCode: 401,
      });
      expect(warn.mock.calls.flat()).not.toContain('secret-token');
      expect(warn.mock.calls.flat()).not.toContain(input.nationalCode);
      expect(warn.mock.calls.flat()).not.toContain(input.mobile);
    } finally {
      warn.mockRestore();
    }
  });
});
