export const MACRO_AI_PROVIDER_ID = 'macro-ai';
export const MACRO_AI_MODEL_ID = 'macro-ai';
export const MACRO_AI_PROVIDER_ICON_PATH = '/providers/andrologic.svg';

export const isMacroAiProvider = (providerId?: string | null): boolean =>
  providerId === MACRO_AI_PROVIDER_ID;
