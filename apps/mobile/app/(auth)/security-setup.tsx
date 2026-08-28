import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { ApiError, request } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { shouldEnrollBiometrics } from '../../src/auth/setup-capabilities';
import { Page } from '../../src/components/Screen';
import { useTranslation } from '../../src/i18n';
import { authenticateLocally, biometricAvailable } from '../../src/lib/biometrics';
import { readPin } from '../../src/lib/storage';
import { styles } from '../../src/styles';

export default function SecuritySetup() {
  const { t } = useTranslation();
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
          setError(t.biometricCancelled);
          return;
        }
      }
      const pin = await readPin();
      if (pin === null) {
        setError(t.pinUnavailable);
        return;
      }
      await request('/v1/member/security/biometric', {
        method: 'POST',
        body: { pin, biometricEnrolled },
      });
      await refreshSetup();
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t.unknownError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <Text style={styles.title}>{t.securitySetup}</Text>
      <Text style={styles.text}>{t.biometricInstructions}</Text>
      {Platform.OS === 'web' ? <Text style={styles.notice}>{t.browserBiometricNotice}</Text> : null}
      {Platform.OS !== 'web' && !available ? <Text style={styles.muted}>{t.biometricUnavailable}</Text> : null}
      <Pressable disabled={busy} onPress={() => void enroll()} style={styles.button}><Text style={styles.buttonText}>{t.enrolBiometric}</Text></Pressable>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </Page>
  );
}
