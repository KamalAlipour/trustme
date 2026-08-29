import React, { useEffect, useRef } from 'react';
import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { Page } from '../components/Screen';
import { useTranslation } from '../i18n';
import { useSession } from './session';
import { styles } from '../styles';

export function UnlockScreen() {
  const { t } = useTranslation();
  const { unlock, unlocking, unlockError, continueWithPhoneLogin } = useSession();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current || unlocking) return;
    attempted.current = true;
    void unlock();
  }, [unlock, unlocking]);

  const signInWithPhone = async () => {
    await continueWithPhoneLogin();
    router.replace('/(auth)/login');
  };

  return (
    <Page>
      <Text style={styles.title}>{t.unlockTitle}</Text>
      <Text style={styles.text}>{t.unlockInstructions}</Text>
      {unlockError ? <Text style={styles.danger}>{t.unlockFailed}</Text> : null}
      <Pressable disabled={unlocking} onPress={() => void unlock()} style={styles.button}>
        <Text style={styles.buttonText}>{unlocking ? t.loading : t.unlockRetry}</Text>
      </Pressable>
      <Pressable disabled={unlocking} onPress={() => void signInWithPhone()} style={styles.secondaryButton}>
        <Text style={styles.secondaryButtonText}>{t.signInWithPhonePin}</Text>
      </Pressable>
    </Page>
  );
}
