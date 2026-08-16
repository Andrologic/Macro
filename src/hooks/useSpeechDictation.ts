import { useCallback, useEffect, useRef, useState } from 'react';
import { MicrophoneRecorder } from '../services/speech/microphoneRecorder';
import { useSpeechToTextStore } from '../stores/useSpeechToTextStore';

export type SpeechDictationPhase =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'transcribing';

export type SpeechDictationErrorCode =
  | 'provider-missing'
  | 'provider-disabled'
  | 'api-key-missing'
  | 'permission-denied'
  | 'microphone-missing'
  | 'microphone-unavailable'
  | 'recording-unsupported'
  | 'context-changed'
  | 'empty-transcript'
  | 'transcription-failed';

export interface SpeechDictationError {
  code: SpeechDictationErrorCode;
  detail?: string;
}

interface UseSpeechDictationOptions {
  contextKey: string;
  onTranscript: (text: string) => void;
  onError: (error: SpeechDictationError) => void;
}

const normalizeTranscript = (text: string): string => text.trim();

const classifyMicrophoneError = (error: unknown): SpeechDictationError => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { code: 'permission-denied' };
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return { code: 'microphone-missing' };
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return { code: 'microphone-unavailable' };
    }
  }
  const detail = error instanceof Error ? error.message : undefined;
  if (detail?.includes('not supported')) return { code: 'recording-unsupported' };
  return { code: 'microphone-unavailable', detail };
};

export const useSpeechDictation = ({
  contextKey,
  onTranscript,
  onError,
}: UseSpeechDictationOptions) => {
  const initialize = useSpeechToTextStore((state) => state.initialize);
  const transcribe = useSpeechToTextStore((state) => state.transcribe);
  const [phase, setPhase] = useState<SpeechDictationPhase>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorderRef = useRef<MicrophoneRecorder | null>(null);
  const mountedRef = useRef(true);
  const finishingRef = useRef(false);
  const operationIdRef = useRef(0);
  const operationContextRef = useRef<string | null>(null);
  const contextKeyRef = useRef(contextKey);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationIdRef.current += 1;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    contextKeyRef.current = contextKey;
    if (!operationContextRef.current || operationContextRef.current === contextKey) return;

    operationIdRef.current += 1;
    operationContextRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setElapsedSeconds(0);
    if (phase !== 'transcribing') {
      finishingRef.current = false;
      setPhase('idle');
    }
    onError({ code: 'context-changed' });
  }, [contextKey, onError, phase]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  const finishRecording = useCallback(async () => {
    if (finishingRef.current || !recorderRef.current) return;
    const operationId = operationIdRef.current;
    const operationContext = operationContextRef.current;
    finishingRef.current = true;
    setPhase('transcribing');
    try {
      const recorded = await recorderRef.current.stop();
      recorderRef.current = null;
      const bytes = new Uint8Array(await recorded.blob.arrayBuffer());
      const result = await transcribe({
        audio: bytes,
        mimeType: recorded.mimeType,
        fileName: recorded.fileName,
      });
      const text = normalizeTranscript(result.text);
      if (
        operationId !== operationIdRef.current ||
        operationContext !== contextKeyRef.current
      ) {
        return;
      }
      if (!text) {
        if (mountedRef.current) onError({ code: 'empty-transcript' });
        return;
      }
      if (mountedRef.current) onTranscript(text);
    } catch (error) {
      if (mountedRef.current && operationId === operationIdRef.current) {
        onError({
          code: 'transcription-failed',
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    } finally {
      finishingRef.current = false;
      if (operationId === operationIdRef.current) {
        operationContextRef.current = null;
      }
      if (mountedRef.current) {
        setElapsedSeconds(0);
        setPhase('idle');
      }
    }
  }, [onError, onTranscript, transcribe]);

  const toggle = useCallback(async () => {
    if (phase === 'recording') {
      await finishRecording();
      return;
    }
    if (phase !== 'idle') return;

    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    operationContextRef.current = contextKeyRef.current;
    setPhase('requesting-permission');
    await initialize();
    if (!mountedRef.current || operationId !== operationIdRef.current) return;

    const speechState = useSpeechToTextStore.getState();
    const provider = speechState.providers.find(
      (entry) => entry.id === speechState.selectedProviderId,
    );
    if (!provider) {
      operationContextRef.current = null;
      setPhase('idle');
      onError({ code: 'provider-missing', detail: speechState.error ?? undefined });
      return;
    }
    if (!provider.isEnabled) {
      operationContextRef.current = null;
      setPhase('idle');
      onError({ code: 'provider-disabled' });
      return;
    }
    if (!provider.isLocal && !provider.hasStoredApiKey) {
      operationContextRef.current = null;
      setPhase('idle');
      onError({ code: 'api-key-missing' });
      return;
    }

    const recorder = new MicrophoneRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start(speechState.maxDurationSeconds, () => {
        void finishRecording();
      });
      if (mountedRef.current && operationId === operationIdRef.current) setPhase('recording');
    } catch (error) {
      recorderRef.current = null;
      if (mountedRef.current && operationId === operationIdRef.current) {
        operationContextRef.current = null;
        setPhase('idle');
        onError(classifyMicrophoneError(error));
      }
    }
  }, [finishRecording, initialize, onError, phase]);

  return {
    phase,
    elapsedSeconds,
    toggle,
    isBusy: phase !== 'idle',
  };
};
