export const MACRO_AI_PROVIDER_ID = 'macro-ai';
export const MACRO_AI_DEFAULT_MODEL_ID = 'macro-ai';
export const MACRO_AI_DEEP_MODEL_ID = 'macro-ai-deep';
export const MACRO_AI_PROVIDER_ICON_PATH = '/providers/andrologic.svg';
export const MACRO_AI_SPEECH_PROVIDER_ID = 'andrologic-speech';
export const MACRO_AI_SPEECH_MODEL_ID = 'macro-transcription';

export const isMacroAiProvider = (providerId?: string | null): boolean =>
  providerId === MACRO_AI_PROVIDER_ID;

export const isMacroAiSpeechProvider = (providerId?: string | null): boolean =>
  providerId === MACRO_AI_SPEECH_PROVIDER_ID;
