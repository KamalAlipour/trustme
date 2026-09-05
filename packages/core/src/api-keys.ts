import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiKeyScope, Prisma, PrismaClient } from '@trustme/db';

export const SCOPE_NAMES: Record<ApiKeyScope, string> = {
  [ApiKeyScope.READ_MARKET_AVERAGE]: 'read:market_average',
  [ApiKeyScope.READ_RESERVES]: 'read:reserves',
  [ApiKeyScope.WRITE_EXECUTE_TRANSFER_ON_BEHALF_OF_USER]: 'write:execute_transfer_on_behalf_of_user',
  [ApiKeyScope.PARTNER_BUYERS]: 'partner:buyers',
  [ApiKeyScope.PARTNER_DEPOSITS]: 'partner:deposits',
  [ApiKeyScope.PARTNER_CHECKOUT]: 'partner:checkout',
};

const scopeNames = new Map(Object.entries(SCOPE_NAMES).map(([scope, name]) => [name, scope as ApiKeyScope]));

export function scopeFromName(name: string): ApiKeyScope | null {
  return scopeNames.get(name) ?? null;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function encryptionKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

export function decryptApiSecret(ciphertext: string, key: string): string {
  const [ivEncoded, tagEncoded, dataEncoded] = ciphertext.split(':');
  if (!ivEncoded || !tagEncoded || !dataEncoded) throw new Error('invalid secret ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(ivEncoded, 'base64'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataEncoded, 'base64')), decipher.final()]).toString('utf8');
}

function encryptApiSecret(secret: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export async function createApiKey(
  prisma: DatabaseClient,
  input: { name: string; scopes: readonly ApiKeyScope[]; expiresAt?: Date; createdById: string; partnerUserId?: string; secretEncryptionKey?: string },
) {
  const rawKey = `tck_${randomBytes(30).toString('base64url')}`;
  const rawSecret = input.partnerUserId === undefined ? undefined : `tcs_${randomBytes(32).toString('base64url')}`;
  if (rawSecret !== undefined && input.secretEncryptionKey === undefined) throw new Error('partner secret encryption key is required');
  const apiKey = await prisma.apiKey.create({
    data: {
      name: input.name,
      keyPrefix: rawKey.slice(0, 12),
      keyHash: hashKey(rawKey),
      scopes: [...input.scopes],
      createdById: input.createdById,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(rawSecret === undefined ? {} : { secretCiphertext: encryptApiSecret(rawSecret, input.secretEncryptionKey!), partnerUserId: input.partnerUserId }),
    },
  });
  return { apiKey, rawKey, rawSecret };
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
