import type { Request, RequestHandler } from 'express';
import type { ApiKey, ApiKeyScope, PrismaClient } from '@trustme/db';
import { authenticateApiKey, SCOPE_NAMES } from '@trustme/core';

type ApiKeyRequest = Request & { apiKey?: ApiKey };

export function requireApiKey(prisma: PrismaClient, ...requiredScopes: ApiKeyScope[]): RequestHandler {
  return async (request, response, next) => {
    try {
      const authorization = request.header('authorization');
      const rawKey = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      if (rawKey === undefined || !rawKey.startsWith('tck_')) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }
      const apiKey = await authenticateApiKey(prisma, rawKey);
      if (apiKey === null) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (!requiredScopes.every((scope) => apiKey.scopes.includes(scope))) {
        response.status(403).json({ error: 'insufficient_scope', required: requiredScopes.map((scope) => SCOPE_NAMES[scope]) });
        return;
      }
      (request as ApiKeyRequest).apiKey = apiKey;
      next();
    } catch (error) {
      next(error);
    }
  };
}
