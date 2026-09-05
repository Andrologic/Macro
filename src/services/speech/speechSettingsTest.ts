import type { SpeechTranscriptionResult } from '../../types';
import type { RecordedAudio } from './microphoneRecorder';

export interface SpeechSettingsTestRecorder {
  start(maxDurationSeconds: number, onAutoStop?: () => void): Promise<void>;
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}

export interface SpeechSettingsTestDependencies {
  recorder: SpeechSettingsTestRecorder;
  prepareAudio: (recorded: RecordedAudio, signal: AbortSignal) => Promise<RecordedAudio>;
  transcribe: (
    recorded: RecordedAudio,
    signal: AbortSignal,
  ) => Promise<SpeechTranscriptionResult>;
}

const abortError = (): Error => {
  const error = new Error('Microphone test cancelled.');
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError();
};

export class SpeechSettingsTestSession {
  private readonly controller = new AbortController();
  private finishPromise: Promise<SpeechTranscriptionResult> | null = null;

  constructor(private readonly dependencies: SpeechSettingsTestDependencies) {}

  async start(maxDurationSeconds: number, onAutoStop?: () => void): Promise<void> {
    throwIfAborted(this.controller.signal);
    await this.dependencies.recorder.start(maxDurationSeconds, onAutoStop);
    throwIfAborted(this.controller.signal);
  }

  finish(): Promise<SpeechTranscriptionResult> {
    this.finishPromise ??= this.runFinish();
    return this.finishPromise;
  }

  private async runFinish(): Promise<SpeechTranscriptionResult> {
    throwIfAborted(this.controller.signal);
    const recorded = await this.dependencies.recorder.stop();
    throwIfAborted(this.controller.signal);
    const prepared = await this.dependencies.prepareAudio(recorded, this.controller.signal);
    throwIfAborted(this.controller.signal);
    const result = await this.dependencies.transcribe(prepared, this.controller.signal);
    throwIfAborted(this.controller.signal);
    if (!result.text.trim()) {
      throw new Error('The transcription test returned no text.');
    }
    return { ...result, text: result.text.trim() };
  }

  cancel(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.dependencies.recorder.cancel();
  }
}
