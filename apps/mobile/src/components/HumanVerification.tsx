import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Platform, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useTranslation } from '../i18n';
import { APP_WEB_ORIGIN } from '../api/client';

type TurnstileWidget = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileWidget;
  }
}

export type HumanVerificationRef = { reset: () => void };

export const HumanVerification = forwardRef<HumanVerificationRef, {
  siteKey: string;
  onToken: (token: string | null) => void;
}>(({ siteKey, onToken }, ref) => {
  const { language } = useTranslation();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const webViewRef = useRef<WebView>(null);
  const renderWebWidget = () => {
    if (Platform.OS !== 'web' || elementRef.current === null || window.turnstile === undefined) return;
    if (widgetIdRef.current !== null) window.turnstile.remove(widgetIdRef.current);
    widgetIdRef.current = window.turnstile.render(elementRef.current, {
      sitekey: siteKey,
      callback: onToken,
      'expired-callback': () => onToken(null),
      'error-callback': () => onToken(null),
      theme: 'auto',
      language: language === 'fa' ? 'fa' : 'en',
    });
  };
  useImperativeHandle(ref, () => ({
    reset: () => {
      onToken(null);
      if (Platform.OS === 'web') renderWebWidget();
      else webViewRef.current?.reload();
    },
  }), [onToken, language, siteKey]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const scriptId = 'trustme-turnstile-script';
    const render = () => renderWebWidget();
    const existing = document.getElementById(scriptId);
    if (existing) {
      if (window.turnstile) render();
      else existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render, { once: true });
      document.head.appendChild(script);
    }
    return () => {
      if (widgetIdRef.current !== null && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [language, onToken, siteKey]);
  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; token?: string };
      if (message.type === 'turnstile' && typeof message.token === 'string') onToken(message.token);
      else if (message.type === 'turnstile-error') onToken(null);
    } catch {
      onToken(null);
    }
  };
  if (Platform.OS === 'web') return <div ref={elementRef} />;
  const uri = `${APP_WEB_ORIGIN}/turnstile.html?sitekey=${encodeURIComponent(siteKey)}&theme=light`;
  return <View style={{ height: 70, backgroundColor: 'transparent' }}><WebView ref={webViewRef} source={{ uri }} onMessage={onMessage} javaScriptEnabled originWhitelist={['*']} scrollEnabled={false} style={{ backgroundColor: 'transparent' }} /></View>;
});

HumanVerification.displayName = 'HumanVerification';
