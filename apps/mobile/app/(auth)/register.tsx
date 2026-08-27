import React, { useState } from 'react';
import { router } from 'expo-router';
import { Text, TextInput } from 'react-native';
import { ApiError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { Page } from '../../src/components/Screen';
import { fa } from '../../src/i18n/fa';
import { isWeakPin } from '../../src/lib/pin';
import { styles } from '../../src/styles';

export default function Register() {
  const { signUp } = useSession();
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (pin !== confirm) { setError('رمزها یکسان نیستند.'); return; }
    if (isWeakPin(pin)) { setError('رمز تکراری یا دنباله‌دار قابل استفاده نیست.'); return; }
    try {
      await signUp(phone, pin, displayName || undefined, email || undefined);
      router.replace(email ? { pathname: '/(auth)/verify-email', params: { email } } : '/(tabs)');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : fa.unknownError);
    }
  };
  return (
    <Page>
      <Text style={styles.title}>{fa.register}</Text>
      <TextInput value={phone} onChangeText={setPhone} placeholder={fa.phone} style={styles.input} keyboardType="phone-pad" />
      <TextInput value={displayName} onChangeText={setDisplayName} placeholder={fa.displayName} style={styles.input} />
      <TextInput value={email} onChangeText={setEmail} placeholder={`${fa.email} (اختیاری)`} style={styles.input} keyboardType="email-address" autoCapitalize="none" />
      <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={fa.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
      <TextInput value={confirm} onChangeText={(value) => setConfirm(value.replace(/\D/g, '').slice(0, 4))} placeholder={fa.confirmPin} style={styles.input} keyboardType="number-pad" secureTextEntry />
      <Text onPress={() => void submit()} style={{ ...styles.button, ...styles.buttonText }}>{fa.continue}</Text>
      {email ? <Text style={styles.muted}>{fa.emailCodeSent} {fa.noRecovery}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <Text onPress={() => router.replace('/(auth)/login')} style={styles.secondaryButtonText}>حساب دارید؟ ورود</Text>
    </Page>
  );
}
