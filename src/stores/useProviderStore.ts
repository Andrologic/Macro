import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ProviderConfig, AIProvider, AIModel, ProviderSettings } from '../types';
import * as tauriIpc from '../services/tauriIpc';
import { fetchModelsFromProvider, testProviderConnection } from '../services/providerApi';
import { findProviderConfig, loadAIConfigFile } from '../services/aiConfig';
import { loadPreference, PREF_KEYS } from '../services/preferences';
import { AppMode } from '../types';
import { useAppStore } from './useAppStore';

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

const NATIVE_TOOL_CALLING_PROVIDER_TYPES = new Set(['chatgpt', 'openai', 'openrouter']);

const supportsNativeToolCallingForProviderType = (providerType?: string | null): boolean =>
  !!providerType && NATIVE_TOOL_CALLING_PROVIDER_TYPES.has(providerType);

const applyNativeToolCallingToProviderConfig = (config: ProviderConfig): ProviderConfig => ({
  ...config,
  nativeToolCalling: supportsNativeToolCallingForProviderType(config.providerType),
});

const applyNativeToolCallingToProvider = (provider: AIProvider, providerType?: string): AIProvider => ({
  ...provider,
  nativeToolCalling: supportsNativeToolCallingForProviderType(providerType),
});

const normalizeDbModel = (model: tauriIpc.DbAiModel, providerType?: string): AIModel => {
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
    isManual: model.is_manual,
    first_seen_at: model.first_seen_at,
    last_seen_at: model.last_seen_at,
    db_id: model.id,
    nativeToolCalling: supportsNativeToolCallingForProviderType(providerType),
  };
  return { ...normalized, isFree: computeIsFreeModel(normalized) };
};

const getFirstEnabledModelId = (models: AIModel[]): string | null => {
  const enabled = models.find((m) => m.isEnabled !== false);
  return enabled?.id ?? null;
};

const getFirstUsableProvider = (providerConfigs: ProviderConfig[]): ProviderConfig | null => {
  return providerConfigs.find((provider) => providerHasCredentials(provider)) ?? null;
};

type AISelectionModeKey = 'ChatDebug' | 'Architect' | 'Implement';

interface PersistedAISelection {
  providerId: string | null;
  modelId: string | null;
  updatedAt: string;
}

interface PersistedAIContextSelections {
  version: 1;
  modeSelections: Partial<Record<AISelectionModeKey, PersistedAISelection>>;
}

const getSelectionModeKey = (mode: AppMode): AISelectionModeKey => {
  if (mode === 'Chat' || mode === 'Debug') return 'ChatDebug';
  if (mode === 'Architect') return 'Architect';
  return 'Implement';
};

const normalizePersistedSelection = (value: unknown): PersistedAISelection | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { providerId?: unknown; modelId?: unknown; updatedAt?: unknown };
  if (typeof candidate.providerId !== 'string' || !candidate.providerId.trim()) return null;
  if (typeof candidate.modelId !== 'string' || !candidate.modelId.trim()) return null;

  return {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    updatedAt:
      typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
};

const getModeSelectionFromPreference = (
  value: unknown,
  mode: AppMode
): PersistedAISelection | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as PersistedAIContextSelections;
  const modeSelections = raw.modeSelections;
  if (!modeSelections || typeof modeSelections !== 'object') return null;
  return normalizePersistedSelection(modeSelections[getSelectionModeKey(mode)]);
};

const providerHasAuthSession = (provider: ProviderConfig): boolean => {
  if (provider.providerType !== 'chatgpt') {
    return false;
  }

  return ['authenticated', 'refreshing', 'expired'].includes(provider.authStatus ?? '');
};

const providerHasCredentials = (provider: ProviderConfig): boolean => {
  return provider.isEnabled && (provider.isLocal || !!provider.apiKey?.trim() || providerHasAuthSession(provider));
};

const mergeLocalProviderConfig = async (
  providerConfigs: ProviderConfig[]
): Promise<ProviderConfig[]> => {
  const localConfig = await loadAIConfigFile();
  if (!localConfig?.providers) return providerConfigs;

  return providerConfigs.map((provider) => {
    const localProvider = findProviderConfig(localConfig, provider.id, provider.name);
    if (!localProvider) return provider;

    const hasExistingApiKey = !!provider.apiKey?.trim();
    const localApiKey = localProvider.apiKey?.trim();
    const localBaseUrl = localProvider.baseUrl?.trim();

    return applyNativeToolCallingToProviderConfig({
      ...provider,
      apiKey: hasExistingApiKey ? provider.apiKey : localApiKey || provider.apiKey,
      baseUrl: localBaseUrl || provider.baseUrl,
    });
  });
};

const normalizeDbProviderConfig = (config: tauriIpc.DbProviderConfig): ProviderConfig =>
  applyNativeToolCallingToProviderConfig({
    id: config.id,
    name: config.name,
    providerType: config.provider_type,
    baseUrl: config.base_url,
    apiKey: config.api_key || undefined,
    isEnabled: config.is_enabled,
    isLocal: config.is_local,
    authStatus:
      (config.auth_status as ProviderConfig['authStatus']) ??
      (config.provider_type === 'chatgpt' ? 'unauthenticated' : undefined),
    authSource: config.auth_source ?? undefined,
    planType: config.plan_type ?? undefined,
    accountLabel: config.account_label ?? undefined,
    tokenExpiresAt: config.token_expires_at ?? undefined,
  });

const toProviderStatus = (
  config: ProviderConfig,
  connectionStatus: 'online' | 'offline' | 'checking' | undefined = undefined
): AIProvider['status'] => {
  if (config.providerType === 'chatgpt') {
    return providerHasAuthSession(config) ? 'online' : 'offline';
  }

  return connectionStatus === 'online' ? 'online' : 'offline';
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return fallback;
};

const createRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

interface ProviderAuthErrorState {
  code: string;
  message: string;
}

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
  authErrorsByProvider: Record<string, ProviderAuthErrorState | undefined>;
  authRequestIdsByProvider: Record<string, string | undefined>;

  // Actions
  initialize: () => Promise<void>;
  loadProviderConfigs: () => Promise<void>;
  fetchModelsForProvider: (providerId: string) => Promise<AIModel[]>;
  loadProviderModels: (providerId: string) => Promise<AIModel[]>;
  scanModelsForProvider: (providerId: string) => Promise<AIModel[]>;
  setProviderModelEnabled: (providerId: string, modelId: string, enabled: boolean) => Promise<void>;
  setAllProviderModelsEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  addManualModel: (providerId: string, modelId: string, name: string) => Promise<void>;
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
  startChatGptAuth: (providerId?: string) => Promise<void>;
  cancelChatGptAuth: (providerId: string) => Promise<void>;
  disconnectProviderAuth: (providerId: string) => Promise<ProviderConfig>;
  testConnection: (providerId: string) => Promise<{ success: boolean; message: string }>;
  supportsNativeToolCalling: (providerId?: string | null, modelId?: string | null) => boolean;
  selectedSupportsNativeToolCalling: () => boolean;
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
  authErrorsByProvider: {},
  authRequestIdsByProvider: {},

  supportsNativeToolCalling: (providerId?: string | null, modelId?: string | null) => {
    if (!providerId) return false;

    const state = get();
    const providerConfig = state.providerConfigs.find((provider) => provider.id === providerId);
    if (!providerConfig?.nativeToolCalling) {
      return false;
    }

    if (!modelId) {
      return true;
    }

    const model = (state.modelsByProvider[providerId] || []).find((entry) => entry.id === modelId);
    return model ? model.nativeToolCalling !== false : true;
  },

  selectedSupportsNativeToolCalling: () => {
    const state = get();
    return state.supportsNativeToolCalling(state.selectedProviderId, state.selectedModelId);
  },

  initialize: async () => {
    const { loadProviderConfigs, loadProviderModels, scanModelsForProvider, testConnection } = get();
    await loadProviderConfigs();

    const { providerConfigs, selectProvider } = get();
    const connectivityChecks: Array<Promise<unknown>> = [];

    for (const provider of providerConfigs) {
      await loadProviderModels(provider.id);
      const models = get().modelsByProvider[provider.id] || [];

      const hasCredentials = providerHasCredentials(provider);
      const shouldCheckConnectivity = provider.isEnabled && hasCredentials;

      if (!shouldCheckConnectivity) {
        continue;
      }

      if (models.length === 0) {
        connectivityChecks.push(scanModelsForProvider(provider.id));
      } else {
        connectivityChecks.push(testConnection(provider.id));
      }
    }

    void Promise.allSettled(connectivityChecks);

    const currentMode = useAppStore.getState().mode;
    const persistedSelection = getModeSelectionFromPreference(
      await loadPreference(PREF_KEYS.AI_CONTEXT_SELECTIONS),
      currentMode
    );

    if (persistedSelection?.providerId && persistedSelection.modelId) {
      const preferredProvider = providerConfigs.find((provider) => provider.id === persistedSelection.providerId);
      if (preferredProvider && providerHasCredentials(preferredProvider)) {
        set({
          selectedProviderId: preferredProvider.id,
          selectedModelId: persistedSelection.modelId,
        });

        let preferredModels = get().modelsByProvider[persistedSelection.providerId] || [];
        if (preferredModels.length === 0) {
          preferredModels = await loadProviderModels(preferredProvider.id);
        }

        let hasPreferredModel = preferredModels.some(
          (model) => model.id === persistedSelection.modelId && model.isEnabled !== false
        );

        if (!hasPreferredModel) {
          preferredModels = await scanModelsForProvider(preferredProvider.id);
          hasPreferredModel = preferredModels.some(
            (model) => model.id === persistedSelection.modelId && model.isEnabled !== false
          );
        }

        if (hasPreferredModel) {
          set({ selectedProviderId: preferredProvider.id });
          get().selectModel(persistedSelection.modelId);
          return;
        }
      }
    }

    const enabledProvider = providerConfigs.find((provider) => providerHasCredentials(provider));
    if (enabledProvider) {
      selectProvider(enabledProvider.id);
    }
  },

  loadProviderConfigs: async () => {
    set({ isLoading: true, lastError: null });
    
    try {
      if (tauriIpc.isTauriAvailable()) {
        const configs = await tauriIpc.listProviderConfigs();
        const normalizedConfigs: ProviderConfig[] = configs.map(normalizeDbProviderConfig);
        const providerConfigs = await mergeLocalProviderConfig(normalizedConfigs);
        const currentSelectedProviderId = get().selectedProviderId;
        const currentSelectedModelId = get().selectedModelId;
        const currentSelectedProvider = providerConfigs.find(
          (provider) => provider.id === currentSelectedProviderId
        );
        const fallbackProvider = getFirstUsableProvider(providerConfigs);
        const nextSelectedProviderId =
          currentSelectedProvider && providerHasCredentials(currentSelectedProvider)
            ? currentSelectedProvider.id
            : fallbackProvider?.id ?? null;
        const nextSelectedModelId =
          nextSelectedProviderId === currentSelectedProviderId
            ? currentSelectedModelId
            : nextSelectedProviderId
              ? getFirstEnabledModelId(get().modelsByProvider[nextSelectedProviderId] || [])
              : null;
        
        const providers: AIProvider[] = providerConfigs.map((c) =>
          applyNativeToolCallingToProvider(
            {
              id: c.id,
              name: c.name,
              status: toProviderStatus(c),
              baseUrl: c.baseUrl,
              isLocal: c.isLocal,
              isEnabled: c.isEnabled,
            },
            c.providerType
          )
        );

        set({
          providerConfigs,
          providers,
          isLoading: false,
          selectedProviderId: nextSelectedProviderId,
          selectedModelId: nextSelectedModelId,
        });

        for (const provider of providerConfigs) {
          get().loadProviderSettings(provider.id);
        }
      } else {
        // Fallback mock providers for development without Tauri
        const mockConfigs = [
          { id: 'openai', name: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com/v1', isEnabled: true, isLocal: false },
          { id: 'chatgpt', name: 'ChatGPT', providerType: 'chatgpt', baseUrl: 'https://chatgpt.com/backend-api', isEnabled: true, isLocal: false, authStatus: 'unauthenticated' },
          { id: 'zai', name: 'z.ai', providerType: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', isEnabled: true, isLocal: false },
          { id: 'anthropic', name: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', isEnabled: true, isLocal: false },
          { id: 'openrouter', name: 'OpenRouter', providerType: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', isEnabled: true, isLocal: false },
          { id: 'ollama', name: 'Ollama', providerType: 'ollama', baseUrl: 'http://localhost:11434/v1', isEnabled: true, isLocal: true },
          { id: 'lmstudio', name: 'LM Studio', providerType: 'lmstudio', baseUrl: 'http://localhost:1234/v1', isEnabled: true, isLocal: true },
        ] satisfies ProviderConfig[];
        const providerConfigs = await mergeLocalProviderConfig(
          mockConfigs.map(applyNativeToolCallingToProviderConfig)
        );
        const currentSelectedProviderId = get().selectedProviderId;
        const currentSelectedModelId = get().selectedModelId;
        const currentSelectedProvider = providerConfigs.find(
          (provider) => provider.id === currentSelectedProviderId
        );
        const fallbackProvider = getFirstUsableProvider(providerConfigs);
        const nextSelectedProviderId =
          currentSelectedProvider && providerHasCredentials(currentSelectedProvider)
            ? currentSelectedProvider.id
            : fallbackProvider?.id ?? null;
        const nextSelectedModelId =
          nextSelectedProviderId === currentSelectedProviderId
            ? currentSelectedModelId
            : nextSelectedProviderId
              ? getFirstEnabledModelId(get().modelsByProvider[nextSelectedProviderId] || [])
              : null;
        
        const providers: AIProvider[] = providerConfigs.map((c) =>
          applyNativeToolCallingToProvider(
            {
              id: c.id,
              name: c.name,
              status: toProviderStatus(c),
              baseUrl: c.baseUrl,
              isLocal: c.isLocal,
              isEnabled: c.isEnabled,
            },
            c.providerType
          )
        );

        set({
          providerConfigs,
          providers,
          isLoading: false,
          selectedProviderId: nextSelectedProviderId,
          selectedModelId: nextSelectedModelId,
        });

        for (const provider of providerConfigs) {
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
    const { modelsByProvider, providerConfigs } = get();
    const providerType = providerConfigs.find((provider) => provider.id === providerId)?.providerType;
    if (tauriIpc.isTauriAvailable()) {
      set({ isLoadingModels: true });
      try {
        const models = await tauriIpc.listProviderModels(providerId);
        const normalized = models.map((model) => normalizeDbModel(model, providerType));
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

    if (!config) {
      return modelsByProvider[providerId] || [];
    }

    if (config.providerType === 'chatgpt') {
      if (!providerHasAuthSession(config)) {
        return modelsByProvider[providerId] || [];
      }

      set({ isLoadingModels: true });
      set((state) => ({
        connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
      }));

      try {
        const updated = tauriIpc.isTauriAvailable()
          ? await tauriIpc.aiSyncProviderModels(providerId)
          : [];
        const normalized = updated.map((model) => normalizeDbModel(model, config.providerType));
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          connectionStatus: { ...state.connectionStatus, [providerId]: 'online' },
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'online' } : p
          ),
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
        const message = error instanceof Error ? error.message : 'Failed to sync ChatGPT models';
        set((state) => ({
          connectionStatus: { ...state.connectionStatus, [providerId]: 'offline' },
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'offline' } : p
          ),
          isLoadingModels: false,
          lastError: message,
        }));
        return modelsByProvider[providerId] || [];
      }
    }

    const requiresApiKey = !config.isLocal;
    if (requiresApiKey && (!config.apiKey || config.apiKey.trim() === '')) {
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

        const normalized = updated.map((model) => normalizeDbModel(model, config.providerType));
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
          nativeToolCalling: supportsNativeToolCallingForProviderType(config.providerType),
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

  addManualModel: async (providerId: string, modelId: string, name: string) => {
    if (tauriIpc.isTauriAvailable()) {
      const updated = await tauriIpc.registerManualModel({ providerId, modelId, name });
      const providerType = get().providerConfigs.find((provider) => provider.id === providerId)?.providerType;
      const normalized = updated.map((model) => normalizeDbModel(model, providerType));
      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
      }));
      return;
    }

    set((state) => ({
      modelsByProvider: {
        ...state.modelsByProvider,
        [providerId]: [
          ...(state.modelsByProvider[providerId] || []),
          {
            id: modelId,
            name,
            provider_id: providerId,
            isEnabled: true,
            isManual: true,
            isFree: modelId.endsWith(':free'),
            nativeToolCalling: supportsNativeToolCallingForProviderType(
              get().providerConfigs.find((provider) => provider.id === providerId)?.providerType
            ),
          },
        ],
      },
    }));
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
    const { providerConfigs, selectedProviderId, selectProvider } = get();
    const enabledProviders = providerConfigs.filter((provider) => providerHasCredentials(provider));
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
          c.id === id ? applyNativeToolCallingToProviderConfig({ ...c, ...updates }) : c
        ),
        providers: state.providers.map((p) =>
          p.id === id
            ? applyNativeToolCallingToProvider(
                {
                  ...p,
                  name: updates.name ?? p.name,
                  baseUrl: updates.baseUrl ?? p.baseUrl,
                  isEnabled: updates.isEnabled ?? p.isEnabled,
                },
                get().providerConfigs.find((provider) => provider.id === id)?.providerType
              )
            : p
        ),
      }));

      const config = get().providerConfigs.find((c) => c.id === id);
      const shouldScan =
        config?.providerType === 'chatgpt'
          ? providerHasAuthSession({ ...config, ...updates } as ProviderConfig)
          : (updates.apiKey && updates.apiKey.trim() !== '') || config?.isLocal === true;
      if (shouldScan) {
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

        const newConfig: ProviderConfig = applyNativeToolCallingToProviderConfig({
          id: created.id,
          name: created.name,
          providerType: created.provider_type,
          baseUrl: created.base_url,
          apiKey: created.api_key || undefined,
          isEnabled: created.is_enabled,
          isLocal: created.is_local,
        });

        const newProvider: AIProvider = applyNativeToolCallingToProvider(
          {
            id: created.id,
            name: created.name,
            status: 'offline',
            baseUrl: created.base_url,
            isLocal: created.is_local,
            isEnabled: created.is_enabled,
          },
          created.provider_type
        );

        set((state) => ({
          providerConfigs: [...state.providerConfigs, newConfig],
          providers: [...state.providers, newProvider],
        }));

        await get().loadProviderSettings(created.id);

        if (newConfig.isLocal || newConfig.apiKey) {
          await get().scanModelsForProvider(created.id);
        }
      } else {
        // Mock creation for development
        const id = `provider_${Date.now()}`;
        const newConfig: ProviderConfig = applyNativeToolCallingToProviderConfig({ id, ...config });
        const newProvider: AIProvider = applyNativeToolCallingToProvider(
          {
            id,
            name: config.name,
            status: 'offline',
            baseUrl: config.baseUrl,
            isLocal: config.isLocal,
            isEnabled: config.isEnabled,
          },
          config.providerType
        );

        set((state) => ({
          providerConfigs: [...state.providerConfigs, newConfig],
          providers: [...state.providers, newProvider],
        }));

        if (newConfig.isLocal || newConfig.apiKey) {
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

  startChatGptAuth: async (providerId = 'chatgpt') => {
    if (!tauriIpc.isTauriAvailable()) {
      throw new Error('ChatGPT auth requires the desktop app.');
    }

    const requestId = createRequestId();

    set((state) => ({
      authRequestIdsByProvider: { ...state.authRequestIdsByProvider, [providerId]: requestId },
      authErrorsByProvider: { ...state.authErrorsByProvider, [providerId]: undefined },
      providerConfigs: state.providerConfigs.map((provider) =>
        provider.id === providerId
          ? { ...provider, authStatus: 'authorizing' }
          : provider
      ),
    }));

    const cleanupListeners = (unlisteners: UnlistenFn[]) => {
      unlisteners.forEach((unlisten) => {
        try {
          unlisten();
        } catch {
          // Ignore listener cleanup errors.
        }
      });
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let unlisteners: UnlistenFn[] = [];

        const finish = (fn: () => void, unlisteners: UnlistenFn[]) => {
          if (settled) return;
          settled = true;
          cleanupListeners(unlisteners);
          fn();
        };

        void (async () => {
          try {
            unlisteners = await Promise.all([
              listen<tauriIpc.AiAuthSuccessEvent>('ai:auth-success', (event) => {
                if (event.payload.request_id !== requestId) return;
                finish(() => resolve(), unlisteners);
              }),
              listen<tauriIpc.AiAuthCancelledEvent>('ai:auth-cancelled', (event) => {
                if (event.payload.request_id !== requestId) return;
                finish(() => reject(new Error('ChatGPT login was cancelled.')), unlisteners);
              }),
              listen<tauriIpc.AiAuthErrorEvent>('ai:auth-error', (event) => {
                if (event.payload.request_id !== requestId) return;
                const error = new Error(event.payload.message);
                (error as Error & { code?: string }).code = event.payload.code;
                finish(() => reject(error), unlisteners);
              }),
            ]);

            await tauriIpc.aiStartChatGptAuth({ requestId, providerId });
          } catch (error) {
            finish(
              () => reject(new Error(getErrorMessage(error, 'Failed to start ChatGPT login.'))),
              unlisteners
            );
          }
        })();
      });

      await get().loadProviderConfigs();
      await get().loadProviderModels(providerId);
      await get().scanModelsForProvider(providerId);
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to connect with ChatGPT.');
      const code =
        error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'browser_open_failed';

      set((state) => ({
        authErrorsByProvider: {
          ...state.authErrorsByProvider,
          [providerId]: { code, message },
        },
        providerConfigs: state.providerConfigs.map((provider) =>
          provider.id === providerId
            ? { ...provider, authStatus: 'error' }
            : provider
        ),
      }));
      throw new Error(message);
    } finally {
      set((state) => ({
        authRequestIdsByProvider: {
          ...state.authRequestIdsByProvider,
          [providerId]: undefined,
        },
      }));
    }
  },

  cancelChatGptAuth: async (providerId: string) => {
    const requestId = get().authRequestIdsByProvider[providerId];
    if (!requestId || !tauriIpc.isTauriAvailable()) {
      return;
    }

    await tauriIpc.aiCancelChatGptAuth(requestId);
    set((state) => ({
      authRequestIdsByProvider: {
        ...state.authRequestIdsByProvider,
        [providerId]: undefined,
      },
      providerConfigs: state.providerConfigs.map((provider) =>
        provider.id === providerId && provider.authStatus === 'authorizing'
          ? { ...provider, authStatus: 'unauthenticated' }
          : provider
      ),
    }));
  },

  disconnectProviderAuth: async (providerId: string) => {
    if (!tauriIpc.isTauriAvailable()) {
      throw new Error('Provider auth disconnect requires the desktop app.');
    }

    try {
      const updated = normalizeDbProviderConfig(await tauriIpc.aiDisconnectProviderAuth(providerId));
      set((state) => ({
        connectionStatus: { ...state.connectionStatus, [providerId]: 'offline' },
        authErrorsByProvider: { ...state.authErrorsByProvider, [providerId]: undefined },
        modelsByProvider: {
          ...state.modelsByProvider,
          [providerId]: (state.modelsByProvider[providerId] || []).filter((model) => model.isManual),
        },
      }));
      await get().loadProviderConfigs();
      return updated;
    } catch (error) {
      throw new Error(getErrorMessage(error, 'Failed to disconnect provider auth.'));
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

    if (config.providerType === 'chatgpt') {
      if (config.authStatus === 'authorizing') {
        return { success: false, message: 'Browser login is in progress.' };
      }

      const success = providerHasAuthSession(config);
      const message = success
        ? `ChatGPT linked${config.planType ? ` (${config.planType})` : ''}.`
        : 'Not linked. Use Connect with ChatGPT.';

      set((state) => ({
        connectionStatus: {
          ...state.connectionStatus,
          [providerId]: success ? 'online' : 'offline',
        },
        providers: state.providers.map((p) =>
          p.id === providerId
            ? { ...p, status: success ? 'online' : 'offline' }
            : p
        ),
      }));

      return { success, message };
    }

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
