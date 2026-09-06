import { loginAction } from './actions';
import { labels } from '../../labels';
import { config } from '../../config';
import { headers } from 'next/headers';
import Script from 'next/script';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const protocol = requestHeaders.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  const host = requestHeaders.get('host') ?? 'localhost';
  const publicUrl = config.publicUrl ?? `${protocol}://${host}`;
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-5 rounded-lg border bg-white p-8 shadow-sm">
        <form action={loginAction} className="space-y-5">
          <h1 className="text-2xl font-semibold">{labels.appName}</h1>
          <label className="block"><span className="mb-1 block text-sm font-medium">{labels.username}</span><input className="w-full" name="username" autoComplete="username" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">{labels.password}</span><input className="w-full" name="password" type="password" autoComplete="current-password" /></label>
          {params.error ? <p className="text-sm text-red-700">{params.error}</p> : null}
          <button type="submit" className="w-full bg-blue-700 text-white hover:bg-blue-800">{labels.login}</button>
        </form>
        {config.adminGoogleClientId ? (
          <>
            <div className="border-t pt-5 text-center">
              <Script src="https://accounts.google.com/gsi/client" async />
              <div id="g_id_onload" data-client_id={config.adminGoogleClientId} data-ux_mode="redirect" data-login_uri={`${publicUrl}/api/google-login`} data-auto_prompt="false" />
              <div className="g_id_signin" data-type="standard" data-theme="outline" data-size="large" data-text="signin_with" />
              <p className="mt-2 text-sm text-slate-500">{labels.signInWithGoogle}</p>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
