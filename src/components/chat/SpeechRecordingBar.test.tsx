import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SpeechRecordingBar } from './SpeechRecordingBar';

describe('SpeechRecordingBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('offers separate insert and immediate-send actions while recording', async () => {
    const onStop = mock(() => undefined);
    const onSend = mock(() => undefined);
    await act(async () => {
      root.render(
        <SpeechRecordingBar
          phase="recording"
          completion={null}
          elapsedSeconds={6}
          getAudioLevel={() => 0.4}
          recordingLabel="Recording"
          transcribingLabel="Transcribing"
          stopLabel="Stop and insert transcription"
          sendLabel="Stop, transcribe and send"
          onStop={onStop}
          onSend={onSend}
        />,
      );
    });

    expect(container.textContent).toContain('0:06');
    const stopButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop and insert transcription"]',
    );
    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop, transcribe and send"]',
    );
    expect(stopButton).not.toBeNull();
    expect(sendButton).not.toBeNull();
    expect(stopButton?.className).toContain('rounded-lg');
    expect(sendButton?.className).toContain('rounded-lg');
    expect(stopButton?.className).not.toContain('rounded-full');
    expect(sendButton?.className).not.toContain('rounded-full');

    await act(async () => {
      stopButton?.click();
      sendButton?.click();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('locks both actions while transcription is processing', async () => {
    await act(async () => {
      root.render(
        <SpeechRecordingBar
          phase="transcribing"
          completion="send"
          elapsedSeconds={12}
          getAudioLevel={() => 0}
          recordingLabel="Recording"
          transcribingLabel="Transcribing"
          stopLabel="Stop and insert transcription"
          sendLabel="Stop, transcribe and send"
          onStop={() => undefined}
          onSend={() => undefined}
        />,
      );
    });

    expect(container.querySelectorAll('button:disabled')).toHaveLength(2);
    expect(container.textContent).toContain('0:12');
  });
});
