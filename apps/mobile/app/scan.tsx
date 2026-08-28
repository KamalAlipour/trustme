import React, { useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { fa } from '../src/i18n/fa';
import { styles } from '../src/styles';

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  if (!permission) return <View style={styles.centered}><Text style={styles.text}>{fa.loading}</Text></View>;
  if (!permission.granted) return <View style={styles.centered}><Text style={styles.text}>دسترسی دوربین لازم است.</Text><Button title="اجازه" onPress={() => void requestPermission()} /></View>;
  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : ({ data }) => {
          setScanned(true);
          router.replace({ pathname: (returnTo ?? '/(tabs)') as '/(tabs)' | '/contacts', params: { barcodeId: data } });
        }}
      />
      <View style={{ position: 'absolute', top: 60, start: 20, end: 20 }}><Button title="لغو" onPress={() => router.back()} /></View>
    </View>
  );
}
