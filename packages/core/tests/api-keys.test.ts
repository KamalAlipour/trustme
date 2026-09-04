import { createHash } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminRole, ApiKeyScope, PrismaClient } from '@trustme/db';
import { authenticateApiKey, createApiKey, revokeApiKey, scopeFromName, SCOPE_NAMES } from '../src/api-keys.js';

const prisma = new PrismaClient();

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ApiKey", "AdminUser" CASCADE');
});
afterAll(async () => prisma.$disconnect());

describe('scoped API keys', () => {
  it('round-trips wire scope names', () => {
    for (const scope of Object.values(ApiKeyScope)) expect(scopeFromName(SCOPE_NAMES[scope])).toBe(scope);
    expect(scopeFromName('read:unknown')).toBeNull();
  });

  it('creates keys with a one-time raw value and stores only its hash', async () => {
    const admin = await prisma.adminUser.create({ data: { username: 'keys-admin', passwordHash: 'hash', role: AdminRole.ADMIN } });
    const { apiKey, rawKey } = await createApiKey(prisma, {
      name: 'Child platform',
      scopes: [ApiKeyScope.READ_RESERVES],
      createdById: admin.id,
    });
    expect(rawKey).toMatch(/^tck_[A-Za-z0-9_-]{40}$/);
    expect(apiKey.keyPrefix).toBe(rawKey.slice(0, 12));
    expect(apiKey.keyHash).toBe(createHash('sha256').update(rawKey).digest('hex'));
    expect(JSON.stringify(apiKey)).not.toContain(rawKey);
  });

  it('authenticates valid keys and rejects unknown, tampered, revoked, and expired keys', async () => {
    const admin = await prisma.adminUser.create({ data: { username: 'keys-auth-admin', passwordHash: 'hash', role: AdminRole.ADMIN } });
    const valid = await createApiKey(prisma, { name: 'Valid', scopes: [ApiKeyScope.READ_RESERVES], createdById: admin.id });
    expect(await authenticateApiKey(prisma, valid.rawKey)).not.toBeNull();
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: valid.apiKey.id } })).lastUsedAt).not.toBeNull();
    expect(await authenticateApiKey(prisma, `${valid.rawKey}tampered`)).toBeNull();
    expect(await authenticateApiKey(prisma, 'tck_unknown')).toBeNull();
    await revokeApiKey(prisma, valid.apiKey.id);
    expect(await authenticateApiKey(prisma, valid.rawKey)).toBeNull();
    const expired = await createApiKey(prisma, { name: 'Expired', scopes: [ApiKeyScope.READ_RESERVES], expiresAt: new Date(Date.now() - 1000), createdById: admin.id });
    expect(await authenticateApiKey(prisma, expired.rawKey)).toBeNull();
    expect(await revokeApiKey(prisma, expired.apiKey.id)).toMatchObject({ id: expired.apiKey.id });
    expect(await revokeApiKey(prisma, expired.apiKey.id)).toMatchObject({ id: expired.apiKey.id });
  });
});
