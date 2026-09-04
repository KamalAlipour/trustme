import { createHash, randomBytes } from 'node:crypto';
import { ApiKeyScope, Prisma, PrismaClient } from '@trustme/db';

export const SCOPE_NAMES: Record<ApiKeyScope, string> = {
  [ApiKeyScope.READ_MARKET_AVERAGE]: 'read:market_average',
  [ApiKeyScope.READ_RESERVES]: 'read:reserves',
  [ApiKeyScope.WRITE_EXECUTE_TRANSFER_ON_BEHALF_OF_USER]: 'write:execute_transfer_on_behalf_of_user',
};

const scopeNames = new Map(Object.entries(SCOPE_NAMES).map(([scope, name]) => [name, scope as ApiKeyScope]));

export function scopeFromName(name: string): ApiKeyScope | null {
  return scopeNames.get(name) ?? null;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export async function createApiKey(
  prisma: DatabaseClient,
  input: { name: string; scopes: readonly ApiKeyScope[]; expiresAt?: Date; createdById: string },
) {
  const rawKey = `tck_${randomBytes(30).toString('base64url')}`;
  const apiKey = await prisma.apiKey.create({
    data: {
      name: input.name,
      keyPrefix: rawKey.slice(0, 12),
      keyHash: hashKey(rawKey),
      scopes: [...input.scopes],
      createdById: input.createdById,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
  });
  return { apiKey, rawKey };
}

export async function revokeApiKey(prisma: DatabaseClient, id: string) {
  await prisma.apiKey.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return prisma.apiKey.findUniqueOrThrow({ where: { id } });
}

export async function authenticateApiKey(prisma: DatabaseClient, rawKey: string) {
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(rawKey) } });
  if (apiKey === null || apiKey.revokedAt !== null || (apiKey.expiresAt !== null && apiKey.expiresAt <= new Date())) return null;
  await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
  return apiKey;
}
