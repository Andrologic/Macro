import { isMacroAiSpeechProvider } from '../../config/macroAi';
import type { RecordedAudio } from './microphoneRecorder';

export const ANDROLOGIC_SPEECH_SAMPLE_RATE = 16_000;

interface DecodedAudio {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
}

export const downmixAndResampleToMono = (
  audio: DecodedAudio,
  targetSampleRate = ANDROLOGIC_SPEECH_SAMPLE_RATE,
): Float32Array => {
  if (audio.length === 0 || audio.numberOfChannels === 0) return new Float32Array();
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new Error('The recorded audio has an invalid sample rate.');
  }

  const ratio = audio.sampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(audio.length / ratio));
  const output = new Float32Array(outputLength);
  const channels = Array.from(
    { length: audio.numberOfChannels },
    (_, channel) => audio.getChannelData(channel),
  );

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceStart = outputIndex * ratio;
    const sourceEnd = Math.min(audio.length, (outputIndex + 1) * ratio);

    if (ratio >= 1) {
      const firstSample = Math.floor(sourceStart);
      const lastSample = Math.max(firstSample + 1, Math.ceil(sourceEnd));
      let sum = 0;
      let count = 0;
      for (let sourceIndex = firstSample; sourceIndex < lastSample; sourceIndex += 1) {
        if (sourceIndex >= audio.length) break;
        for (const channel of channels) sum += channel[sourceIndex] ?? 0;
        count += channels.length;
      }
      output[outputIndex] = count > 0 ? sum / count : 0;
      continue;
    }

    const lowerIndex = Math.floor(sourceStart);
    const upperIndex = Math.min(audio.length - 1, lowerIndex + 1);
    const fraction = sourceStart - lowerIndex;
    let sample = 0;
    for (const channel of channels) {
      const lower = channel[lowerIndex] ?? 0;
      const upper = channel[upperIndex] ?? lower;
      sample += lower + (upper - lower) * fraction;
    }
    output[outputIndex] = sample / channels.length;
  }

  return output;
};

export const encodePcm16Wav = (
  samples: Float32Array,
  sampleRate = ANDROLOGIC_SPEECH_SAMPLE_RATE,
): Uint8Array<ArrayBuffer> => {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  samples.forEach((sample, index) => {
    const normalized = Math.max(-1, Math.min(1, sample));
    const pcm = normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff;
    view.setInt16(44 + index * bytesPerSample, Math.round(pcm), true);
  });

  return new Uint8Array(buffer);
};

export const prepareAudioForSpeechProvider = async (
  recorded: RecordedAudio,
  providerId: string,
): Promise<RecordedAudio> => {
  if (!isMacroAiSpeechProvider(providerId)) return recorded;
  if (typeof AudioContext === 'undefined') {
    throw new Error('Audio conversion is unavailable in this environment.');
  }

  const context = new AudioContext();
  try {
    const encoded = await recorded.blob.arrayBuffer();
    const decoded = await context.decodeAudioData(encoded.slice(0));
    const samples = downmixAndResampleToMono(decoded);
    const wav = encodePcm16Wav(samples);
    return {
      blob: new Blob([wav], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      fileName: `macro-dictation-${Date.now()}.wav`,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
};
