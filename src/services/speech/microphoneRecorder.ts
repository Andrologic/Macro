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

export class MicrophoneRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private stopPromise: Promise<RecordedAudio> | null = null;
  private resolveStop: ((audio: RecordedAudio) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private extension = 'webm';
  private cancelled = false;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;

  async start(maxDurationSeconds: number, onAutoStop?: () => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Microphone recording is not supported in this environment.');
    }
    if (this.recorder) throw new Error('A microphone recording is already active.');
    this.cancelled = false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16_000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (this.cancelled) {
      this.cleanup();
      throw new Error('Microphone recording cancelled.');
    }
    this.setupAnalyser(this.stream);
    const format = selectRecordingFormat();
    this.extension = format.extension;
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
      this.resolveStop?.({
        blob,
        mimeType,
        fileName: `macro-dictation-${Date.now()}.${this.extension}`,
      });
      this.cleanup();
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

  getAudioLevel(): number {
    if (!this.analyser || !this.analyserData) return 0;
    this.analyser.getByteTimeDomainData(this.analyserData);
    let sumOfSquares = 0;
    for (const sample of this.analyserData) {
      const normalized = (sample - 128) / 128;
      sumOfSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumOfSquares / this.analyserData.length);
    return Math.min(1, rms * 4.5);
  }

  private setupAnalyser(stream: MediaStream): void {
    if (typeof AudioContext === 'undefined') return;
    try {
      this.audioContext = new AudioContext({ sampleRate: 16_000 });
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.72;
      this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
      this.audioContext.createMediaStreamSource(stream).connect(this.analyser);
    } catch {
      if (this.audioContext) void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
      this.analyser = null;
      this.analyserData = null;
    }
  }

  private cleanup(): void {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.audioContext) void this.audioContext.close().catch(() => undefined);
    this.audioContext = null;
    this.analyser = null;
    this.analyserData = null;
    this.recorder = null;
    this.chunks = [];
    this.stopPromise = null;
    this.resolveStop = null;
    this.rejectStop = null;
  }
}
