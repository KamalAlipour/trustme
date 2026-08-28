import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { ApiError, request } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { shouldEnrollBiometrics } from '../../src/auth/setup-capabilities';
import { Page } from '../../src/components/Screen';
import { fa } from '../../src/i18n/fa';
import { authenticateLocally, biometricAvailable } from '../../src/lib/biometrics';
import { readPin } from '../../src/lib/storage';
import { styles } from '../../src/styles';

export default function SecuritySetup() {
  const { refreshSetup } = useSession();
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void biometricAvailable().then(setAvailable).catch(() => setAvailable(false));
  }, []);

  const enroll = async () => {
    setError('');
    setBusy(true);
    try {
      const biometricEnrolled = shouldEnrollBiometrics(Platform.OS, available);
      if (biometricEnrolled) {
        if (!await authenticateLocally()) {
          setError(fa.biometricCancelled);
          return;
        }
      }
      const pin = await readPin();
      if (pin === null) {
        setError(fa.pinUnavailable);
        return;
      }
      await request('/v1/member/security/biometric', {
        method: 'POST',
        body: { pin, biometricEnrolled },
      });
      await refreshSetup();
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : fa.unknownError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <Text style={styles.title}>{fa.securitySetup}</Text>
      <Text style={styles.text}>{fa.biometricInstructions}</Text>
      {Platform.OS === 'web' ? <Text style={styles.notice}>{fa.browserBiometricNotice}</Text> : null}
      {Platform.OS !== 'web' && !available ? <Text style={styles.muted}>{fa.biometricUnavailable}</Text> : null}
      <Pressable disabled={busy} onPress={() => void enroll()} style={styles.button}><Text style={styles.buttonText}>{fa.enrolBiometric}</Text></Pressable>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </Page>
  );
}
