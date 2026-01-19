import { create } from 'zustand';
import { AIProvider, AIModel } from '../types';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';

interface AIStore {
  providers: AIProvider[];
  models: AIModel[];
  selectedProviderId: string | null;
  selectedModelId: string | null;
  isLoading: boolean;
  lastError: string | null;
  initialize: () => Promise<void>;
  cycleProvider: () => void;
  cycleModel: () => void;
}

export const useAIStore = create<AIStore>((set, get) => ({
  providers: [],
  models: [],
  selectedProviderId: null,
  selectedModelId: null,
  isLoading: false,
  lastError: null,

  initialize: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const { providers } = await services.listProviders();
      const defaultProviderId = providers[0]?.id ?? null;
      const { models } = await services.listModels(defaultProviderId ?? undefined);
      set({
        providers,
        models,
        selectedProviderId: defaultProviderId,
        selectedModelId: models[0]?.id ?? null,
        isLoading: false,
      });
    } catch (error) {
      const normalized = toServiceError(error);
      set({ isLoading: false, lastError: normalized.message });
    }
  },

  cycleProvider: () => {
    const { providers, selectedProviderId } = get();
    if (providers.length === 0) return;
    const index = providers.findIndex((p) => p.id === selectedProviderId);
    const next = providers[(index + 1) % providers.length];
    set({ selectedProviderId: next.id, selectedModelId: null });
    services
      .listModels(next.id)
      .then(({ models }) =>
        set({ models, selectedModelId: models[0]?.id ?? null })
      )
      .catch(() => undefined);
  },

  cycleModel: () => {
    const { models, selectedModelId } = get();
    if (models.length === 0) return;
    const index = models.findIndex((m) => m.id === selectedModelId);
    const next = models[(index + 1) % models.length];
    set({ selectedModelId: next.id });
  },
}));
