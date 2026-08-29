import React, { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { ApiError, request } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { PinPad } from '../../src/components/PinPad';
import { Page } from '../../src/components/Screen';
import { useTranslation } from '../../src/i18n';
import { isWeakPin } from '../../src/lib/pin';
import { savePin } from '../../src/lib/storage';
import { styles } from '../../src/styles';

export default function CreatePin() {
  const { t } = useTranslation();
  const { refreshSetup } = useSession();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (pin !== confirm) {
      setError(t.pinMismatch);
      return;
    }
    if (isWeakPin(pin)) {
      setError(t.weakPin);
      return;
    }
    try {
      await request('/v1/member/security/pin', { method: 'POST', body: { pin } });
      await savePin(pin);
      await refreshSetup();
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t.unknownError);
    }
  };

  return (
    <Page>
      <Text style={styles.title}>{t.createPin}</Text>
      <Text style={styles.muted}>{t.createPinInstructions}</Text>
      <PinPad value={confirming ? confirm : pin} onChange={confirming ? setConfirm : setPin} />
      {confirming ? <Pressable onPress={() => setConfirming(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.editPin}</Text></Pressable> : null}
      {!confirming ? <Pressable disabled={pin.length !== 4} onPress={() => setConfirming(true)} style={styles.button}><Text style={styles.buttonText}>{t.confirmPin}</Text></Pressable> : null}
      {confirming ? <Pressable disabled={confirm.length !== 4} onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{t.continue}</Text></Pressable> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </Page>
  );
}
