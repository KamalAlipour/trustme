import { z } from 'zod';

export type IdentityCheckOutcome = {
  status: 'MATCH' | 'MISMATCH' | 'INCONCLUSIVE';
  providerCode: number | null;
};

export type ShahkarCheckInput = {
  nationalCode: string;
  mobile: string;
};

export type ShahkarCheckDependencies = {
  token: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
};

const responseSchema = z.object({
  data: z.boolean(),
  success: z.boolean(),
  code: z.number().int().nullable().optional(),
  message: z.string().optional(),
});

function inconclusive(providerCode: number | null = null): IdentityCheckOutcome {
  return { status: 'INCONCLUSIVE', providerCode };
}

async function checkOnce(input: ShahkarCheckInput, dependencies: ShahkarCheckDependencies): Promise<IdentityCheckOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 15_000);
  try {
    const response = await (dependencies.fetchImpl ?? fetch)(dependencies.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${dependencies.token}`,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return inconclusive();
    }
    const body = responseSchema.safeParse(parsed);
    if (!body.success) return inconclusive();
    const providerCode = body.data.code ?? null;
    if (!response.ok || body.data.success !== true) return inconclusive(providerCode);
    if (body.data.data === true) return { status: 'MATCH', providerCode };
    if ((body.data.message ?? '').trim().length > 0) return { status: 'MISMATCH', providerCode };
    return inconclusive(providerCode);
  } catch {
    return inconclusive();
  } finally {
    clearTimeout(timeout);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function checkShahkarMatch(
  input: ShahkarCheckInput,
  dependencies: ShahkarCheckDependencies,
): Promise<IdentityCheckOutcome> {
  const first = await checkOnce(input, dependencies);
  if (first.status !== 'INCONCLUSIVE') return first;
  await delay(dependencies.retryDelayMs ?? 2_000);
  return checkOnce(input, dependencies);
}
