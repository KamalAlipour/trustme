import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_TOKEN_COOKIE } from '../constants';
import { config } from '../config';
import { labels } from '../labels';

export class ApiForbiddenError extends Error {
  public constructor() {
    super('forbidden');
    this.name = 'ApiForbiddenError';
  }
}

export class ApiResponseError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
  }
}

type ApiErrorBody = { error?: string };

export async function adminApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await cookies()).get(ADMIN_TOKEN_COOKIE)?.value;
  if (!token) redirect('/login');
  const response = await fetch(`${config.trustmeApiUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
  if (response.status === 401) redirect('/login');
  if (response.status === 403) throw new ApiForbiddenError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiResponseError(response.status, body.error ?? labels.requestFailed);
  }
  return (await response.json()) as T;
}

export async function loginRequest(username: string, password: string): Promise<{ token: string; expiresIn?: number }> {
  const response = await fetch(`${config.trustmeApiUrl.replace(/\/$/, '')}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiResponseError(response.status, body.error ?? labels.requestFailed);
  }
  return (await response.json()) as { token: string };
}
