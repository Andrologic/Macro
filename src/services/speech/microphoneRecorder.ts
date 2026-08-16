export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  fileName: string;
}

const MIME_CANDIDATES = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4', extension: 'mp4' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
] as const;

const selectRecordingFormat = (): { mimeType: string; extension: string } => {
  const match = MIME_CANDIDATES.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType));
  return match ?? { mimeType: '', extension: 'webm' };
};

const WAV_SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;

const encodeMonoPcm16Wav = (
  channels: Float32Array[],
  sourceSampleRate: number,
  targetSampleRate = WAV_SAMPLE_RATE,
): Blob => {
  if (channels.length === 0 || channels[0]!.length === 0) {
    throw new Error('The microphone recording is empty.');
  }
  if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
    throw new Error('The microphone recording has an invalid sample rate.');
  }

  const sourceLength = Math.min(...channels.map((channel) => channel.length));
  const sampleCount = Math.max(1, Math.floor(sourceLength * targetSampleRate / sourceSampleRate));
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + sampleCount * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, sampleCount * 2, true);

  const sourceStep = sourceSampleRate / targetSampleRate;
  for (let index = 0; index < sampleCount; index += 1) {
    const sourcePosition = index * sourceStep;
    const leftIndex = Math.min(sourceLength - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(sourceLength - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    let sample = 0;
    for (const channel of channels) {
      sample += channel[leftIndex]! + (channel[rightIndex]! - channel[leftIndex]!) * fraction;
    }
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(
      WAV_HEADER_BYTES + index * 2,
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
      true,
    );
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

const convertRecordingToWav = async (recording: Blob): Promise<Blob> => {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index),
    );
    return encodeMonoPcm16Wav(channels, decoded.sampleRate);
  } finally {
    await context.close();
  }
};

export class MicrophoneRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private stopPromise: Promise<RecordedAudio> | null = null;
  private resolveStop: ((audio: RecordedAudio) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  async start(maxDurationSeconds: number, onAutoStop?: () => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Microphone recording is not supported in this environment.');
    }
    if (this.recorder) throw new Error('A microphone recording is already active.');
    this.cancelled = false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (this.cancelled) {
      this.cleanup();
      throw new Error('Microphone recording cancelled.');
    }
    const format = selectRecordingFormat();
    this.chunks = [];
    try {
      this.recorder = format.mimeType
        ? new MediaRecorder(this.stream, { mimeType: format.mimeType })
        : new MediaRecorder(this.stream);
    } catch (error) {
      this.cleanup();
      throw error;
    }
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.addEventListener('error', () => {
      this.rejectStop?.(new Error('The microphone recording failed.'));
      this.cleanup();
    });
    this.recorder.addEventListener('stop', () => {
      const mimeType = this.recorder?.mimeType || format.mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type: mimeType });
      void convertRecordingToWav(blob)
        .then((wav) => {
          const resolve = this.resolveStop;
          this.cleanup();
          resolve?.({
            blob: wav,
            mimeType: 'audio/wav',
            fileName: `macro-dictation-${Date.now()}.wav`,
          });
        })
        .catch((error: unknown) => {
          const reject = this.rejectStop;
          this.cleanup();
          reject?.(
            error instanceof Error ? error : new Error('The microphone recording could not be decoded.'),
          );
        });
    });
    this.stopPromise = new Promise<RecordedAudio>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    try {
      this.recorder.start(250);
    } catch (error) {
      this.cleanup();
      throw error;
    }
    this.maxDurationTimer = setTimeout(() => {
      if (this.recorder?.state === 'recording') {
        if (onAutoStop) onAutoStop();
        else this.recorder.stop();
      }
    }, Math.max(10, maxDurationSeconds) * 1000);
  }

  async stop(): Promise<RecordedAudio> {
    if (!this.recorder || !this.stopPromise) {
      throw new Error('No microphone recording is active.');
    }
    const result = this.stopPromise;
    if (this.recorder.state === 'recording') this.recorder.stop();
    return result;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.recorder?.state === 'recording') {
      this.recorder.stop();
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.stopPromise = null;
    this.resolveStop = null;
    this.rejectStop = null;
  }
}
