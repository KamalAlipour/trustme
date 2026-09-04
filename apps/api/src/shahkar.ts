import { z } from 'zod';

export type IdentityCheckOutcome = {
  status: 'MATCH' | 'MISMATCH' | 'INCONCLUSIVE';
  providerCode: number | null;
};

export type ShahkarCheckInput = {
  nationalCode: string;
  mobile: string;
};

export type IbanMatchInput = {
  iban: string;
  nationalCode: string;
  birthDate: string;
};

export type ShahkarCheckDependencies = {
  token: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
};

const responseSchema = z.object({
  data: z.boolean().optional(),
  success: z.boolean(),
  code: z.number().int().nullable().optional(),
  message: z.string().optional(),
});

type CheckOnceResult = {
  outcome: IdentityCheckOutcome;
  retryable: boolean;
};

function inconclusive(providerCode: number | null = null, retryable = true): CheckOnceResult {
  return { outcome: { status: 'INCONCLUSIVE', providerCode }, retryable };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function warnInconclusive(status: number | null, error: string, providerCode: number | null): void {
  console.warn('Shahkar identity check inconclusive', { status, error, providerCode });
}

async function checkOnce(body: Record<string, string>, dependencies: ShahkarCheckDependencies): Promise<CheckOnceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 15_000);
  try {
    const response = await (dependencies.fetchImpl ?? fetch)(dependencies.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${dependencies.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      if (!response.ok) warnInconclusive(response.status, errorName(error), null);
      return inconclusive(null, response.ok || ![401, 403, 429].includes(response.status));
    }
    const parsedResponse = responseSchema.safeParse(parsed);
    if (!parsedResponse.success) {
      if (!response.ok) warnInconclusive(response.status, 'InvalidResponse', null);
      return inconclusive(null, response.ok || ![401, 403, 429].includes(response.status));
    }
    const providerCode = parsedResponse.data.code ?? null;
    if (!response.ok) {
      warnInconclusive(response.status, 'HttpError', providerCode);
      return inconclusive(providerCode, ![401, 403, 429].includes(response.status));
    }
    if (parsedResponse.data.success !== true) return inconclusive(providerCode);
    if (parsedResponse.data.data === true) return { outcome: { status: 'MATCH', providerCode }, retryable: false };
    if ((parsedResponse.data.message ?? '').trim().length > 0) return { outcome: { status: 'MISMATCH', providerCode }, retryable: false };
    return inconclusive(providerCode);
  } catch (error) {
    warnInconclusive(null, errorName(error), null);
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
  if (first.outcome.status !== 'INCONCLUSIVE' || !first.retryable) return first.outcome;
  await delay(dependencies.retryDelayMs ?? 2_000);
  return (await checkOnce(input, dependencies)).outcome;
}

export async function checkIbanMatch(
  input: IbanMatchInput,
  dependencies: ShahkarCheckDependencies,
): Promise<IdentityCheckOutcome> {
  const first = await checkOnce(input, dependencies);
  if (first.outcome.status !== 'INCONCLUSIVE' || !first.retryable) return first.outcome;
  await delay(dependencies.retryDelayMs ?? 2_000);
  return (await checkOnce(input, dependencies)).outcome;
}
