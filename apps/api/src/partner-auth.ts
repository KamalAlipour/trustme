import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ApiKeyScope, type ApiKey, type PrismaClient } from '@trustme/db';
import { authenticateApiKey, decryptApiSecret, SCOPE_NAMES } from '@trustme/core';

export type ApiKeyRequest = Request & { apiKey?: ApiKey; partnerUserId?: string; rawBody?: Buffer };

export function requireApiKey(prisma: PrismaClient, requiredScopes: ApiKeyScope[], secretEncryptionKey?: string): RequestHandler {
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
      const partnerScope = requiredScopes.some((scope) => new Set<ApiKeyScope>([ApiKeyScope.PARTNER_BUYERS, ApiKeyScope.PARTNER_DEPOSITS, ApiKeyScope.PARTNER_CHECKOUT]).has(scope));
      if (partnerScope && apiKey.partnerUserId === null) {
        response.status(403).json({ error: 'partner_not_linked' });
        return;
      }
      if (apiKey.secretCiphertext !== null) {
        const timestamp = request.header('x-tc-timestamp');
        const signature = request.header('x-tc-signature');
        if (timestamp === undefined || signature === undefined) {
          response.status(401).json({ error: 'signature_required' });
          return;
        }
        const parsedTimestamp = Number(timestamp);
        if (!Number.isInteger(parsedTimestamp) || Math.abs(Math.floor(Date.now() / 1000) - parsedTimestamp) > 300) {
          response.status(401).json({ error: 'stale_timestamp' });
          return;
        }
        try {
          if (secretEncryptionKey === undefined) throw new Error('secret key unavailable');
          const secret = decryptApiSecret(apiKey.secretCiphertext, secretEncryptionKey);
          const bodyHash = createHash('sha256').update((request as ApiKeyRequest).rawBody ?? Buffer.alloc(0)).digest('hex');
          const canonical = `${timestamp}\n${request.method}\n${request.originalUrl}\n${bodyHash}`;
          const expected = createHmac('sha256', secret).update(canonical).digest('hex');
          const expectedBuffer = Buffer.from(expected, 'utf8');
          const signatureBuffer = Buffer.from(signature, 'utf8');
          if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) throw new Error('signature mismatch');
        } catch {
          response.status(401).json({ error: 'invalid_signature' });
          return;
        }
      }
      (request as ApiKeyRequest).apiKey = apiKey;
      if (apiKey.partnerUserId !== null) (request as ApiKeyRequest).partnerUserId = apiKey.partnerUserId;
      next();
    } catch (error) {
      next(error);
    }
  };
}
