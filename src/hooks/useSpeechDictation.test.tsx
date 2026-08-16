import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SpeechProviderConfig } from '../types';

const startRecording = mock(async () => undefined);
const cancelRecording = mock(() => undefined);
const stopRecording = mock(async () => ({
  blob: new Blob(['audio']),
  mimeType: 'audio/webm',
  fileName: 'dictation.webm',
}));

class FakeMicrophoneRecorder {
  start = startRecording;
  stop = stopRecording;
  cancel = cancelRecording;
}

const provider: SpeechProviderConfig = {
  id: 'speech-provider',
  name: 'Speech provider',
  providerType: 'openai-compatible',
  baseUrl: 'https://speech.example.com/v1',
  model: 'whisper-1',
  hasStoredApiKey: true,
  isEnabled: true,
  isLocal: false,
  createdAt: 'now',
  updatedAt: 'now',
};

describe('useSpeechDictation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let useSpeechDictation: typeof import('./useSpeechDictation').useSpeechDictation;
  let useSpeechToTextStore: typeof import('../stores/useSpeechToTextStore').useSpeechToTextStore;
  let currentHook: ReturnType<typeof useSpeechDictation> | null = null;
  let onError = mock((_error: unknown) => undefined);
  let onTranscript = mock((_text: string) => undefined);

  const Harness: React.FC<{ contextKey: string }> = ({ contextKey }) => {
    currentHook = useSpeechDictation({ contextKey, onError, onTranscript });
    return <span>{currentHook.phase}</span>;
  };

  beforeAll(async () => {
    mock.module('../services/speech/microphoneRecorder', () => ({
      MicrophoneRecorder: FakeMicrophoneRecorder,
    }));
    ({ useSpeechDictation } = await import(`./useSpeechDictation.ts?test=${Date.now()}`));
    ({ useSpeechToTextStore } = await import('../stores/useSpeechToTextStore'));
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    currentHook = null;
    onError = mock((_error: unknown) => undefined);
    onTranscript = mock((_text: string) => undefined);
    startRecording.mockClear();
    stopRecording.mockClear();
    cancelRecording.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  afterAll(() => {
    mock.restore();
  });

  it('waits for provider initialization before starting the recorder', async () => {
    let releaseInitialization: (() => void) | undefined;
    const initialization = new Promise<void>((resolve) => {
      releaseInitialization = () => {
        useSpeechToTextStore.setState({
          providers: [provider],
          selectedProviderId: provider.id,
          isInitialized: true,
        });
        resolve();
      };
    });
    useSpeechToTextStore.setState({
      providers: [],
      selectedProviderId: null,
      isInitialized: false,
      error: null,
      initialize: mock(() => initialization),
      transcribe: mock(async () => ({ text: 'Bonjour' })),
    });

    await act(async () => {
      root.render(<Harness contextKey="conversation:a" />);
    });
    await act(async () => {
      const toggle = currentHook?.toggle;
      const togglePromise = toggle?.();
      await Promise.resolve();
      expect(startRecording).not.toHaveBeenCalled();
      releaseInitialization?.();
      await togglePromise;
    });

    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(currentHook?.phase).toBe('recording');

  });

  it('cancels an active recording when the composer context changes', async () => {
    useSpeechToTextStore.setState({
      providers: [provider],
      selectedProviderId: provider.id,
      isInitialized: true,
      error: null,
      initialize: mock(async () => undefined),
      transcribe: mock(async () => ({ text: 'Bonjour' })),
    });

    await act(async () => {
      root.render(<Harness contextKey="conversation:a" />);
    });
    await act(async () => {
      await currentHook?.toggle();
    });
    await act(async () => {
      root.render(<Harness contextKey="conversation:b" />);
    });

    expect(cancelRecording).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ code: 'context-changed' });
    expect(currentHook?.phase).toBe('idle');

  });

  it('does not insert a transcript after the composer context changes', async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    const transcription = new Promise<{ text: string }>((resolve) => {
      resolveTranscription = resolve;
    });
    useSpeechToTextStore.setState({
      providers: [provider],
      selectedProviderId: provider.id,
      isInitialized: true,
      error: null,
      initialize: mock(async () => undefined),
      transcribe: mock(() => transcription),
    });

    await act(async () => {
      root.render(<Harness contextKey="conversation:a" />);
    });
    await act(async () => {
      await currentHook?.toggle();
    });

    let finishPromise: Promise<void> | undefined;
    await act(async () => {
      finishPromise = currentHook?.toggle();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Harness contextKey="conversation:b" />);
    });
    await act(async () => {
      resolveTranscription?.({ text: 'Texte du mauvais contexte' });
      await finishPromise;
    });

    expect(onError).toHaveBeenCalledWith({ code: 'context-changed' });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(currentHook?.phase).toBe('idle');
  });
});
