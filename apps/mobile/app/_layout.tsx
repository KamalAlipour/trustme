import React from 'react';
import { Stack } from 'expo-router';
import { I18nManager } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '../src/auth/session';
import { LanguageProvider } from '../src/i18n';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

I18nManager.allowRTL(true);

export default function RootLayout() {
  return (
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </SessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
}
