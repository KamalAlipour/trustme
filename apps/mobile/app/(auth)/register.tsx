import React, { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { ApiError, fetchHumanVerification, type HumanVerificationConfig } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { Logo } from '../../src/components/Logo';
import { Page } from '../../src/components/Screen';
import { useTranslation } from '../../src/i18n';
import { isWeakPin } from '../../src/lib/pin';
import { styles } from '../../src/styles';
import { SocialAuthButtons } from '../../src/components/SocialAuthButtons';
import { HumanVerification } from '../../src/components/HumanVerification';

export default function Register() {
  const { t } = useTranslation();
  const { signUp, signInWithSocial } = useSession();
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [humanConfig, setHumanConfig] = useState<HumanVerificationConfig | null>(null);
  const [humanToken, setHumanToken] = useState<string | null>(null);
  const [humanWidgetKey, setHumanWidgetKey] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchHumanVerification().then((result) => {
      if (active) setHumanConfig(result);
    }).catch(() => {
      if (active) setHumanConfig({ enabled: false, siteKey: null });
    });
    return () => { active = false; };
  }, []);
  const submit = async () => {
    setError('');
    if (pin !== confirm) { setError(t.pinMismatch); return; }
    if (isWeakPin(pin)) { setError(t.weakPin); return; }
    try {
      await signUp(phone, pin, displayName || undefined, email.trim() || undefined, humanToken ?? undefined);
      router.replace('/');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403 && cause.body.error === 'human_verification_failed') {
        setHumanToken(null);
        setHumanWidgetKey((key) => key + 1);
        setError(t.humanCheck.failed);
      } else setError(cause instanceof ApiError ? cause.message : t.unknownError);
    }
  };
  const humanRequired = humanConfig?.enabled === true;
  const submitEnabled = humanConfig !== null && (!humanRequired || humanToken !== null);
  return (
    <Page>
      <View style={{ alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Logo size={96} />
        <Text style={styles.title}>{t.register}</Text>
      </View>
      <SocialAuthButtons
        onError={setError}
        humanToken={humanToken}
        disabled={!submitEnabled}
        onHumanVerificationFailure={() => {
          setHumanToken(null);
          setHumanWidgetKey((key) => key + 1);
        }}
        onGoogleToken={async (idToken) => { await signInWithSocial('google', idToken, undefined, humanToken ?? undefined); router.replace('/'); }}
        onAppleToken={async (idToken, displayName) => { await signInWithSocial('apple', idToken, displayName, humanToken ?? undefined); router.replace('/'); }}
      />
      <TextInput value={phone} onChangeText={setPhone} placeholder={t.phone} style={styles.input} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" />
      <TextInput value={displayName} onChangeText={setDisplayName} placeholder={t.displayName} style={styles.input} />
      <TextInput value={email} onChangeText={setEmail} placeholder={t.email} style={styles.input} keyboardType="email-address" autoCapitalize="none" />
      <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
      <TextInput value={confirm} onChangeText={(value) => setConfirm(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.confirmPin} style={styles.input} keyboardType="number-pad" secureTextEntry />
      {humanRequired && humanConfig.siteKey !== null ? (
        <>
          <Text style={styles.muted}>{t.humanCheck.title}</Text>
          <HumanVerification key={humanWidgetKey} siteKey={humanConfig.siteKey} onToken={setHumanToken} />
          {humanToken === null ? <Text style={styles.muted}>{t.humanCheck.required}</Text> : null}
        </>
      ) : null}
      <Pressable disabled={!submitEnabled} onPress={() => void submit()} style={[styles.button, !submitEnabled ? styles.socialAuthButtonBusy : null]}><Text style={styles.buttonText}>{t.continue}</Text></Pressable>
      {email.trim() ? <Text style={styles.muted}>{t.emailCodeSent} {t.noRecovery}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <Pressable onPress={() => router.replace('/(auth)/login')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.accountExists}</Text></Pressable>
    </Page>
  );
}
