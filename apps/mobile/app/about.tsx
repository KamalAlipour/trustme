import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Page } from '../src/components/Screen';
import { markManifestoSeen } from '../src/lib/storage';
import { fa } from '../src/i18n/fa';
import { styles } from '../src/styles';

export default function About() {
  const dismiss = async () => {
    await markManifestoSeen();
    router.back();
  };
  return (
    <Page>
      <Text style={styles.title}>{fa.manifesto.title}</Text>
      <Text style={styles.heading}>{fa.manifesto.introTitle}</Text>
      {fa.manifesto.intro.map((paragraph) => <Text key={paragraph} style={styles.text}>{paragraph}</Text>)}
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.manifesto.credibilityTitle}</Text>
        {fa.manifesto.credibility.map((item) => <Text key={item} style={styles.text}>{item}</Text>)}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.manifesto.capabilitiesTitle}</Text>
        {fa.manifesto.capabilities.map((item) => <Text key={item} style={styles.text}>{item}</Text>)}
      </View>
      <View style={styles.card}>
        <Text style={styles.muted}>{fa.manifesto.government.badge}</Text>
        <Text style={styles.heading}>{fa.manifesto.government.title}</Text>
        <Text style={styles.text}>{fa.manifesto.government.lead}</Text>
        {fa.manifesto.government.items.map((item) => (
          <View key={item.title}>
            <Text style={styles.heading}>{item.title}</Text>
            <Text style={styles.text}>{item.body}</Text>
          </View>
        ))}
        <Text style={styles.muted}>{fa.manifesto.government.status}</Text>
      </View>
      <Text style={styles.text}>{fa.manifesto.closing}</Text>
      <Pressable onPress={() => void dismiss()} style={styles.button}><Text style={styles.buttonText}>{fa.close}</Text></Pressable>
    </Page>
  );
}
