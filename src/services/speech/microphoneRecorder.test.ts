import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MicrophoneRecorder } from './microphoneRecorder';

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported = mock((mimeType: string) => mimeType.startsWith('audio/webm'));
  state: RecordingState = 'inactive';
  mimeType: string;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    const dataEvent = new Event('dataavailable') as BlobEvent;
    Object.defineProperty(dataEvent, 'data', {
      value: new Blob(['recording'], { type: this.mimeType }),
    });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event('stop'));
  }
}

describe('MicrophoneRecorder', () => {
  const stopTrack = mock(() => undefined);
  const getUserMedia = mock(async () => ({
    getTracks: () => [{ stop: stopTrack }],
  }) as unknown as MediaStream);
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    stopTrack.mockClear();
    getUserMedia.mockClear();
    FakeMediaRecorder.isTypeSupported.mockClear();
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: originalMediaRecorder,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it('records supported audio and releases the microphone track after stop', async () => {
    const recorder = new MicrophoneRecorder();
    await recorder.start(30);

    const audio = await recorder.stop();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audio.mimeType).toBe('audio/webm;codecs=opus');
    expect(audio.fileName).toEndWith('.webm');
    expect(audio.blob.size).toBeGreaterThan(0);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported environments before requesting permission', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
    const recorder = new MicrophoneRecorder();

    await expect(recorder.start(30)).rejects.toThrow('not supported');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('releases a microphone permission result that arrives after cancellation', async () => {
    let resolvePermission: ((stream: MediaStream) => void) | undefined;
    const delayedGetUserMedia = mock(() => new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: delayedGetUserMedia },
    });
    const recorder = new MicrophoneRecorder();
    const startPromise = recorder.start(30);

    recorder.cancel();
    resolvePermission?.({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);

    await expect(startPromise).rejects.toThrow('cancelled');
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
