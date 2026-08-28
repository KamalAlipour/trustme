import React from 'react';
import { Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { requestRecordingPermissionsAsync, useAudioPlayer, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { BrowserFileSystemUnavailableError, uploadMedia } from '../api/media';
import type { MediaAsset, MediaKind } from '../api/types';
import { fa } from '../i18n/fa';
import { styles } from '../styles';

type EvidenceItem = { localUri: string; kind: MediaKind; mimeType: string; media: MediaAsset | null; state: 'uploading' | 'ready' | 'failed' };

export function EvidencePicker({ mediaIds, onChange }: { mediaIds: string[]; onChange: (ids: string[]) => void }) {
  const [items, setItems] = React.useState<EvidenceItem[]>([]);
  const [error, setError] = React.useState('');
  const [previewUri, setPreviewUri] = React.useState<string | null>(null);
  const player = useAudioPlayer(previewUri);
  const recorder = useAudioRecorder({
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
    ios: { outputFormat: 'mpeg4', audioQuality: 96 },
  });
  const recorderState = useAudioRecorderState(recorder);

  const upload = async (uri: string, kind: MediaKind, mimeType: string) => {
    setItems((current) => current.some((item) => item.localUri === uri)
      ? current.map((item) => item.localUri === uri ? { ...item, state: 'uploading' } : item)
      : [...current, { localUri: uri, kind, mimeType, media: null, state: 'uploading' }]);
    try {
      const media = await uploadMedia({ uri, kind, mimeType });
      setItems((current) => current.map((item) => item.localUri === uri ? { ...item, media, state: 'ready' } : item));
      onChange(mediaIds.includes(media.id) ? mediaIds : [...mediaIds, media.id]);
    } catch (cause) {
      setItems((current) => current.map((item) => item.localUri === uri ? { ...item, state: 'failed' } : item));
      setError(cause instanceof BrowserFileSystemUnavailableError ? fa.browserFileSystemUnavailable : fa.uploadFailed);
    }
  };

  const pick = async (kind: 'IMAGE' | 'VIDEO', source: 'library' | 'camera') => {
    setError('');
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { setError(source === 'camera' ? fa.cameraPermissionDenied : fa.permissionDenied); return; }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: kind === 'IMAGE' ? ['images'] : ['videos'], quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: kind === 'IMAGE' ? ['images'] : ['videos'], quality: 1 });
    if (!result.canceled && result.assets[0] !== undefined) {
      const asset = result.assets[0];
      await upload(asset.uri, kind, asset.mimeType ?? (kind === 'IMAGE' ? 'image/jpeg' : 'video/mp4'));
    }
  };

  const toggleRecording = async () => {
    setError('');
    if (recorderState.isRecording) {
      await recorder.stop();
      if (recorder.uri !== null) await upload(recorder.uri, 'AUDIO', 'audio/mp4');
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) { setError(fa.permissionDenied); return; }
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const remove = (index: number) => {
    const item = items[index];
    if (item?.media !== null && item?.media !== undefined) onChange(mediaIds.filter((id) => id !== item.media?.id));
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{fa.evidence}</Text>
      <View style={styles.row}>
        <Pressable disabled={items.length >= 10} onPress={() => void toggleRecording()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{recorderState.isRecording ? `${fa.stopRecording} (${Math.floor(recorderState.durationMillis / 1000)} ثانیه)` : fa.captureAudio}</Text></Pressable>
        <Pressable disabled={items.length >= 10} onPress={() => void pick('IMAGE', 'library')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.captureImage}</Text></Pressable>
        <Pressable disabled={items.length >= 10} onPress={() => void pick('VIDEO', 'library')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.captureVideo}</Text></Pressable>
      </View>
      <View style={styles.row}>
        <Pressable disabled={items.length >= 10} onPress={() => void pick('IMAGE', 'camera')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.captureCameraImage}</Text></Pressable>
        <Pressable disabled={items.length >= 10} onPress={() => void pick('VIDEO', 'camera')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.captureCameraVideo}</Text></Pressable>
      </View>
      {items.map((item, index) => <View key={`${item.localUri}-${index}`} style={styles.row}>
        <Text style={item.state === 'failed' ? styles.danger : styles.muted}>{item.state === 'uploading' ? 'در حال بارگذاری…' : item.state === 'failed' ? fa.uploadFailed : 'بارگذاری شد'}</Text>
        {item.kind === 'AUDIO' && item.state === 'ready' ? <Pressable onPress={() => { setPreviewUri(item.localUri); player.replace(item.localUri); player.play(); }}><Text style={styles.secondaryButtonText}>▶️ پخش</Text></Pressable> : null}
        {item.state === 'failed' ? <Pressable onPress={() => void upload(item.localUri, item.kind, item.mimeType)}><Text style={styles.secondaryButtonText}>{fa.retryUpload}</Text></Pressable> : null}
        <Pressable onPress={() => remove(index)}><Text style={styles.secondaryButtonText}>{fa.removeEvidence}</Text></Pressable>
      </View>)}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}
