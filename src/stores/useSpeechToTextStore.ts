import { create } from 'zustand';
import type { SpeechProviderConfig, SpeechTranscriptionResult } from '../types';
import {
  createSpeechProviderConfig,
  deleteSpeechProviderConfig,
  isTauriAvailable,
  listSpeechProviderConfigs,
  transcribeSpeech,
  updateSpeechProviderConfig,
} from '../services/tauriIpc';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';
import { MACRO_AI_SPEECH_PROVIDER_ID } from '../config/macroAi';

interface CreateSpeechProviderInput {
  name: string;
  providerType: 'openai-compatible' | 'deepgram';
  baseUrl: string;
  model: string;
  apiKey?: string;
  isLocal: boolean;
  isEnabled: boolean;
}

interface SpeechToTextState {
  providers: SpeechProviderConfig[];
  selectedProviderId: string | null;
  language: string;
  maxDurationSeconds: number;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  reloadProviders: () => Promise<void>;
  selectProvider: (id: string | null) => Promise<void>;
  setLanguage: (language: string) => Promise<void>;
  setMaxDurationSeconds: (seconds: number) => Promise<void>;
  createProvider: (input: CreateSpeechProviderInput) => Promise<void>;
  updateProvider: (id: string, input: Partial<CreateSpeechProviderInput>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  transcribe: (input: {
    audio: Uint8Array;
    mimeType: string;
    fileName: string;
  }) => Promise<SpeechTranscriptionResult>;
}

let initializePromise: Promise<void> | null = null;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const useSpeechToTextStore = create<SpeechToTextState>((set, get) => ({
  providers: [],
  selectedProviderId: null,
  language: 'auto',
  maxDurationSeconds: 120,
  isInitialized: false,
  isLoading: false,
  error: null,

  initialize: async () => {
    if (get().isInitialized) return;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      set({ isLoading: true, error: null });
      try {
        const [selectedProviderId, language, maxDurationSeconds] = await Promise.all([
          loadPreference<string>(PREF_KEYS.SPEECH_PROVIDER_ID),
          loadPreference<string>(PREF_KEYS.SPEECH_LANGUAGE),
          loadPreference<number>(PREF_KEYS.SPEECH_MAX_DURATION_SECONDS),
        ]);
        const providers = isTauriAvailable() ? await listSpeechProviderConfigs() : [];
        const selectedExists = providers.some(
          (provider) => provider.id === selectedProviderId && provider.isEnabled,
        );
        const nextSelectedProviderId = selectedExists
          ? selectedProviderId
          : providers.find((provider) => provider.isEnabled)?.id ?? null;
        const normalizedDuration = nextSelectedProviderId === MACRO_AI_SPEECH_PROVIDER_ID
          ? Math.min(120, maxDurationSeconds)
          : maxDurationSeconds;
        set({
          providers,
          selectedProviderId: nextSelectedProviderId,
          language,
          maxDurationSeconds: normalizedDuration,
          isInitialized: true,
          isLoading: false,
        });
      } catch (error) {
        set({ error: errorMessage(error, 'Failed to initialize speech-to-text.'), isLoading: false });
      } finally {
        initializePromise = null;
      }
    })();
    return initializePromise;
  },

  reloadProviders: async () => {
    if (!isTauriAvailable()) return;
    const providers = await listSpeechProviderConfigs();
    const selectedProviderId = get().selectedProviderId;
    const selectedIsAvailable = providers.some(
      (provider) => provider.id === selectedProviderId && provider.isEnabled,
    );
    const nextProviderId = selectedIsAvailable
      ? selectedProviderId
      : providers.find((provider) => provider.isEnabled)?.id ?? null;
    set({ providers, selectedProviderId: nextProviderId });
    if (nextProviderId !== selectedProviderId) {
      await savePreference(PREF_KEYS.SPEECH_PROVIDER_ID, nextProviderId ?? '');
    }
  },

  selectProvider: async (id) => {
    const duration = id === MACRO_AI_SPEECH_PROVIDER_ID
      ? Math.min(120, get().maxDurationSeconds)
      : get().maxDurationSeconds;
    set({ selectedProviderId: id, maxDurationSeconds: duration });
    await Promise.all([
      savePreference(PREF_KEYS.SPEECH_PROVIDER_ID, id ?? ''),
      savePreference(PREF_KEYS.SPEECH_MAX_DURATION_SECONDS, duration),
    ]);
  },

  setLanguage: async (language) => {
    set({ language });
    await savePreference(PREF_KEYS.SPEECH_LANGUAGE, language);
  },

  setMaxDurationSeconds: async (seconds) => {
    const maximum = get().selectedProviderId === MACRO_AI_SPEECH_PROVIDER_ID ? 120 : 600;
    const normalized = Math.min(maximum, Math.max(10, Math.round(seconds)));
    set({ maxDurationSeconds: normalized });
    await savePreference(PREF_KEYS.SPEECH_MAX_DURATION_SECONDS, normalized);
  },

  createProvider: async (input) => {
    await createSpeechProviderConfig(input);
    await get().reloadProviders();
  },

  updateProvider: async (id, input) => {
    await updateSpeechProviderConfig({ id, ...input });
    await get().reloadProviders();
  },

  deleteProvider: async (id) => {
    await deleteSpeechProviderConfig(id);
    await get().reloadProviders();
  },

  transcribe: async ({ audio, mimeType, fileName }) => {
    const { selectedProviderId, language, providers } = get();
    const provider = providers.find((entry) => entry.id === selectedProviderId);
    if (!provider) throw new Error('No speech-to-text provider is selected.');
    if (!provider.isEnabled) throw new Error('The selected speech-to-text provider is disabled.');
    if (!provider.isLocal && !provider.hasStoredApiKey) {
      throw new Error('The selected speech-to-text provider requires an API key.');
    }
    return transcribeSpeech({
      providerId: provider.id,
      audio,
      mimeType,
      fileName,
      language,
    });
  },
}));
