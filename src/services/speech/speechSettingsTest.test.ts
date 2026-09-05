import { describe, expect, it, mock } from 'bun:test';
import type { RecordedAudio } from './microphoneRecorder';
import { SpeechSettingsTestSession } from './speechSettingsTest';

const recorded: RecordedAudio = {
  blob: new Blob(['audio'], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  fileName: 'test.wav',
};

describe('SpeechSettingsTestSession', () => {
  it('records and returns the fake provider transcription', async () => {
    const recorder = {
      start: mock(async () => undefined),
      stop: mock(async () => recorded),
      cancel: mock(() => undefined),
    };
    const transcribe = mock(async () => ({ text: '  microphone works  ', language: 'en' }));
    const session = new SpeechSettingsTestSession({
      recorder,
      prepareAudio: async (audio) => audio,
      transcribe,
    });

    await session.start(15);
    const firstFinish = session.finish();
    const secondFinish = session.finish();
    expect(secondFinish).toBe(firstFinish);
    await expect(firstFinish).resolves.toEqual({
      text: 'microphone works',
      language: 'en',
    });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('cancels capture and rejects a late fake-provider result', async () => {
    let resolveTranscription!: (value: { text: string }) => void;
    const transcription = new Promise<{ text: string }>((resolve) => {
      resolveTranscription = resolve;
    });
    const recorder = {
      start: mock(async () => undefined),
      stop: mock(async () => recorded),
      cancel: mock(() => undefined),
    };
    const session = new SpeechSettingsTestSession({
      recorder,
      prepareAudio: async (audio) => audio,
      transcribe: async () => transcription,
    });

    await session.start(15);
    const result = session.finish();
    session.cancel();
    resolveTranscription({ text: 'late result' });

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps fake-provider failures available to the caller', async () => {
    const session = new SpeechSettingsTestSession({
      recorder: {
        start: async () => undefined,
        stop: async () => recorded,
        cancel: () => undefined,
      },
      prepareAudio: async (audio) => audio,
      transcribe: async () => {
        throw new Error('Fake provider unavailable');
      },
    });

    await session.start(15);
    await expect(session.finish()).rejects.toThrow('Fake provider unavailable');
  });
});
