import { clearCredentials, readRefreshToken, saveRefreshToken } from '../lib/storage';
import type { AuthResponse, Tokens } from './types';

export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'https://api-trustme.komasi.as').replace(/\/$/, '');

export class ApiError extends Error {
  public constructor(public readonly status: number, public readonly body: { error?: string; retryAfter?: number } = {}) {
    super(body.error ?? 'request failed');
    this.name = 'ApiError';
  }
}

export class LockedError extends ApiError {
  public readonly retryAfter: number;
  public constructor(body: { error?: string; retryAfter?: number }) {
    super(423, body);
    this.name = 'LockedError';
    this.retryAfter = body.retryAfter ?? 0;
  }
}

export class SessionExpiredError extends ApiError {
  public constructor() {
    super(401, { error: 'session expired' });
    this.name = 'SessionExpiredError';
  }
}

let accessToken: string | null = null;
let refreshFlight: Promise<Tokens> | null = null;
let onSessionExpired: (() => void) | undefined;

export function setSessionExpiredHandler(handler: (() => void) | undefined): void {
  onSessionExpired = handler;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export async function forgetSession(): Promise<void> {
  accessToken = null;
  await clearCredentials();
}

async function expireSession(): Promise<never> {
  await forgetSession();
  onSessionExpired?.();
  throw new SessionExpiredError();
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

async function refreshSession(): Promise<Tokens> {
  if (refreshFlight !== null) return refreshFlight;
  refreshFlight = (async () => {
    const refreshToken = await readRefreshToken();
    if (refreshToken === null) return expireSession();
    const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const body = await parseResponse(response) as { tokens?: Tokens; error?: string; retryAfter?: number };
    if (!response.ok || body.tokens === undefined) return expireSession();
    accessToken = body.tokens.accessToken;
    await saveRefreshToken(body.tokens.refreshToken);
    return body.tokens;
  })();
  try {
    return await refreshFlight;
  } finally {
    refreshFlight = null;
  }
}

export function refresh(): Promise<Tokens> {
  return refreshSession();
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  auth?: 'member' | 'none';
  retried?: boolean;
};

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

async function authenticatedFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const auth = options.auth ?? 'member';
  if (auth === 'member' && accessToken === null) await refreshSession();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined && !isFormData(options.body)) headers['content-type'] = 'application/json';
  if (auth === 'member' && accessToken !== null) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: isFormData(options.body) ? options.body : JSON.stringify(options.body) }),
  });
  if (response.status === 423) throw new LockedError(await parseResponse(response) as { error?: string; retryAfter?: number });
  if (response.status === 401 && auth === 'member' && options.retried !== true) {
    await refreshSession();
    return authenticatedFetch(path, { ...options, retried: true });
  }
  if (response.status === 401 && auth === 'member') return expireSession();
  if (!response.ok) throw new ApiError(response.status, await parseResponse(response) as { error?: string; retryAfter?: number });
  return response;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await authenticatedFetch(path, options);
  return await parseResponse(response) as T;
}

export async function authenticate(path: '/v1/auth/login' | '/v1/auth/register', body: Record<string, unknown>): Promise<AuthResponse> {
  const result = await request<AuthResponse>(path, { method: 'POST', auth: 'none', body });
  accessToken = result.tokens.accessToken;
  return result;
}

export async function logout(): Promise<void> {
  if (accessToken !== null) {
    try {
      await request('/v1/me/logout', { method: 'POST' });
    } catch {
      // Credentials are cleared even when the network is unavailable.
    }
  }
  await forgetSession();
}
