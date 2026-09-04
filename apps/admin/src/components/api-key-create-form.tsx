'use client';

import { useActionState, useEffect } from 'react';
import { createApiKeyAction, type ApiKeyActionState } from '../app/api-keys/actions';
import { labels } from '../labels';

const scopes = [
  ['read:market_average', labels.apiKeyMarketAverage],
  ['read:reserves', labels.apiKeyReserves],
  ['write:execute_transfer_on_behalf_of_user', labels.apiKeyExecuteTransfer],
] as const;

export function ApiKeyCreateForm() {
  const [state, action, pending] = useActionState<ApiKeyActionState, FormData>(createApiKeyAction, {});
  useEffect(() => {
    if (state.rawKey !== undefined && window.location.pathname !== '/api-keys/new-result') window.history.replaceState({}, '', '/api-keys/new-result');
  }, [state.rawKey]);
  return (
    <div className="space-y-4 rounded-lg border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{labels.createApiKey}</h2>
      <form action={action} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{labels.apiKeyName}</span>
          <input className="w-full" name="name" required minLength={1} maxLength={80} />
          <span className="mt-1 block text-xs text-slate-500">{labels.apiKeyNameDescription}</span>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{labels.apiKeyScopes}</legend>
          {scopes.map(([value, description]) => (
            <label className="block" key={value}>
              <span className="flex items-center gap-2"><input type="checkbox" name="scopes" value={value} /> <code>{value}</code></span>
              <span className="ml-6 block text-xs text-slate-500">{description}</span>
            </label>
          ))}
        </fieldset>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{labels.apiKeyOptionalExpiry}</span>
          <input className="w-full" type="date" name="expiresAt" />
        </label>
        {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
        <button type="submit" disabled={pending} className="bg-blue-700 text-white hover:bg-blue-800">{pending ? '…' : labels.createApiKey}</button>
      </form>
      {state.rawKey ? <div className="rounded border-2 border-amber-400 bg-amber-50 p-4" role="status"><p className="font-semibold">{labels.apiKeyOneTimeWarning}</p><code className="mt-2 block break-all select-all">{state.rawKey}</code></div> : null}
    </div>
  );
}
