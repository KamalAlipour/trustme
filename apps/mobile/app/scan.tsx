import React, { useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from '../src/i18n';
import { styles } from '../src/styles';

export default function Scan() {
  const { t, direction } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const { returnTo, field } = useLocalSearchParams<{ returnTo?: string; field?: string }>();
  if (!permission) return <View style={[styles.centered, { direction }]}><Text style={styles.text}>{t.loading}</Text></View>;
  if (!permission.granted) return <View style={[styles.centered, { direction }]}><Text style={styles.text}>{t.cameraPermission}</Text><Button title={t.allow} onPress={() => void requestPermission()} /></View>;
  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : ({ data }) => {
          setScanned(true);
          router.replace({ pathname: (returnTo ?? '/(tabs)') as '/(tabs)' | '/(tabs)/lending' | '/contacts' | '/tether', params: { barcodeId: data, ...(field === undefined ? {} : { field }) } });
        }}
      />
      <View style={{ position: 'absolute', top: 60, left: 20, right: 20 }}><Button title={t.cancel} onPress={() => router.back()} /></View>
    </View>
  );
}
