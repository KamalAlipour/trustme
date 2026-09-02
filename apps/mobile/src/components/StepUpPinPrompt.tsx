import React, { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { styles } from '../styles';
import { useTranslation } from '../i18n';

export function StepUpPinPrompt({ onResolve }: { onResolve: (pin: string | null) => void }) {
  const { t, direction } = useTranslation();
  const [pin, setPin] = useState('');
  const confirm = () => {
    if (pin.length === 4) onResolve(pin);
  };
  return (
    <Modal visible animationType="slide" onRequestClose={() => onResolve(null)}>
      <View style={[styles.screen, { direction }]}>
        <View style={styles.card}>
          <Text style={styles.heading}>{t.stepUpPinTitle}</Text>
          <TextInput
            value={pin}
            onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))}
            placeholder={t.stepUpPinPlaceholder}
            style={styles.input}
            keyboardType="number-pad"
            secureTextEntry
            autoFocus
          />
          <Pressable
            disabled={pin.length !== 4}
            onPress={confirm}
            style={[styles.button, pin.length !== 4 ? styles.buttonDisabled : null]}
          >
            <Text style={styles.buttonText}>{t.confirmPin}</Text>
          </Pressable>
          <Pressable onPress={() => onResolve(null)} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
