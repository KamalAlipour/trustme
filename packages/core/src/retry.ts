import { randomInt } from 'node:crypto';
import { Prisma, PrismaClient } from '@trustme/db';

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
const maxAttempts = 8;

function isRetryable(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2034' || /40001|serialize|deadlock/i.test(error.message))) ||
    (error instanceof Prisma.PrismaClientUnknownRequestError && /40001|serialize|deadlock/i.test(error.message))
  );
}

export async function withSerializableRetry<T>(
  prisma: PrismaClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, serializable);
    } catch (error) {
      if (!isRetryable(error) || attempt === maxAttempts - 1) throw error;
      const backoffMs = Math.min(500, 10 * 2 ** attempt) + randomInt(0, 51);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw new Error('serializable transaction failed after retries');
}
