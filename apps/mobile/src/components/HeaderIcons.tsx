import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '../i18n';
import { colors } from '../styles';
import { Logo } from './Logo';

export function HeaderIcons({ children }: { children?: React.ReactNode }) {
  const { t, language, setLanguage } = useTranslation();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <Logo size={32} />
      {children}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.language}
        onPress={() => void setLanguage(language === 'fa' ? 'en' : 'fa')}
      >
        <Ionicons name="globe-outline" size={28} color={colors.ink} />
      </Pressable>
    </View>
  );
}
