import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Page } from '../src/components/Screen';
import { markManifestoSeen } from '../src/lib/storage';
import { useTranslation } from '../src/i18n';
import { styles } from '../src/styles';

export default function About() {
  const { t } = useTranslation();
  const dismiss = async () => {
    await markManifestoSeen();
    router.back();
  };
  return (
    <Page>
      <Text style={styles.title}>{t.manifesto.title}</Text>
      <Text style={styles.heading}>{t.manifesto.introTitle}</Text>
      {t.manifesto.intro.map((paragraph) => <Text key={paragraph} style={styles.text}>{paragraph}</Text>)}
      <View style={styles.card}>
        <Text style={styles.heading}>{t.manifesto.credibilityTitle}</Text>
        {t.manifesto.credibility.map((item) => <Text key={item} style={styles.text}>{item}</Text>)}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.manifesto.capabilitiesTitle}</Text>
        {t.manifesto.capabilities.map((item) => <Text key={item} style={styles.text}>{item}</Text>)}
      </View>
      <Text style={styles.text}>{t.manifesto.closing}</Text>
      <Pressable onPress={() => void dismiss()} style={styles.button}><Text style={styles.buttonText}>{t.close}</Text></Pressable>
    </Page>
  );
}
