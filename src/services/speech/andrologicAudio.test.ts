import { describe, expect, it } from 'bun:test';
import {
  ANDROLOGIC_SPEECH_SAMPLE_RATE,
  downmixAndResampleToMono,
  encodePcm16Wav,
  prepareAudioForSpeechProvider,
} from './andrologicAudio';

describe('Andrologic speech audio preparation', () => {
  it('downmixes stereo audio and resamples it to 16 kHz', () => {
    const left = new Float32Array(48_000).fill(0.5);
    const right = new Float32Array(48_000).fill(-0.25);
    const samples = downmixAndResampleToMono({
      length: 48_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
      getChannelData: (channel) => channel === 0 ? left : right,
    });

    expect(samples).toHaveLength(ANDROLOGIC_SPEECH_SAMPLE_RATE);
    expect(samples[0]).toBeCloseTo(0.125, 5);
  });

  it('encodes mono PCM16 samples in a valid little-endian WAV container', () => {
    const wav = encodePcm16Wav(new Float32Array([-1, 0, 1]));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (start: number, length: number) =>
      String.fromCharCode(...wav.slice(start, start + length));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32_767);
  });

  it('leaves audio unchanged for non-Andrologic providers', async () => {
    const recorded = {
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      fileName: 'dictation.webm',
    };

    await expect(prepareAudioForSpeechProvider(recorded, 'openai-speech')).resolves.toBe(recorded);
  });
});
