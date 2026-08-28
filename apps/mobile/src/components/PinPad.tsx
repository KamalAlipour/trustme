import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { styles } from '../styles';
import { useTranslation } from '../i18n';

export function PinPad({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit?: () => void }) {
  const { t } = useTranslation();
  const press = (digit: string) => {
    if (value.length < 4) onChange(value + digit);
  };
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.heading}>{t.pin}</Text>
      <Text style={{ ...styles.title, textAlign: 'center', letterSpacing: 12 }}>{'●'.repeat(value.length).padEnd(4, '○')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', t.cancel, '0', t.verify].map((digit) => (
          <Pressable
            key={digit}
            onPress={() => digit === t.cancel ? onChange(value.slice(0, -1)) : digit === t.verify ? onSubmit?.() : press(digit)}
            style={{ width: 72, height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D8E1E7' }}
          >
            <Text style={styles.text}>{digit}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
