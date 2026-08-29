import React, { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ApiError, request } from '../api/client';
import { uploadMedia } from '../api/media';
import { useTranslation } from '../i18n';
import { styles } from '../styles';
import { IDENTITY_CAPTURE_STEPS, isIdentityCaptureSessionUnavailable, parseIdentityCaptureSession, type IdentityCaptureSession, type IdentityCaptureStep } from '../lib/identity-capture';

type Props = { onSubmitted: () => Promise<void> };

const promptFor = (step: IdentityCaptureStep, t: ReturnType<typeof useTranslation>['t']): string => ({
  DOCUMENT_FRONT: t.identityCaptureDocumentFront,
  SELFIE_NEUTRAL: t.identityCaptureSelfieNeutral,
  SELFIE_TURNED: t.identityCaptureSelfieTurned,
  SELFIE_WITH_DOCUMENT: t.identityCaptureSelfieWithDocument,
}[step]);

export function LiveIdentityCapture({ onSubmitted }: Props) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [session, setSession] = useState<IdentityCaptureSession | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [starting, setStarting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [captured, setCaptured] = useState<Set<IdentityCaptureStep>>(new Set());

  const currentStep = session?.steps[stepIndex];
  const startSession = async () => {
    setStarting(true);
    setSession(null);
    setStepIndex(0);
    setCaptured(new Set());
    setError('');
    try {
      const value = await request('/v1/me/identity/live-capture-session', { method: 'POST' });
      const parsed = parseIdentityCaptureSession(value);
      if (parsed === null) throw new Error('invalid identity capture session');
      setSession(parsed);
    } catch (cause: unknown) {
      setError(cause instanceof ApiError ? cause.message : t.identityCaptureError);
    } finally {
      setStarting(false);
    }
  };
  const resetExpiredSession = () => {
    setSession(null);
    setStepIndex(0);
    setCaptured(new Set());
    setError(t.identityCaptureSessionExpired);
  };
  const capture = async () => {
    if (session === null || currentStep === undefined || camera.current === null) return;
    setError('');
    setCapturing(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 1 });
      if (photo?.uri === undefined) throw new Error('camera did not return a photo');
      await uploadMedia({ uri: photo.uri, kind: 'IMAGE', mimeType: 'image/jpeg', captureSessionId: session.id, step: currentStep }, t);
      setCaptured((previous) => new Set(previous).add(currentStep));
      setStepIndex((index) => index + 1);
    } catch (cause) {
      if (isIdentityCaptureSessionUnavailable(cause)) {
        resetExpiredSession();
      } else {
        setError(cause instanceof ApiError ? cause.message : t.uploadFailed);
      }
    } finally {
      setCapturing(false);
    }
  };
  const submit = async () => {
    if (session === null || captured.size !== IDENTITY_CAPTURE_STEPS.length) return;
    setError('');
    setSubmitting(true);
    try {
      await request('/v1/me/identity/manual-review', { method: 'POST', body: { captureSessionId: session.id } });
      await onSubmitted();
    } catch (cause) {
      if (isIdentityCaptureSessionUnavailable(cause)) {
        resetExpiredSession();
      } else {
        setError(cause instanceof ApiError ? cause.message : t.unknownError);
      }
    } finally {
      setSubmitting(false);
    }
  };
  if (session === null) return <View style={styles.card}>
    <Text style={styles.heading}>{t.identityCaptureTitle}</Text>
    <Text style={styles.text}>{t.identityCaptureDescription}</Text>
    {error ? <Text style={styles.danger}>{error}</Text> : null}
    <Pressable disabled={starting} onPress={() => void startSession()} style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{starting ? t.identityCaptureStarting : error ? t.identityCaptureRestart : t.identityCaptureStart}</Text>
    </Pressable>
  </View>;
  if (!permission?.granted) {
    return <View style={styles.card}>
      <Text style={styles.text}>{t.identityCaptureCameraRequired}</Text>
      <Pressable onPress={() => void requestPermission()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.allow}</Text></Pressable>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>;
  }
  return <View style={styles.card}>
    <Text style={styles.heading}>{t.identityCaptureTitle}</Text>
    {currentStep === undefined ? <Text style={styles.text}>{t.identityCaptureReady}</Text> : <>
      <Text style={styles.text}>{t.identityCaptureStep(stepIndex + 1, session.steps.length)}: {promptFor(currentStep, t)}</Text>
      {currentStep === 'SELFIE_WITH_DOCUMENT' ? <Text style={styles.notice}>{t.identityCaptureChallenge(session.challengeCode)}</Text> : null}
      <CameraView ref={camera} style={styles.cameraPreview} facing={currentStep === 'DOCUMENT_FRONT' ? 'back' : 'front'} />
      <Pressable disabled={capturing} onPress={() => void capture()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{capturing ? t.identityCaptureUploading : t.identityCaptureCapture}</Text></Pressable>
    </>}
    {captured.size === IDENTITY_CAPTURE_STEPS.length ? <Pressable disabled={submitting} onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{submitting ? t.identityCaptureSubmitting : t.submitManualReview}</Text></Pressable> : null}
    {error ? <Text style={styles.danger}>{error}</Text> : null}
  </View>;
}
