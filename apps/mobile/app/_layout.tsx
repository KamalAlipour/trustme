import React, { useEffect, useRef } from 'react';
import { router, Stack } from 'expo-router';
import { I18nManager, Platform } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, useSession } from '../src/auth/session';
import { LanguageProvider } from '../src/i18n';
import { readIdTokenFromUrl } from '../src/auth/web-redirect';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

I18nManager.allowRTL(true);

function WebRedirectHandler() {
  const { member, signInWithSocial } = useSession();
  const handledRedirect = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || member !== null || handledRedirect.current || window.opener) return;
    const idToken = readIdTokenFromUrl(window.location.href);
    if (idToken === null) return;
    handledRedirect.current = true;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('id_token');
    const hashParams = new URLSearchParams(cleanUrl.hash.replace(/^#/, ''));
    if (hashParams.has('id_token')) {
      hashParams.delete('id_token');
      cleanUrl.hash = hashParams.toString() === '' ? '' : `#${hashParams.toString()}`;
    }
    window.history.replaceState(null, document.title, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    void signInWithSocial('google', idToken)
      .then(() => router.replace('/'))
      .catch(() => router.replace({ pathname: '/(auth)/login', params: { error: 'social' } }));
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
