import React, { useEffect, useRef, useState } from 'react';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { ApiError, LockedError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { PinPad } from '../../src/components/PinPad';
import { Page } from '../../src/components/Screen';
import { useTranslation } from '../../src/i18n';
import { isWebPlatform } from '../../src/lib/platform';
import { styles } from '../../src/styles';
import { SocialAuthButtons } from '../../src/components/SocialAuthButtons';

export default function Login() {
  const { t, language, setLanguage } = useTranslation();
  const { signIn, signInWithSocial, biometric, ready, member } = useSession();
  const { error: routeError } = useLocalSearchParams<{ error?: string }>();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [languageNotice, setLanguageNotice] = useState('');
  const previousLanguage = useRef(language);

  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);
  useEffect(() => {
    if (ready && member !== null) router.replace('/');
  }, [member, ready]);
  useEffect(() => {
    if (routeError === 'social') setError(t.socialSignInUnavailable);
  }, [routeError, t.socialSignInUnavailable]);
  useEffect(() => {
    if (previousLanguage.current !== language) {
      setLanguageNotice(t.languageRestartNotice(language));
      previousLanguage.current = language;
    }
  }, [language, t]);

  const submit = async () => {
    setError('');
    try {
      await signIn(phone, pin);
      router.replace('/');
    } catch (cause) {
      if (cause instanceof LockedError) {
        setLockedUntil(Date.now() + cause.retryAfter * 1000);
        setError(`${cause.message} (${t.lockedFor(Math.max(1, Math.ceil(cause.retryAfter / 60)))})`);
      } else setError(cause instanceof ApiError ? cause.message : t.unknownError);
    }
  };
  const remaining = lockedUntil === null ? 0 : Math.max(0, lockedUntil - now);
  return (
    <Page>
      <Text style={styles.title}>{t.appName}</Text>
      <Text style={styles.heading}>{t.login}</Text>
      {isWebPlatform() ? <Text style={styles.muted}>{t.browserSessionNotice}</Text> : null}
      <SocialAuthButtons
        onError={setError}
        onGoogleToken={async (idToken) => { await signInWithSocial('google', idToken); router.replace('/'); }}
        onAppleToken={async (idToken, displayName) => { await signInWithSocial('apple', idToken, displayName); router.replace('/'); }}
      />
      <TextInput value={phone} onChangeText={setPhone} placeholder={t.phone} style={styles.input} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" />
      <PinPad value={pin} onChange={setPin} {...(remaining === 0 ? { onSubmit: submit } : {})} />
      {biometric ? <Text style={styles.muted}>{t.biometricSessionNotice}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {remaining > 0 ? <Text style={styles.muted}>{t.unlockIn(Math.ceil(remaining / 1000))}</Text> : null}
      <Link href="/(auth)/register" style={styles.secondaryButtonText}>{t.noAccountRegister}</Link>
      <View style={styles.languageRow}>
        <Pressable onPress={() => void setLanguage('en')} style={language === 'en' ? styles.languageActive : styles.languageButton}><Text style={styles.secondaryButtonText}>{t.english}</Text></Pressable>
        <Pressable onPress={() => void setLanguage('fa')} style={language === 'fa' ? styles.languageActive : styles.languageButton}><Text style={styles.secondaryButtonText}>{t.persian}</Text></Pressable>
      </View>
      {languageNotice ? <Text style={styles.notice}>{languageNotice}</Text> : null}
    </Page>
  );
}
