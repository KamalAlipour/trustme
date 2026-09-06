import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_TOKEN_COOKIE } from '../../../constants';
import { secureCookies } from '../../../config';
import { labels } from '../../../labels';
import { ApiResponseError, googleLoginRequest } from '../../../lib/api';

function errorRedirect(request: Request, message: string): NextResponse {
  const url = new URL('/login', request.url);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const credential = form.get('credential');
  const formCsrf = form.get('g_csrf_token');
  const cookieCsrf = (await cookies()).get('g_csrf_token')?.value;
  if (typeof credential !== 'string' || credential === '' || typeof formCsrf !== 'string' || formCsrf === '' || formCsrf !== cookieCsrf) {
    return errorRedirect(request, labels.invalidCredentials);
  }
  try {
    const result = await googleLoginRequest(credential);
    const response = NextResponse.redirect(new URL('/', request.url));
    response.cookies.set(ADMIN_TOKEN_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      path: '/',
      ...(result.expiresIn === undefined ? {} : { maxAge: result.expiresIn }),
    });
    return response;
  } catch (error) {
    if (error instanceof ApiResponseError && (error.status === 401 || error.status === 403)) {
      return errorRedirect(request, labels.googleNotAllowed);
    }
    return errorRedirect(request, labels.apiUnavailable);
  }
}
