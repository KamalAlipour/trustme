import { loginAction } from './actions';
import { labels } from '../../labels';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <form action={loginAction} className="w-full max-w-sm space-y-5 rounded-lg border bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">{labels.appName}</h1>
        <label className="block"><span className="mb-1 block text-sm font-medium">{labels.username}</span><input className="w-full" name="username" autoComplete="username" /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">{labels.password}</span><input className="w-full" name="password" type="password" autoComplete="current-password" /></label>
        {params.error ? <p className="text-sm text-red-700">{params.error}</p> : null}
        <button type="submit" className="w-full bg-blue-700 text-white hover:bg-blue-800">{labels.login}</button>
      </form>
    </main>
  );
}
