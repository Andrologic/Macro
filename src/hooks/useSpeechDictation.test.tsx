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
const enhanceTranscript = mock(async ({ transcript }: { transcript: string }) => transcript);

class FakeMicrophoneRecorder {
  start = startRecording;
  stop = stopRecording;
  cancel = cancelRecording;
  getAudioLevel = () => 0.35;
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
  let onTranscript = mock((_text: string, _completion: 'insert' | 'send') => undefined);
  let onEnhancementError = mock((_detail?: string) => undefined);

  const Harness: React.FC<{ contextKey: string }> = ({ contextKey }) => {
    currentHook = useSpeechDictation({
      contextKey,
      enhancementContext: {
        mode: 'Chat',
        projectName: 'Macro',
        recentMessages: [{ role: 'user', content: 'Contexte récent' }],
      },
      onError,
      onTranscript,
      onEnhancementError,
      enhanceTranscript,
    });
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
    onTranscript = mock((_text: string, _completion: 'insert' | 'send') => undefined);
    onEnhancementError = mock((_detail?: string) => undefined);
    useSpeechToTextStore.setState({
      enhancementEnabled: false,
      enhancementModelConfig: { mode: 'conversation' },
    });
    startRecording.mockClear();
    stopRecording.mockClear();
    cancelRecording.mockClear();
    enhanceTranscript.mockClear();
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

  it('starts Andrologic dictation without requiring a user API key', async () => {
    const managedProvider = {
      ...provider,
      id: 'andrologic-speech',
      name: 'Andrologic',
      model: 'macro-transcription',
      hasStoredApiKey: false,
    };
    useSpeechToTextStore.setState({
      providers: [managedProvider],
      selectedProviderId: managedProvider.id,
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

    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(currentHook?.phase).toBe('recording');
  });

  it('forwards the send intent with the completed transcript', async () => {
    useSpeechToTextStore.setState({
      providers: [provider],
      selectedProviderId: provider.id,
      isInitialized: true,
      error: null,
      initialize: mock(async () => undefined),
      transcribe: mock(async () => ({ text: '  Message vocal  ' })),
    });

    await act(async () => {
      root.render(<Harness contextKey="conversation:a" />);
    });
    await act(async () => {
      await currentHook?.toggle();
      await currentHook?.finish('send');
    });

    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('Message vocal', 'send');
    expect(currentHook?.phase).toBe('idle');
    expect(currentHook?.completion).toBeNull();
  });

  it('improves the transcript before forwarding it when cleanup is enabled', async () => {
    enhanceTranscript.mockResolvedValueOnce('Message vocal corrigé');
    useSpeechToTextStore.setState({
      providers: [provider],
      selectedProviderId: provider.id,
      isInitialized: true,
      error: null,
      enhancementEnabled: true,
      enhancementModelConfig: { mode: 'conversation' },
      initialize: mock(async () => undefined),
      transcribe: mock(async () => ({ text: 'Message vocale corrige' })),
    });

    await act(async () => {
      root.render(<Harness contextKey="conversation:a" />);
    });
    await act(async () => {
      await currentHook?.toggle();
      await currentHook?.finish('insert');
    });

    expect(enhanceTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('Message vocal corrigé', 'insert');
    expect(onEnhancementError).not.toHaveBeenCalled();
  });

  it('keeps the raw transcript when smart cleanup fails', async () => {
    enhanceTranscript.mockRejectedValueOnce(new Error('Model unavailable'));
    useSpeechToTextStore.setState({
      providers: [provider],
      selectedProviderId: provider.id,
      isInitialized: true,
      error: null,
      enhancementEnabled: true,
      enhancementModelConfig: { mode: 'conversation' },
      initialize: mock(async () => undefined),
      transcribe: mock(async () => ({ text: 'Texte brut conservé' })),
    });

    await act(async () => {
      root.render(<Harness contextKey="conversation:a" />);
    });
    await act(async () => {
      await currentHook?.toggle();
      await currentHook?.finish('send');
    });

    expect(onEnhancementError).toHaveBeenCalledWith('Model unavailable');
    expect(onTranscript).toHaveBeenCalledWith('Texte brut conservé', 'send');
    expect(onError).not.toHaveBeenCalled();
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
