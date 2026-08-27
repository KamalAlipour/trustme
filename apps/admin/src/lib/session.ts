import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_TOKEN_COOKIE } from '../constants';

export type AdminRole = 'VIEWER' | 'APPROVER' | 'ADMIN';
export type AdminSession = { username: string; role: AdminRole };

const roles: readonly AdminRole[] = ['VIEWER', 'APPROVER', 'ADMIN'];

export async function getAdminSession(): Promise<AdminSession | null> {
  const token = (await cookies()).get(ADMIN_TOKEN_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { username?: unknown; role?: unknown };
    if (typeof claims.username !== 'string' || typeof claims.role !== 'string' || !roles.includes(claims.role as AdminRole)) return null;
    return { username: claims.username, role: claims.role as AdminRole };
  } catch {
    return null;
  }
}

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) redirect('/login');
  return session;
}

export function canManageWithdrawals(role: AdminRole): boolean {
  return role === 'APPROVER' || role === 'ADMIN';
}

export function canEditSettings(role: AdminRole): boolean {
  return role === 'ADMIN';
}
