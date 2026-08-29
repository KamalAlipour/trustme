import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { BrowserFileSystemUnavailableError, uploadMedia } from '../api/media';
import { useTranslation } from '../i18n';
import { styles } from '../styles';

type Props = {
  documentAssetId: string | null;
  selfieAssetId: string | null;
  onDocumentChange: (id: string | null) => void;
  onSelfieChange: (id: string | null) => void;
};

export function IdentityReviewPicker({ documentAssetId, selfieAssetId, onDocumentChange, onSelfieChange }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const pick = async (target: 'document' | 'selfie', source: 'library' | 'camera') => {
    setError('');
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(source === 'camera' ? t.cameraPermissionDenied : t.permissionDenied);
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || result.assets[0] === undefined) return;
    try {
      const asset = result.assets[0];
      const uploaded = await uploadMedia({ uri: asset.uri, kind: 'IMAGE', mimeType: asset.mimeType ?? 'image/jpeg' }, t);
      if (target === 'document') onDocumentChange(uploaded.id);
      else onSelfieChange(uploaded.id);
    } catch (cause) {
      setError(cause instanceof BrowserFileSystemUnavailableError ? t.browserFileSystemUnavailable : t.uploadFailed);
    }
  };
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{t.manualReviewDocuments}</Text>
      <View style={styles.row}>
        <Pressable onPress={() => void pick('document', 'library')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.selectGovernmentId}</Text></Pressable>
        <Pressable onPress={() => void pick('document', 'camera')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.captureGovernmentId}</Text></Pressable>
      </View>
      <Text style={documentAssetId ? styles.text : styles.muted}>{documentAssetId ? t.photoUploaded : t.photoRequired}</Text>
      <View style={styles.row}>
        <Pressable onPress={() => void pick('selfie', 'library')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.selectSelfie}</Text></Pressable>
        <Pressable onPress={() => void pick('selfie', 'camera')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.captureSelfie}</Text></Pressable>
      </View>
      <Text style={selfieAssetId ? styles.text : styles.muted}>{selfieAssetId ? t.photoUploaded : t.photoRequired}</Text>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}
