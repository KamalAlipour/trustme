import React, { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, TextInput } from 'react-native';
import { ApiError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { Page } from '../../src/components/Screen';
import { useTranslation } from '../../src/i18n';
import { isWeakPin } from '../../src/lib/pin';
import { styles } from '../../src/styles';
import { SocialAuthButtons } from '../../src/components/SocialAuthButtons';

export default function Register() {
  const { t } = useTranslation();
  const { signUp, signInWithSocial } = useSession();
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (pin !== confirm) { setError(t.pinMismatch); return; }
    if (isWeakPin(pin)) { setError(t.weakPin); return; }
    try {
      await signUp(phone, pin, displayName || undefined, email.trim() || undefined);
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t.unknownError);
    }
  };
  return (
    <Page>
      <Text style={styles.title}>{t.register}</Text>
      <SocialAuthButtons
        onError={setError}
        onGoogleToken={async (idToken) => { await signInWithSocial('google', idToken); router.replace('/'); }}
        onAppleToken={async (idToken, displayName) => { await signInWithSocial('apple', idToken, displayName); router.replace('/'); }}
      />
      <TextInput value={phone} onChangeText={setPhone} placeholder={t.phone} style={styles.input} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" />
      <TextInput value={displayName} onChangeText={setDisplayName} placeholder={t.displayName} style={styles.input} />
      <TextInput value={email} onChangeText={setEmail} placeholder={t.email} style={styles.input} keyboardType="email-address" autoCapitalize="none" />
      <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
      <TextInput value={confirm} onChangeText={(value) => setConfirm(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.confirmPin} style={styles.input} keyboardType="number-pad" secureTextEntry />
      <Pressable onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{t.continue}</Text></Pressable>
      {email.trim() ? <Text style={styles.muted}>{t.emailCodeSent} {t.noRecovery}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <Pressable onPress={() => router.replace('/(auth)/login')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.accountExists}</Text></Pressable>
    </Page>
  );
}
