'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_TOKEN_COOKIE } from '../../constants';
import { secureCookies } from '../../config';
import { labels } from '../../labels';
import { ApiResponseError, loginRequest } from '../../lib/api';

export async function loginAction(formData: FormData): Promise<void> {
  const username = formData.get('username');
  const password = formData.get('password');
  if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password === '') {
    redirect(`/login?error=${encodeURIComponent(labels.required)}`);
  }
  try {
    const result = await loginRequest(username, password);
    (await cookies()).set(ADMIN_TOKEN_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      path: '/',
      ...(result.expiresIn === undefined ? {} : { maxAge: result.expiresIn }),
    });
  } catch (error) {
    if (error instanceof ApiResponseError && error.status === 401) {
      redirect(`/login?error=${encodeURIComponent(labels.invalidCredentials)}`);
    }
    redirect(`/login?error=${encodeURIComponent(labels.apiUnavailable)}`);
  }
  redirect('/');
}
