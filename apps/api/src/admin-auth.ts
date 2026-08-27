import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, RequestHandler } from 'express';
import { AdminRole } from '@trustme/db';

export type AdminClaims = {
  sub: string;
  role: AdminRole;
  exp: number;
};

const dummyPasswordHash = '$2b$10$7EqJtq98hPqEX7fNZaFWoO6yJ4zV8n7v2fR8j4V4V7jzQ3F8vQm5u';

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export async function verifyAdminPassword(password: string, passwordHash: string | undefined): Promise<boolean> {
  return bcrypt.compare(password, passwordHash ?? dummyPasswordHash);
}

export function createAdminJwt(adminId: string, role: AdminRole, secret: string, ttlSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: adminId, role, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const body = `${header}.${payload}`;
  return `${body}.${signature(body, secret)}`;
}

export function verifyAdminJwt(token: string, secret: string): AdminClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, providedSignature] = parts;
  if (!header || !payload || !providedSignature) return null;
  const expectedSignature = signature(`${header}.${payload}`, secret);
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(providedSignature);
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) return null;
  try {
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<AdminClaims>;
    if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT' || typeof claims.sub !== 'string' || typeof claims.role !== 'string' || typeof claims.exp !== 'number') return null;
    if (!Object.values(AdminRole).includes(claims.role as AdminRole) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return { sub: claims.sub, role: claims.role as AdminRole, exp: claims.exp };
  } catch {
    return null;
  }
}

export type AdminRequest = Request & { admin?: AdminClaims };

export function adminClaims(request: Request): AdminClaims {
  const claims = (request as AdminRequest).admin;
  if (!claims) throw new Error('admin authentication required');
  return claims;
}

export function requireAdmin(secret: string): RequestHandler {
  return (request, response, next) => {
    const authorization = request.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const claims = token === undefined ? null : verifyAdminJwt(token, secret);
    if (!claims) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    (request as AdminRequest).admin = claims;
    next();
  };
}

export function requireRole(...roles: AdminRole[]): RequestHandler {
  return (request, response, next) => {
    const claims = (request as AdminRequest).admin;
    if (!claims || !roles.includes(claims.role)) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
