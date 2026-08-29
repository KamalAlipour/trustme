import { appleWebStateKey } from './apple-web';
import { googleWebStateKey } from './google-web';

type SocialCallback = {
  provider: 'google' | 'apple';
  idToken: string;
};

type SocialCallbackDetails = SocialCallback & {
  state: string | null;
};

export type WebRedirectHandlingMode = 'immediate' | 'deferred' | null;

export type WebRedirectStateStorage = {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
};

export function getWebRedirectHandlingMode(
  hasCallback: boolean,
  hasOpener: boolean,
): WebRedirectHandlingMode {
  if (!hasCallback) return null;
  return hasOpener ? 'deferred' : 'immediate';
}

export function validateWebRedirectState(
  provider: SocialCallback['provider'],
  callbackState: string | null,
  storage: WebRedirectStateStorage,
): boolean {
  const stateKey = provider === 'apple' ? appleWebStateKey : googleWebStateKey;
  try {
    const expectedState = storage.getItem(stateKey);
    storage.removeItem(stateKey);
    return expectedState !== null && callbackState === expectedState;
  } catch {
    return false;
  }
}

function readSocialCallbackDetailsFromUrl(url: string): SocialCallbackDetails | null {
  try {
    const parsed = new URL(url);
    const sources = [
      new URLSearchParams(parsed.hash.replace(/^#/, '')),
      parsed.searchParams,
    ];
    for (const params of sources) {
      const idToken = params.get('id_token');
      if (idToken) {
        const state = params.get('state');
        return { provider: state?.startsWith('apple:') === true ? 'apple' : 'google', idToken, state };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function readSocialCallbackFromUrl(url: string): SocialCallback | null {
  const callback = readSocialCallbackDetailsFromUrl(url);
  if (callback === null) return null;
  return { provider: callback.provider, idToken: callback.idToken };
}

export function readSocialCallbackStateFromUrl(url: string): string | null {
  return readSocialCallbackDetailsFromUrl(url)?.state ?? null;
}

export function readIdTokenFromUrl(url: string): string | null {
  return readSocialCallbackFromUrl(url)?.idToken ?? null;
}
