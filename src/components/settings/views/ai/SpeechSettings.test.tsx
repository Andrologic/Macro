import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SpeechProviderConfig } from '../../../../types';

let container: HTMLDivElement;
let root: Root | null;
let importCounter = 0;
let transcribeMock: ReturnType<typeof mock>;
let cancelRecorderMock: ReturnType<typeof mock>;

const provider: SpeechProviderConfig = {
  id: 'fake-local',
  name: 'Fake local provider',
  providerType: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9999/v1',
  model: 'fake-transcription',
  hasStoredApiKey: false,
  isEnabled: true,
  isLocal: true,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

const loadSpeechSettings = async ({ autoStopOnStart = false } = {}) => {
  mock.restore();
  transcribeMock = mock(async () => ({ text: 'Fake transcription result' }));
  cancelRecorderMock = mock(() => undefined);

  mock.module('react-i18next', () => ({
    useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
  }));
  mock.module('../../../../stores/useSpeechToTextStore', () => ({
    useSpeechToTextStore: () => ({
      providers: [provider],
      selectedProviderId: provider.id,
      language: 'en',
      maxDurationSeconds: 120,
      enhancementEnabled: false,
      isLoading: false,
      error: null,
      initialize: mock(async () => undefined),
      selectProvider: mock(async () => undefined),
      setLanguage: mock(async () => undefined),
      setMaxDurationSeconds: mock(async () => undefined),
      setEnhancementEnabled: mock(async () => undefined),
      createProvider: mock(async () => undefined),
      updateProvider: mock(async () => undefined),
      deleteProvider: mock(async () => undefined),
      transcribe: transcribeMock,
    }),
  }));
  mock.module('../../../../services/speech/microphoneRecorder', () => ({
    MicrophoneRecorder: class {
      async start(_maxDurationSeconds: number, onAutoStop?: () => void) {
        if (autoStopOnStart) onAutoStop?.();
      }
      async stop() {
        return {
          blob: new Blob(['fake audio'], { type: 'audio/wav' }),
          mimeType: 'audio/wav',
          fileName: 'fake.wav',
        };
      }
      cancel() {
        cancelRecorderMock();
      }
    },
  }));
  mock.module('../../../../services/speech/andrologicAudio', () => ({
    prepareAudioForSpeechProvider: async (recorded: unknown) => recorded,
  }));
  mock.module('../../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));
  mock.module('../../../ui/Switch', () => ({
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: React.InputHTMLAttributes<HTMLInputElement> & {
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...props}
      />
    ),
  }));
  mock.module('../../../ui/ConfirmPromptModal', () => ({ ConfirmPromptModal: () => null }));
  mock.module('../../../ui/toastService', () => ({
    notify: { success: mock(() => undefined), error: mock(() => undefined) },
  }));

  importCounter += 1;
  return import(`./SpeechSettings.tsx?speech-settings-test=${importCounter}`);
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('SpeechSettings microphone test', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    mock.restore();
  });

  it('calls the fake provider only after the user stops the explicit test', async () => {
    const { SpeechSettings } = await loadSpeechSettings();
    await act(async () => {
      root = createRoot(container);
      root.render(<SpeechSettings />);
      await flush();
    });

    const start = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Test microphone',
    );
    await act(async () => {
      start?.click();
      await flush();
    });
    expect(transcribeMock).not.toHaveBeenCalled();

    const stop = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop and transcribe',
    );
    await act(async () => {
      stop?.click();
      await flush();
    });
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Fake transcription result',
    );
  });

  it('cancels capture without calling the fake provider', async () => {
    const { SpeechSettings } = await loadSpeechSettings();
    await act(async () => {
      root = createRoot(container);
      root.render(<SpeechSettings />);
      await flush();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Test microphone',
      )?.click();
      await flush();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Cancel',
      )?.click();
      await flush();
    });

    expect(cancelRecorderMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Microphone test cancelled.');
  });

  it('keeps the automatic stop in transcription instead of returning to recording', async () => {
    const { SpeechSettings } = await loadSpeechSettings({ autoStopOnStart: true });
    await act(async () => {
      root = createRoot(container);
      root.render(<SpeechSettings />);
      await flush();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Test microphone',
      )?.click();
      await flush();
    });

    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Fake transcription result');
    expect(container.textContent).not.toContain('Stop and transcribe');
  });
});
