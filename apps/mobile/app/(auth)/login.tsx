import React, { useEffect, useState } from 'react';
import { Link, router } from 'expo-router';
import { Text, TextInput } from 'react-native';
import { ApiError, LockedError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { PinPad } from '../../src/components/PinPad';
import { Page } from '../../src/components/Screen';
import { fa } from '../../src/i18n/fa';
import { isWebPlatform } from '../../src/lib/platform';
import { styles } from '../../src/styles';

export default function Login() {
  const { signIn, biometric, ready, member } = useSession();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);
  useEffect(() => {
    if (ready && member !== null) router.replace('/');
  }, [member, ready]);

  const submit = async () => {
    setError('');
    try {
      await signIn(phone, pin);
      router.replace('/');
    } catch (cause) {
      if (cause instanceof LockedError) {
        setLockedUntil(Date.now() + cause.retryAfter * 1000);
        setError(`${cause.message} (${Math.max(1, Math.ceil(cause.retryAfter / 60))} دقیقه)`);
      } else setError(cause instanceof ApiError ? cause.message : fa.unknownError);
    }
  };
  const remaining = lockedUntil === null ? 0 : Math.max(0, lockedUntil - now);
  return (
    <Page>
      <Text style={styles.title}>{fa.appName}</Text>
      <Text style={styles.heading}>{fa.login}</Text>
      {isWebPlatform() ? <Text style={styles.muted}>{fa.browserSessionNotice}</Text> : null}
      <TextInput value={phone} onChangeText={setPhone} placeholder={fa.phone} style={styles.input} keyboardType="phone-pad" textContentType="telephoneNumber" />
      <PinPad value={pin} onChange={setPin} {...(remaining === 0 ? { onSubmit: submit } : {})} />
      {biometric ? <Text style={styles.muted}>در ورود بعدی، احراز هویت دستگاه برای باز کردن نشست استفاده می‌شود.</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {remaining > 0 ? <Text style={styles.muted}>تا باز شدن حساب: {Math.ceil(remaining / 1000)} ثانیه</Text> : null}
      <Link href="/(auth)/register" style={styles.secondaryButtonText}>حساب ندارید؟ ثبت‌نام</Link>
    </Page>
  );
}
