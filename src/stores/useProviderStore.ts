import { create } from 'zustand';
import { ProviderConfig, AIProvider, AIModel } from '../types';
import * as tauriIpc from '../services/tauriIpc';
import { fetchModelsFromProvider, testProviderConnection } from '../services/providerApi';

interface ProviderStore {
  // State
  providerConfigs: ProviderConfig[];
  providers: AIProvider[];
  modelsByProvider: Record<string, AIModel[]>;
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
  selectedProviderId: null,
  selectedModelId: null,
  isLoading: false,
  isLoadingModels: false,
  lastError: null,
  connectionStatus: {},

  initialize: async () => {
    const { loadProviderConfigs } = get();
    await loadProviderConfigs();
    
    // Select first enabled provider
    const { providers, fetchModelsForProvider, selectProvider } = get();
    const enabledProvider = providers.find((p) => p.isEnabled);
    if (enabledProvider) {
      selectProvider(enabledProvider.id);
      await fetchModelsForProvider(enabledProvider.id);
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
      } else {
        // Fallback mock providers for development without Tauri
        const mockConfigs: ProviderConfig[] = [
          { id: 'openai', name: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com/v1', isEnabled: true, isLocal: false },
          { id: 'zai', name: 'z.ai', providerType: 'openai', baseUrl: 'https://api.z.ai/v1', isEnabled: true, isLocal: false },
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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load providers';
      set({ isLoading: false, lastError: message });
    }
  },

  fetchModelsForProvider: async (providerId: string) => {
    const { providerConfigs, modelsByProvider } = get();
    const config = providerConfigs.find((c) => c.id === providerId);
    
    if (!config) {
      return [];
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

      if (result.success) {
        const models: AIModel[] = result.models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          provider_id: providerId,
          owned_by: m.owned_by,
        }));

        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: models },
          connectionStatus: { ...state.connectionStatus, [providerId]: 'online' },
          isLoadingModels: false,
          // Auto-select first model if none selected
          selectedModelId: state.selectedModelId || models[0]?.id || null,
        }));

        // Update provider status
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'online' } : p
          ),
        }));

        return models;
      } else {
        set((state) => ({
          connectionStatus: { ...state.connectionStatus, [providerId]: 'offline' },
          isLoadingModels: false,
          lastError: result.error,
        }));

        // Update provider status
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'offline' } : p
          ),
        }));

        return modelsByProvider[providerId] || [];
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch models';
      set((state) => ({
        connectionStatus: { ...state.connectionStatus, [providerId]: 'offline' },
        isLoadingModels: false,
        lastError: message,
      }));
      return modelsByProvider[providerId] || [];
    }
  },

  selectProvider: (providerId: string) => {
    const { providers, fetchModelsForProvider, modelsByProvider } = get();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;

    const cachedModels = modelsByProvider[providerId];
    set({
      selectedProviderId: providerId,
      selectedModelId: cachedModels?.[0]?.id || null,
    });

    // Fetch models if not cached
    if (!cachedModels || cachedModels.length === 0) {
      fetchModelsForProvider(providerId);
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

    const models = modelsByProvider[selectedProviderId] || [];
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
