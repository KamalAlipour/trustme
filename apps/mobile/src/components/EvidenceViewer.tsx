import React from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { useAudioPlayer } from 'expo-audio';
import { API_BASE_URL, getAccessToken } from '../api/client';
import { useTranslation } from '../i18n';
import { isWebPlatform } from '../lib/platform';
import { styles } from '../styles';

type DownloadedEvidence = {
  uri: string;
  mimeType: string;
  byteSize: number;
};

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function formatBytes(bytes: number, t: ReturnType<typeof useTranslation>['t']): string {
  if (bytes < 1024) return t.bytes(bytes);
  if (bytes < 1024 * 1024) return t.kilobytes(Math.round(bytes / 1024));
  return t.megabytes((bytes / (1024 * 1024)).toFixed(1));
}

export function EvidenceViewer({ ids }: { ids: string[] }) {
  const { t } = useTranslation();
  const [downloads, setDownloads] = React.useState<Record<string, DownloadedEvidence>>({});
  const [pending, setPending] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [audioUri, setAudioUri] = React.useState<string | null>(null);
  const player = useAudioPlayer(audioUri);

  const download = async (id: string) => {
    setError('');
    if (isWebPlatform()) {
      setError(t.browserFileSystemUnavailable);
      return;
    }
    const token = getAccessToken();
    const directory = FileSystem.cacheDirectory;
    if (token === null || directory === null) {
      setError(t.evidenceAccessDenied);
      return;
    }
    setPending((current) => current.includes(id) ? current : [...current, id]);
    try {
      const result = await FileSystem.downloadAsync(
        `${API_BASE_URL}/v1/me/media/${encodeURIComponent(id)}`,
        `${directory}evidence-view-${safeFileName(id)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (result.status < 200 || result.status >= 300) throw new Error('download failed');
      const info = await FileSystem.getInfoAsync(result.uri, { size: true });
      if (!info.exists) throw new Error('downloaded file missing');
      setDownloads((current) => ({
        ...current,
        [id]: {
          uri: result.uri,
          mimeType: result.mimeType ?? result.headers['content-type'] ?? 'application/octet-stream',
          byteSize: info.size ?? 0,
        },
      }));
    } catch {
      setError(t.evidenceDownloadFailed);
    } finally {
      setPending((current) => current.filter((item) => item !== id));
    }
  };

  return <View>
    {ids.map((id) => {
      const file = downloads[id];
      const isPending = pending.includes(id);
      return <View key={id} style={styles.card}>
        <View style={styles.row}>
          <Pressable disabled={isPending} onPress={() => void download(id)} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>📎 {id.slice(0, 8)}</Text>
          </Pressable>
          {isPending ? <ActivityIndicator color="#176B87" /> : null}
        </View>
        {file ? <Text style={styles.notice}>{t.evidenceDownloaded} · {file.mimeType} · {formatBytes(file.byteSize, t)}</Text> : null}
        {file?.mimeType.startsWith('image/') ? <Image source={{ uri: file.uri }} style={{ width: 180, height: 180, borderRadius: 12 }} resizeMode="contain" /> : null}
        {file?.mimeType.startsWith('audio/') ? <Pressable onPress={() => { setAudioUri(file.uri); player.replace(file.uri); player.play(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>▶️ {t.playEvidence}</Text></Pressable> : null}
        {file?.mimeType.startsWith('video/') ? <Text style={styles.muted}>{t.videoDownloaded}</Text> : null}
      </View>;
    })}
    {error ? <Text style={styles.danger}>{error}</Text> : null}
  </View>;
}
