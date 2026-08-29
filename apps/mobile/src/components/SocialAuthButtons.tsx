import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { ResponseType } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useTranslation } from '../i18n';
import { isAppleSignInAvailable, isGoogleSignInAvailable, socialClientIds } from '../auth/social';
import { appleWebClientId, appleWebStateKey, buildAppleAuthorizeUrl, isAppleWebSignInAvailable } from '../auth/apple-web';
import { AppleIcon, GoogleIcon } from './BrandIcons';
import { styles } from '../styles';

WebBrowser.maybeCompleteAuthSession();

export function SocialAuthButtons({
  onError,
  onGoogleToken,
  onAppleToken,
}: {
  onError: (message: string) => void;
  onGoogleToken: (idToken: string) => Promise<void>;
  onAppleToken: (idToken: string, displayName?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const googleAvailable = isGoogleSignInAvailable();
  const [googleRequest, googleResponse, promptGoogle] = Google.useAuthRequest({
    ...(socialClientIds.web === undefined ? {} : { webClientId: socialClientIds.web }),
    ...(socialClientIds.ios === undefined ? {} : { iosClientId: socialClientIds.ios }),
    ...(socialClientIds.android === undefined ? {} : { androidClientId: socialClientIds.android }),
    responseType: ResponseType.IdToken,
    selectAccount: true,
  });
  const [busy, setBusy] = useState(false);
  const processedGoogleResponse = useRef<typeof googleResponse>(null);

  useEffect(() => {
    if (googleResponse === null || googleResponse === processedGoogleResponse.current || googleResponse.type !== 'success') return;
    processedGoogleResponse.current = googleResponse;
    const idToken = googleResponse.params?.id_token;
    if (typeof idToken !== 'string') {
      onError(t.socialSignInUnavailable);
      return;
    }
    setBusy(true);
    void onGoogleToken(idToken).catch(() => onError(t.socialSignInUnavailable)).finally(() => setBusy(false));
  }, [googleResponse, onGoogleToken, onError, t.socialSignInUnavailable]);

  const signInWithApple = async () => {
    setBusy(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      const fullName = credential.fullName;
      const displayName = fullName === null ? undefined : [fullName.givenName, fullName.middleName, fullName.familyName].filter(Boolean).join(' ') || undefined;
      if (credential.identityToken === null) {
        onError(t.socialSignInUnavailable);
        return;
      }
      await onAppleToken(credential.identityToken, displayName);
    } catch {
      onError(t.socialSignInUnavailable);
    } finally {
      setBusy(false);
    }
  };

  const appleWebAvailable = isAppleWebSignInAvailable(Platform.OS, appleWebClientId);
  const appleNativeAvailable = isAppleSignInAvailable();
  const signInWithAppleWeb = () => {
    try {
      if (!appleWebAvailable || typeof window === 'undefined' || window.crypto === undefined) {
        onError(t.socialSignInUnavailable);
        return;
      }
      const randomBytes = (length: number) => {
        const bytes = new Uint8Array(length);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
      };
      const state = `apple:${randomBytes(16)}`;
      const nonce = randomBytes(16);
      window.sessionStorage.setItem(appleWebStateKey, state);
      window.location.assign(buildAppleAuthorizeUrl({
        clientId: appleWebClientId as string,
        redirectUri: window.location.origin,
        state,
        nonce,
      }));
    } catch {
      onError(t.socialSignInUnavailable);
    }
  };

  if (!googleAvailable && !appleNativeAvailable && !appleWebAvailable) return null;
  const appleAvailable = appleNativeAvailable || appleWebAvailable;
  return (
    <View style={styles.socialAuthContainer}>
      <View style={styles.divider} />
      <Text style={styles.muted}>{t.or}</Text>
      <View style={styles.socialAuthRow}>
        {googleAvailable ? <Pressable
          accessibilityLabel={t.signInWithGoogle}
          disabled={googleRequest === null || busy}
          onPress={() => void promptGoogle()}
          style={[styles.socialAuthButton, styles.socialAuthGoogleButton, busy ? styles.socialAuthButtonBusy : null]}
        >
          <GoogleIcon size={20} />
          <Text numberOfLines={1} style={styles.socialAuthGoogleText}>{t.signInWithGoogleShort}</Text>
        </Pressable> : null}
        {appleAvailable ? <Pressable
          accessibilityLabel={t.signInWithApple}
          disabled={busy}
          onPress={() => {
            if (busy) return;
            if (appleWebAvailable) {
              signInWithAppleWeb();
            } else {
              void signInWithApple();
            }
          }}
          style={[styles.socialAuthButton, styles.socialAuthAppleButton, busy ? styles.socialAuthButtonBusy : null]}
        >
          <AppleIcon size={20} color="#FFFFFF" />
          <Text numberOfLines={1} style={styles.socialAuthAppleText}>{googleAvailable ? t.signInWithAppleShort : t.signInWithApple}</Text>
        </Pressable> : null}
      </View>
    </View>
  );
}
