import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { I18nManager } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { en, type Translations } from './en';
import { fa } from './fa';
import { DEFAULT_DISPLAY_UNIT, type DisplayUnit } from './display-unit';
import { request } from '../api/client';
import { readLanguage, saveLanguage, type Language } from '../lib/storage';
import { isWebPlatform } from '../lib/platform';

type LanguageContextValue = {
  t: Translations;
  language: Language;
  direction: 'ltr' | 'rtl';
  setLanguage: (language: Language) => Promise<void>;
  ready: boolean;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en');
  const [ready, setReady] = useState(false);
  const displayUnit = useQuery<DisplayUnit>({
    queryKey: ['display-unit'],
    queryFn: () => request<DisplayUnit>('/v1/public/display-unit', { auth: 'none' }),
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    let active = true;
    void readLanguage().then((stored) => {
      if (!active) return;
      setLanguageState(stored);
      I18nManager.forceRTL(stored === 'fa');
      if (isWebPlatform() && typeof document !== 'undefined') document.documentElement.dir = stored === 'fa' ? 'rtl' : 'ltr';
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const direction: 'ltr' | 'rtl' = language === 'fa' ? 'rtl' : 'ltr';
  const setLanguage = async (next: Language) => {
    await saveLanguage(next);
    setLanguageState(next);
    I18nManager.forceRTL(next === 'fa');
    if (isWebPlatform()) {
      if (typeof document !== 'undefined') document.documentElement.dir = next === 'fa' ? 'rtl' : 'ltr';
      if (typeof window !== 'undefined') window.location.reload();
    }
  };
  const unit = displayUnit.data ?? DEFAULT_DISPLAY_UNIT;
  const value = useMemo(() => ({
    t: language === 'fa' ? fa(unit) : en(unit),
    language,
    direction,
    setLanguage,
    ready,
  }), [direction, language, ready, unit]);
  if (!ready) return null;
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useTranslation(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (value === null) throw new Error('useTranslation must be used inside LanguageProvider');
  return value;
}
