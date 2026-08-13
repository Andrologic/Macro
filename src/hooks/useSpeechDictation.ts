import { useCallback, useEffect, useRef, useState } from 'react';
import { MicrophoneRecorder } from '../services/speech/microphoneRecorder';
import { useSpeechToTextStore } from '../stores/useSpeechToTextStore';

export type SpeechDictationPhase =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'transcribing';

interface UseSpeechDictationOptions {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

const normalizeTranscript = (text: string): string => text.trim();

export const useSpeechDictation = ({
  onTranscript,
  onError,
}: UseSpeechDictationOptions) => {
  const initialize = useSpeechToTextStore((state) => state.initialize);
  const transcribe = useSpeechToTextStore((state) => state.transcribe);
  const maxDurationSeconds = useSpeechToTextStore((state) => state.maxDurationSeconds);
  const selectedProviderId = useSpeechToTextStore((state) => state.selectedProviderId);
  const providers = useSpeechToTextStore((state) => state.providers);
  const [phase, setPhase] = useState<SpeechDictationPhase>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorderRef = useRef<MicrophoneRecorder | null>(null);
  const mountedRef = useRef(true);
  const finishingRef = useRef(false);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, []);

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
      if (!text) throw new Error('The speech provider returned an empty transcription.');
      if (mountedRef.current) onTranscript(text);
    } catch (error) {
      if (mountedRef.current) {
        onError(error instanceof Error ? error.message : 'Speech transcription failed.');
      }
    } finally {
      finishingRef.current = false;
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

    const provider = providers.find((entry) => entry.id === selectedProviderId);
    if (!provider) {
      onError('Configure and select a speech-to-text provider first.');
      return;
    }
    if (!provider.isEnabled) {
      onError('The selected speech-to-text provider is disabled.');
      return;
    }
    if (!provider.isLocal && !provider.hasStoredApiKey) {
      onError('Add an API key to the selected speech-to-text provider first.');
      return;
    }

    setPhase('requesting-permission');
    const recorder = new MicrophoneRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start(maxDurationSeconds, () => {
        void finishRecording();
      });
      if (mountedRef.current) setPhase('recording');
    } catch (error) {
      recorderRef.current = null;
      if (mountedRef.current) {
        setPhase('idle');
        onError(error instanceof Error ? error.message : 'Unable to access the microphone.');
      }
    }
  }, [finishRecording, maxDurationSeconds, onError, phase, providers, selectedProviderId]);

  return {
    phase,
    elapsedSeconds,
    toggle,
    isBusy: phase !== 'idle',
  };
};
