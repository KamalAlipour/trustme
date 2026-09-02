import React, { useEffect, useRef } from 'react';
import { router, Stack } from 'expo-router';
import { I18nManager, Platform } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, useSession } from '../src/auth/session';
import { LanguageProvider } from '../src/i18n';
import {
  getWebRedirectHandlingMode,
  readSocialCallbackFromUrl,
  readSocialCallbackStateFromUrl,
  validateWebRedirectState,
} from '../src/auth/web-redirect';
import { installWalletPolyfills } from '../src/lib/wallet-polyfills';

installWalletPolyfills();
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });
const WEB_REDIRECT_DEFER_MS = 1_200;

I18nManager.allowRTL(true);

function WebRedirectHandler() {
  const { member, signInWithSocial } = useSession();
  const handledRedirect = useRef(false);
  const scheduledRedirect = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || member !== null || handledRedirect.current) return;
    const callback = readSocialCallbackFromUrl(window.location.href);
    if (callback === null) return;
    const callbackState = readSocialCallbackStateFromUrl(window.location.href);
    const handlingMode = getWebRedirectHandlingMode(true, Boolean(window.opener));
    const handleRedirect = () => {
      if (handledRedirect.current) return;
      handledRedirect.current = true;
      const cleanUrl = new URL(window.location.href);
      for (const parameter of ['id_token', 'code', 'state']) {
        cleanUrl.searchParams.delete(parameter);
      }
      const hashParams = new URLSearchParams(cleanUrl.hash.replace(/^#/, ''));
      for (const parameter of ['id_token', 'code', 'state']) {
        hashParams.delete(parameter);
      }
      cleanUrl.hash = hashParams.toString() === '' ? '' : `#${hashParams.toString()}`;
      window.history.replaceState(null, document.title, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
      const stateValid = validateWebRedirectState(callback.provider, callbackState, window.sessionStorage);
      if (!stateValid) {
        router.replace({ pathname: '/(auth)/login', params: { error: 'social' } });
        return;
      }
      void signInWithSocial(callback.provider, callback.idToken)
        .then(() => router.replace('/'))
        .catch(() => router.replace({ pathname: '/(auth)/login', params: { error: 'social' } }));
    };
    if (handlingMode === 'deferred') {
      if (!scheduledRedirect.current) {
        scheduledRedirect.current = true;
        setTimeout(handleRedirect, WEB_REDIRECT_DEFER_MS);
      }
      return undefined;
    }
    handleRedirect();
    return undefined;
  }, [member, signInWithSocial]);
  return null;
}

export default function RootLayout() {
  return (
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <WebRedirectHandler />
          <Stack screenOptions={{ headerShown: false }} />
        </SessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
}
