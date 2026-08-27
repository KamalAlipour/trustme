import React, { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Text, TextInput } from 'react-native';
import { ApiError, request } from '../../src/api/client';
import { Page } from '../../src/components/Screen';
import { fa } from '../../src/i18n/fa';
import { styles } from '../../src/styles';

export default function VerifyEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const verify = async () => {
    try {
      await request('/v1/me/email/verify', { method: 'POST', body: { code } });
      router.replace('/(tabs)');
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  return (
    <Page>
      <Text style={styles.title}>{fa.verify}</Text>
      <Text style={styles.text}>{fa.emailCodeSent} {email ?? ''}</Text>
      <TextInput value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="کد شش رقمی" style={styles.input} keyboardType="number-pad" />
      <Text onPress={() => void verify()} style={{ ...styles.button, ...styles.buttonText }}>{fa.verify}</Text>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <Text onPress={() => router.replace('/(tabs)')} style={styles.secondaryButtonText}>{fa.skip}</Text>
    </Page>
  );
}
