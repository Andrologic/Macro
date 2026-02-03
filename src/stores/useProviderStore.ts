import { create } from 'zustand';
import { ProviderConfig, AIProvider, AIModel, ProviderSettings } from '../types';
import * as tauriIpc from '../services/tauriIpc';
import { fetchModelsFromProvider, testProviderConnection } from '../services/providerApi';

const isZeroPrice = (value?: string | null): boolean => {
  if (value === null || value === undefined) return false;
  const numeric = Number(value);
  return !Number.isNaN(numeric) && numeric === 0;
};

const isFreePricing = (pricing?: { prompt?: string; completion?: string; request?: string }): boolean => {
  if (!pricing) return false;
  const promptFree = isZeroPrice(pricing.prompt);
  const completionFree = isZeroPrice(pricing.completion);
  const requestFree = pricing.request == null ? true : isZeroPrice(pricing.request);
  return promptFree && completionFree && requestFree;
};

const computeIsFreeModel = (model: AIModel): boolean => {
  if (model.id.endsWith(':free')) return true;
  return isFreePricing(model.pricing);
};

const normalizeDbModel = (model: tauriIpc.DbAiModel): AIModel => {
  const normalized: AIModel = {
    id: model.model_id,
    name: model.name,
    provider_id: model.provider_id,
    description: model.description ?? undefined,
    owned_by: model.owned_by ?? undefined,
    pricing: {
      prompt: model.pricing_prompt ?? undefined,
      completion: model.pricing_completion ?? undefined,
      request: model.pricing_request ?? undefined,
    },
    isEnabled: model.is_enabled,
    first_seen_at: model.first_seen_at,
    last_seen_at: model.last_seen_at,
    db_id: model.id,
  };
  return { ...normalized, isFree: computeIsFreeModel(normalized) };
};

const getFirstEnabledModelId = (models: AIModel[]): string | null => {
  const enabled = models.find((m) => m.isEnabled !== false);
  return enabled?.id ?? null;
};

interface ProviderStore {
  // State
  providerConfigs: ProviderConfig[];
  providers: AIProvider[];
  modelsByProvider: Record<string, AIModel[]>;
  providerSettingsById: Record<string, ProviderSettings>;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  isLoading: boolean;
  isLoadingModels: boolean;
  lastError: string | null;
  connectionStatus: Record<string, 'online' | 'offline' | 'checking'>;

  // Actions
  initialize: () => Promise<void>;
  loadProviderConfigs: () => Promise<void>;
  fetchModelsForProvider: (providerId: string) => Promise<AIModel[]>;
  loadProviderModels: (providerId: string) => Promise<AIModel[]>;
  scanModelsForProvider: (providerId: string) => Promise<AIModel[]>;
  setProviderModelEnabled: (providerId: string, modelId: string, enabled: boolean) => Promise<void>;
  setAllProviderModelsEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  loadProviderSettings: (providerId: string) => Promise<ProviderSettings | null>;
  updateProviderSettings: (providerId: string, updates: Partial<ProviderSettings>) => Promise<void>;
  selectProvider: (providerId: string) => void;
  selectModel: (modelId: string) => void;
  cycleProvider: () => void;
  cycleModel: () => void;
  
  // Provider Config CRUD
  updateProviderConfig: (id: string, updates: Partial<ProviderConfig>) => Promise<void>;
  createProviderConfig: (config: Omit<ProviderConfig, 'id'>) => Promise<void>;
  deleteProviderConfig: (id: string) => Promise<void>;
  testConnection: (providerId: string) => Promise<{ success: boolean; message: string }>;
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providerConfigs: [],
  providers: [],
  modelsByProvider: {},
  providerSettingsById: {},
  selectedProviderId: null,
  selectedModelId: null,
  isLoading: false,
  isLoadingModels: false,
  lastError: null,
  connectionStatus: {},

  initialize: async () => {
    const { loadProviderConfigs, loadProviderModels, scanModelsForProvider } = get();
    await loadProviderConfigs();

    const { providerConfigs, providers, selectProvider } = get();
    for (const provider of providerConfigs) {
      await loadProviderModels(provider.id);
      const models = get().modelsByProvider[provider.id] || [];
      if (provider.apiKey && models.length === 0) {
        await scanModelsForProvider(provider.id);
      }
    }

    const enabledProvider = providers.find((p) => p.isEnabled);
    if (enabledProvider) {
      selectProvider(enabledProvider.id);
    }
  },

  loadProviderConfigs: async () => {
    set({ isLoading: true, lastError: null });
    
    try {
      if (tauriIpc.isTauriAvailable()) {
        const configs = await tauriIpc.listProviderConfigs();
        const providerConfigs: ProviderConfig[] = configs.map((c) => ({
          id: c.id,
          name: c.name,
          providerType: c.provider_type,
          baseUrl: c.base_url,
          apiKey: c.api_key || undefined,
          isEnabled: c.is_enabled,
          isLocal: c.is_local,
        }));
        
        const providers: AIProvider[] = providerConfigs.map((c) => ({
          id: c.id,
          name: c.name,
          status: 'offline',
          baseUrl: c.baseUrl,
          isLocal: c.isLocal,
          isEnabled: c.isEnabled,
        }));

        set({ providerConfigs, providers, isLoading: false });

        for (const provider of providerConfigs) {
          get().loadProviderSettings(provider.id);
        }
      } else {
        // Fallback mock providers for development without Tauri
        const mockConfigs: ProviderConfig[] = [
          { id: 'openai', name: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com/v1', isEnabled: true, isLocal: false },
          { id: 'zai', name: 'z.ai', providerType: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', isEnabled: true, isLocal: false },
          { id: 'anthropic', name: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', isEnabled: true, isLocal: false },
          { id: 'openrouter', name: 'OpenRouter', providerType: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', isEnabled: true, isLocal: false },
          { id: 'ollama', name: 'Ollama', providerType: 'ollama', baseUrl: 'http://localhost:11434/v1', isEnabled: true, isLocal: true },
          { id: 'lmstudio', name: 'LM Studio', providerType: 'lmstudio', baseUrl: 'http://localhost:1234/v1', isEnabled: true, isLocal: true },
        ];
        
        const providers: AIProvider[] = mockConfigs.map((c) => ({
          id: c.id,
          name: c.name,
          status: 'offline',
          baseUrl: c.baseUrl,
          isLocal: c.isLocal,
          isEnabled: c.isEnabled,
        }));

        set({ providerConfigs: mockConfigs, providers, isLoading: false });

        for (const provider of mockConfigs) {
          get().loadProviderSettings(provider.id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load providers';
      set({ isLoading: false, lastError: message });
    }
  },

  fetchModelsForProvider: async (providerId: string) => {
    const { loadProviderModels } = get();
    return loadProviderModels(providerId);
  },

  loadProviderModels: async (providerId: string) => {
    const { modelsByProvider } = get();
    if (tauriIpc.isTauriAvailable()) {
      set({ isLoadingModels: true });
      try {
        const models = await tauriIpc.listProviderModels(providerId);
        const normalized = models.map(normalizeDbModel);
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          isLoadingModels: false,
        }));

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId) {
          const selectedExists = normalized.some((m) => m.id === selectedModelId && m.isEnabled !== false);
          if (!selectedExists) {
            set({ selectedModelId: getFirstEnabledModelId(normalized) });
          }
        }

        return normalized;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load models';
        set({ isLoadingModels: false, lastError: message });
        return modelsByProvider[providerId] || [];
      }
    }

    return modelsByProvider[providerId] || [];
  },

  scanModelsForProvider: async (providerId: string) => {
    const { providerConfigs, modelsByProvider } = get();
    const config = providerConfigs.find((c) => c.id === providerId);

    if (!config || !config.apiKey) {
      return modelsByProvider[providerId] || [];
    }

    set({ isLoadingModels: true });
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
    }));

    try {
      const result = await fetchModelsFromProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        providerId: config.providerType,
      });

      if (!result.success) {
        set((state) => ({
          connectionStatus: { ...state.connectionStatus, [providerId]: 'offline' },
          isLoadingModels: false,
          lastError: result.error,
        }));

        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'offline' } : p
          ),
        }));

        return modelsByProvider[providerId] || [];
      }

      if (tauriIpc.isTauriAvailable()) {
        const updated = await tauriIpc.upsertProviderModels({
          providerId,
          models: result.models.map((model) => ({
            model_id: model.id,
            name: model.name || model.id,
            description: model.description ?? null,
            owned_by: model.owned_by ?? null,
            pricing_prompt: model.pricing?.prompt ?? null,
            pricing_completion: model.pricing?.completion ?? null,
            pricing_request: model.pricing?.request ?? null,
          })),
        });

        const normalized = updated.map(normalizeDbModel);
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          connectionStatus: { ...state.connectionStatus, [providerId]: 'online' },
          isLoadingModels: false,
        }));

        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'online' } : p
          ),
        }));

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId) {
          const selectedExists = normalized.some((m) => m.id === selectedModelId && m.isEnabled !== false);
          if (!selectedExists) {
            set({ selectedModelId: getFirstEnabledModelId(normalized) });
          }
        }

        return normalized;
      }

      const models: AIModel[] = result.models.map((m) => {
        const normalized = {
          id: m.id,
          name: m.name || m.id,
          provider_id: providerId,
          owned_by: m.owned_by,
          description: m.description,
          pricing: {
            prompt: m.pricing?.prompt,
            completion: m.pricing?.completion,
            request: m.pricing?.request,
          },
          isEnabled: true,
        } satisfies AIModel;
        return { ...normalized, isFree: computeIsFreeModel(normalized) };
      });

      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: models },
        connectionStatus: { ...state.connectionStatus, [providerId]: 'online' },
        isLoadingModels: false,
      }));

      set((state) => ({
        providers: state.providers.map((p) =>
          p.id === providerId ? { ...p, status: 'online' } : p
        ),
      }));

      return models;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan models';
      set((state) => ({
        connectionStatus: { ...state.connectionStatus, [providerId]: 'offline' },
        isLoadingModels: false,
        lastError: message,
      }));
      return modelsByProvider[providerId] || [];
    }
  },

  setProviderModelEnabled: async (providerId: string, modelId: string, enabled: boolean) => {
    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.setProviderModelEnabled({ providerId, modelId, enabled });
    }

    set((state) => ({
      modelsByProvider: {
        ...state.modelsByProvider,
        [providerId]: (state.modelsByProvider[providerId] || []).map((model) =>
          model.id === modelId ? { ...model, isEnabled: enabled } : model
        ),
      },
    }));

    const { selectedProviderId, selectedModelId, modelsByProvider } = get();
    if (selectedProviderId === providerId) {
      const updatedModels = modelsByProvider[providerId] || [];
      const selected = updatedModels.find((m) => m.id === selectedModelId);
      if (!selected || selected.isEnabled === false) {
        set({ selectedModelId: getFirstEnabledModelId(updatedModels) });
      }
    }
  },

  setAllProviderModelsEnabled: async (providerId: string, enabled: boolean) => {
    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.setAllProviderModelsEnabled({ providerId, enabled });
    }

    set((state) => ({
      modelsByProvider: {
        ...state.modelsByProvider,
        [providerId]: (state.modelsByProvider[providerId] || []).map((model) => ({
          ...model,
          isEnabled: enabled,
        })),
      },
    }));

    const { selectedProviderId, modelsByProvider } = get();
    if (selectedProviderId === providerId) {
      const updatedModels = modelsByProvider[providerId] || [];
      set({ selectedModelId: enabled ? getFirstEnabledModelId(updatedModels) : null });
    }
  },

  loadProviderSettings: async (providerId: string) => {
    if (tauriIpc.isTauriAvailable()) {
      try {
        const settings = await tauriIpc.getProviderSettings(providerId);
        const normalized: ProviderSettings = {
          providerId: settings.provider_id,
          filterFreeModels: settings.filter_free_models,
        };
        set((state) => ({
          providerSettingsById: { ...state.providerSettingsById, [providerId]: normalized },
        }));
        return normalized;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load provider settings';
        set({ lastError: message });
        return null;
      }
    }

    const fallback: ProviderSettings = { providerId, filterFreeModels: false };
    set((state) => ({
      providerSettingsById: { ...state.providerSettingsById, [providerId]: fallback },
    }));
    return fallback;
  },

  updateProviderSettings: async (providerId: string, updates: Partial<ProviderSettings>) => {
    const current = get().providerSettingsById[providerId] ?? {
      providerId,
      filterFreeModels: false,
    };
    const next: ProviderSettings = { ...current, ...updates, providerId };

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.updateProviderSettings({
        providerId,
        filterFreeModels: next.filterFreeModels,
      });
    }

    set((state) => ({
      providerSettingsById: { ...state.providerSettingsById, [providerId]: next },
    }));
  },

  selectProvider: (providerId: string) => {
    const { providers, loadProviderModels, modelsByProvider } = get();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;

    const cachedModels = modelsByProvider[providerId] || [];
    set({
      selectedProviderId: providerId,
      selectedModelId: getFirstEnabledModelId(cachedModels),
    });

    if (cachedModels.length === 0) {
      loadProviderModels(providerId);
    }
  },

  selectModel: (modelId: string) => {
    set({ selectedModelId: modelId });
  },

  cycleProvider: () => {
    const { providers, selectedProviderId, selectProvider } = get();
    const enabledProviders = providers.filter((p) => p.isEnabled);
    if (enabledProviders.length === 0) return;

    const currentIndex = enabledProviders.findIndex((p) => p.id === selectedProviderId);
    const nextIndex = (currentIndex + 1) % enabledProviders.length;
    selectProvider(enabledProviders[nextIndex].id);
  },

  cycleModel: () => {
    const { selectedProviderId, modelsByProvider, selectedModelId } = get();
    if (!selectedProviderId) return;

    const models = (modelsByProvider[selectedProviderId] || []).filter(
      (model) => model.isEnabled !== false
    );
    if (models.length === 0) return;

    const currentIndex = models.findIndex((m) => m.id === selectedModelId);
    const nextIndex = (currentIndex + 1) % models.length;
    set({ selectedModelId: models[nextIndex].id });
  },

  updateProviderConfig: async (id: string, updates: Partial<ProviderConfig>) => {
    try {
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.updateProviderConfig({
          id,
          name: updates.name,
          baseUrl: updates.baseUrl,
          apiKey: updates.apiKey,
          isEnabled: updates.isEnabled,
        });
      }

      // Update local state
      set((state) => ({
        providerConfigs: state.providerConfigs.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
        providers: state.providers.map((p) =>
          p.id === id
            ? {
                ...p,
                name: updates.name ?? p.name,
                baseUrl: updates.baseUrl ?? p.baseUrl,
                isEnabled: updates.isEnabled ?? p.isEnabled,
              }
            : p
        ),
      }));

      if (updates.apiKey && updates.apiKey.trim() !== '') {
        await get().loadProviderModels(id);
        const models = get().modelsByProvider[id] || [];
        if (models.length === 0) {
          await get().scanModelsForProvider(id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update provider';
      set({ lastError: message });
      throw error;
    }
  },

  createProviderConfig: async (config: Omit<ProviderConfig, 'id'>) => {
    try {
      if (tauriIpc.isTauriAvailable()) {
        const created = await tauriIpc.createProviderConfig({
          name: config.name,
          providerType: config.providerType,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          isLocal: config.isLocal,
        });

        const newConfig: ProviderConfig = {
          id: created.id,
          name: created.name,
          providerType: created.provider_type,
          baseUrl: created.base_url,
          apiKey: created.api_key || undefined,
          isEnabled: created.is_enabled,
          isLocal: created.is_local,
        };

        const newProvider: AIProvider = {
          id: created.id,
          name: created.name,
          status: 'offline',
          baseUrl: created.base_url,
          isLocal: created.is_local,
          isEnabled: created.is_enabled,
        };

        set((state) => ({
          providerConfigs: [...state.providerConfigs, newConfig],
          providers: [...state.providers, newProvider],
        }));

        await get().loadProviderSettings(created.id);

        if (newConfig.apiKey) {
          await get().scanModelsForProvider(created.id);
        }
      } else {
        // Mock creation for development
        const id = `provider_${Date.now()}`;
        const newConfig: ProviderConfig = { id, ...config };
        const newProvider: AIProvider = {
          id,
          name: config.name,
          status: 'offline',
          baseUrl: config.baseUrl,
          isLocal: config.isLocal,
          isEnabled: config.isEnabled,
        };

        set((state) => ({
          providerConfigs: [...state.providerConfigs, newConfig],
          providers: [...state.providers, newProvider],
        }));

        if (newConfig.apiKey) {
          await get().scanModelsForProvider(id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create provider';
      set({ lastError: message });
      throw error;
    }
  },

  deleteProviderConfig: async (id: string) => {
    try {
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.deleteProviderConfig(id);
      }

      set((state) => ({
        providerConfigs: state.providerConfigs.filter((c) => c.id !== id),
        providers: state.providers.filter((p) => p.id !== id),
        modelsByProvider: Object.fromEntries(
          Object.entries(state.modelsByProvider).filter(([key]) => key !== id)
        ),
        providerSettingsById: Object.fromEntries(
          Object.entries(state.providerSettingsById).filter(([key]) => key !== id)
        ),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete provider';
      set({ lastError: message });
      throw error;
    }
  },

  testConnection: async (providerId: string) => {
    const { providerConfigs } = get();
    const config = providerConfigs.find((c) => c.id === providerId);
    
    if (!config) {
      return { success: false, message: 'Provider not found' };
    }

    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
    }));

    const result = await testProviderConnection(
      config.baseUrl,
      config.apiKey,
      config.providerType
    );

    set((state) => ({
      connectionStatus: {
        ...state.connectionStatus,
        [providerId]: result.success ? 'online' : 'offline',
      },
      providers: state.providers.map((p) =>
        p.id === providerId
          ? { ...p, status: result.success ? 'online' : 'offline' }
          : p
      ),
    }));

    return result;
  },
}));
