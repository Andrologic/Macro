import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ProviderConfig, AIProvider, AIModel, ProviderSettings, ReasoningEffort } from '../types';
import * as tauriIpc from '../services/tauriIpc';
import { fetchModelsFromProvider, testProviderConnection } from '../services/providerApi';
import { findProviderConfig, loadAIConfigFile } from '../services/aiConfig';
import { loadPreference, PREF_KEYS } from '../services/preferences';
import { AppMode } from '../types';
import { useAppStore } from './useAppStore';
import { getReasoningCapabilityForModel, getValidReasoningEffort } from '../services/reasoningCatalog';

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

const sortModelsByName = (models: AIModel[]): AIModel[] =>
  [...models].sort((left, right) =>
    (left.name || left.id).localeCompare(right.name || right.id, undefined, { sensitivity: 'base' })
  );

const LINKED_PROVIDER_TYPES = new Set(['chatgpt', 'copilot']);
const NATIVE_TOOL_CALLING_PROVIDER_TYPES = new Set(['chatgpt', 'copilot', 'openai', 'openrouter']);

export const isLinkedProviderType = (providerType?: string | null): boolean =>
  !!providerType && LINKED_PROVIDER_TYPES.has(providerType);

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
  const reasoningCapability = getReasoningCapabilityForModel({
    providerType,
    modelId: model.model_id,
    supportedReasoningEfforts: model.reasoning_efforts,
    defaultReasoningEffort: model.default_reasoning_effort,
  });
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
    reasoningEfforts: reasoningCapability.reasoningEfforts,
    defaultReasoningEffort: reasoningCapability.defaultReasoningEffort,
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

const getReasoningUnsupportedKey = (providerId?: string | null, modelId?: string | null): string | null =>
  providerId && modelId ? `${providerId}::${modelId}` : null;

const getModelReasoningEfforts = (
  model: AIModel | undefined,
  params?: { unsupported?: Record<string, boolean>; providerId?: string | null }
): ReasoningEffort[] => {
  if (!model) return [];
  const runtimeKey = getReasoningUnsupportedKey(params?.providerId ?? model.provider_id, model.id);
  if (runtimeKey && params?.unsupported?.[runtimeKey]) {
    return [];
  }
  return model.reasoningEfforts ?? [];
};

const resolveSelectedReasoningEffort = (params: {
  providerId?: string | null;
  modelId?: string | null;
  modelsByProvider: Record<string, AIModel[]>;
  unsupported: Record<string, boolean>;
  requested?: string | null;
}): ReasoningEffort | null => {
  const { providerId, modelId, modelsByProvider, unsupported, requested } = params;
  if (!providerId || !modelId) return null;
  const model = (modelsByProvider[providerId] || []).find((entry) => entry.id === modelId);
  if (!model) return null;

  return getValidReasoningEffort(
    {
      reasoningEfforts: getModelReasoningEfforts(model, { unsupported, providerId }),
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    },
    requested
  );
};

const hasLoadedApiKey = (provider: Pick<ProviderConfig, 'providerType' | 'apiKey'>): boolean =>
  !isLinkedProviderType(provider.providerType) && !!provider.apiKey?.trim();

const getFirstUsableProvider = (providerConfigs: ProviderConfig[]): ProviderConfig | null => {
  return providerConfigs.find((provider) => providerHasCredentials(provider)) ?? null;
};

type AISelectionModeKey = 'ChatDebug' | 'Architect' | 'Implement';

interface PersistedAISelection {
  providerId: string | null;
  modelId: string | null;
  reasoningEffort?: ReasoningEffort | null;
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
  const reasoningEffort =
    candidate &&
    typeof (candidate as { reasoningEffort?: unknown }).reasoningEffort === 'string'
      ? ((candidate as { reasoningEffort?: string }).reasoningEffort as ReasoningEffort)
      : null;

  return {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    reasoningEffort,
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

export const providerHasAuthSession = (
  provider: Pick<ProviderConfig, 'providerType' | 'authStatus'>
): boolean => {
  if (provider.providerType === 'chatgpt') {
    return ['authenticated', 'refreshing', 'expired'].includes(provider.authStatus ?? '');
  }

  if (provider.providerType === 'copilot') {
    return provider.authStatus === 'connected';
  }

  return false;
};

export const providerHasCredentials = (
  provider: Pick<
    ProviderConfig,
    'isEnabled' | 'isLocal' | 'apiKey' | 'hasStoredApiKey' | 'providerType' | 'authStatus'
  >
): boolean => {
  const hasApiKey =
    !isLinkedProviderType(provider.providerType) &&
    (provider.hasStoredApiKey || !!provider.apiKey?.trim());
  return provider.isEnabled && (provider.isLocal || hasApiKey || providerHasAuthSession(provider));
};

const providerHasRuntimeCredentials = (
  provider: Pick<ProviderConfig, 'isEnabled' | 'isLocal' | 'apiKey' | 'providerType' | 'authStatus'>
): boolean => {
  return provider.isEnabled && (provider.isLocal || hasLoadedApiKey(provider) || providerHasAuthSession(provider));
};

const mergeLocalProviderConfig = async (
  providerConfigs: ProviderConfig[]
): Promise<ProviderConfig[]> => {
  const localConfig = await loadAIConfigFile();
  if (!localConfig?.providers) return providerConfigs;

  return providerConfigs.map((provider) => {
    if (isLinkedProviderType(provider.providerType)) {
      return provider;
    }

    const localProvider = findProviderConfig(localConfig, provider.id, provider.name);
    if (!localProvider) return provider;

    const hasExistingApiKey = !!provider.apiKey?.trim();
    const localApiKey = localProvider.apiKey?.trim();
    const localBaseUrl = localProvider.baseUrl?.trim();

    return applyNativeToolCallingToProviderConfig({
      ...provider,
      apiKey: hasExistingApiKey ? provider.apiKey : localApiKey || provider.apiKey,
      apiKeyLoaded: provider.apiKeyLoaded || !!(hasExistingApiKey ? provider.apiKey : localApiKey),
      baseUrl: localBaseUrl || provider.baseUrl,
    });
  });
};

const mergeRuntimeProviderConfigState = (
  nextConfigs: ProviderConfig[],
  currentConfigs: ProviderConfig[]
): ProviderConfig[] => {
  const currentById = new Map(currentConfigs.map((config) => [config.id, config]));
  return nextConfigs.map((config) => {
    const current = currentById.get(config.id);
    if (!current) {
      return config;
    }

    return applyNativeToolCallingToProviderConfig({
      ...config,
      hasStoredApiKey: config.hasStoredApiKey || current.hasStoredApiKey,
      apiKey: current.apiKeyLoaded ? current.apiKey : config.apiKey,
      apiKeyLoaded: current.apiKeyLoaded || config.apiKeyLoaded || !!config.apiKey,
    });
  });
};

const normalizeDbProviderConfig = (config: tauriIpc.DbProviderConfig): ProviderConfig =>
  applyNativeToolCallingToProviderConfig({
    id: config.id,
    name: config.name,
    providerType: config.provider_type,
    baseUrl: config.base_url,
    apiKey: undefined,
    hasStoredApiKey: config.has_stored_api_key,
    apiKeyLoaded: false,
    isEnabled: config.is_enabled,
    isLocal: config.is_local,
    authStatus:
      (config.auth_status as ProviderConfig['authStatus']) ??
      (config.provider_type === 'chatgpt'
        ? 'unauthenticated'
        : config.provider_type === 'copilot'
          ? 'login_required'
          : undefined),
    authSource: config.auth_source ?? undefined,
    planType: config.plan_type ?? undefined,
    accountLabel: config.account_label ?? undefined,
    tokenExpiresAt: config.token_expires_at ?? undefined,
  });

const toProviderStatus = (
  config: ProviderConfig,
  connectionStatus: 'online' | 'offline' | 'checking' | undefined = undefined
): AIProvider['status'] => {
  if (isLinkedProviderType(config.providerType)) {
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

interface CopilotDownloadState {
  requestId: string;
  phase: string;
  message: string;
  downloadedBytes: number;
  totalBytes: number | null;
}

interface CopilotAuthState {
  requestId: string;
  phase: string;
  message: string;
  verificationUrl: string | null;
  userCode: string | null;
}

const isCopilotConnected = (status?: tauriIpc.CopilotStatusDto | null): boolean =>
  !!status && status.runtime_status === 'ready' && status.auth_status === 'connected';

const getCopilotStatusMessage = (status: tauriIpc.CopilotStatusDto): string => {
  if (status.runtime_status === 'downloading') {
    return status.status_message || 'Downloading GitHub Copilot runtime...';
  }

  if (status.runtime_status === 'missing') {
    return 'GitHub Copilot is not installed in Macro yet.';
  }

  if (status.runtime_status === 'update_required') {
    return (
      status.error_message ||
      `GitHub Copilot needs a compatible ${status.min_cli_version}+ runtime before it can connect.`
    );
  }

  if (status.runtime_status === 'error') {
    return (
      status.error_message ||
      status.status_message ||
      'GitHub Copilot runtime is unavailable right now.'
    );
  }

  if (status.auth_status === 'connected') {
    return `GitHub Copilot connected${status.account_label ? ` (${status.account_label})` : ''}.`;
  }

  if (status.auth_status === 'login_required') {
    return 'Connect GitHub Copilot to finish setup.';
  }

  return (
    status.error_message ||
    status.status_message ||
    'GitHub Copilot is not available right now.'
  );
};

const getCopilotAuthError = (
  status: tauriIpc.CopilotStatusDto
): ProviderAuthErrorState | undefined => {
  if (
    status.auth_status === 'policy_blocked' ||
    status.auth_status === 'quota_or_auth_error' ||
    (status.auth_status === 'error' && status.runtime_status !== 'missing' && status.runtime_status !== 'update_required')
  ) {
    return {
      code: status.error_code || status.auth_status,
      message: getCopilotStatusMessage(status),
    };
  }

  if (status.runtime_status === 'error') {
    return {
      code: status.error_code || 'copilot_runtime_error',
      message: getCopilotStatusMessage(status),
    };
  }

  return undefined;
};

interface ProviderStore {
  // State
  providerConfigs: ProviderConfig[];
  providers: AIProvider[];
  modelsByProvider: Record<string, AIModel[]>;
  providerSettingsById: Record<string, ProviderSettings>;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedReasoningEffort: ReasoningEffort | null;
  isLoading: boolean;
  isLoadingModels: boolean;
  lastError: string | null;
  connectionStatus: Record<string, 'online' | 'offline' | 'checking'>;
  reasoningUnsupportedModelKeys: Record<string, boolean>;
  authErrorsByProvider: Record<string, ProviderAuthErrorState | undefined>;
  authRequestIdsByProvider: Record<string, string | undefined>;
  copilotStatusByProvider: Record<string, tauriIpc.CopilotStatusDto | undefined>;
  copilotDownloadStateByProvider: Record<string, CopilotDownloadState | undefined>;
  copilotAuthStateByProvider: Record<string, CopilotAuthState | undefined>;

  // Actions
  initialize: () => Promise<void>;
  loadProviderConfigs: () => Promise<void>;
  fetchModelsForProvider: (providerId: string) => Promise<AIModel[]>;
  loadProviderModels: (providerId: string) => Promise<AIModel[]>;
  scanModelsForProvider: (providerId: string) => Promise<AIModel[]>;
  setProviderModelEnabled: (providerId: string, modelId: string, enabled: boolean) => Promise<void>;
  setAllProviderModelsEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  addManualModel: (providerId: string, modelId: string, name: string) => Promise<void>;
  updateManualModel: (
    providerId: string,
    currentModelId: string,
    nextModelId: string,
    name: string
  ) => Promise<void>;
  deleteManualModel: (providerId: string, modelId: string) => Promise<void>;
  loadProviderSettings: (providerId: string) => Promise<ProviderSettings | null>;
  updateProviderSettings: (providerId: string, updates: Partial<ProviderSettings>) => Promise<void>;
  selectProvider: (providerId: string) => void;
  selectModel: (modelId: string) => void;
  selectReasoningEffort: (effort: ReasoningEffort | null) => void;
  getAvailableReasoningEfforts: (providerId?: string | null, modelId?: string | null) => ReasoningEffort[];
  selectedSupportsReasoningEffort: () => boolean;
  markReasoningUnsupportedForModel: (providerId: string, modelId: string) => void;
  cycleProvider: () => void;
  cycleModel: () => void;
  
  // Provider Config CRUD
  resolveProviderApiKey: (providerId: string, options?: { forceRefresh?: boolean }) => Promise<string | undefined>;
  updateProviderConfig: (id: string, updates: Partial<ProviderConfig>) => Promise<void>;
  createProviderConfig: (
    config: Omit<ProviderConfig, 'id' | 'hasStoredApiKey' | 'apiKeyLoaded'>
  ) => Promise<void>;
  deleteProviderConfig: (id: string) => Promise<void>;
  startChatGptAuth: (providerId?: string) => Promise<void>;
  cancelChatGptAuth: (providerId: string) => Promise<void>;
  startCopilotRuntimeDownload: (providerId?: string) => Promise<void>;
  cancelCopilotRuntimeDownload: (providerId: string) => Promise<void>;
  startCopilotAuth: (providerId?: string) => Promise<void>;
  cancelCopilotAuth: (providerId: string) => Promise<void>;
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
  selectedReasoningEffort: null,
  isLoading: false,
  isLoadingModels: false,
  lastError: null,
  connectionStatus: {},
  reasoningUnsupportedModelKeys: {},
  authErrorsByProvider: {},
  authRequestIdsByProvider: {},
  copilotStatusByProvider: {},
  copilotDownloadStateByProvider: {},
  copilotAuthStateByProvider: {},

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

  getAvailableReasoningEfforts: (providerId?: string | null, modelId?: string | null) => {
    const state = get();
    if (!providerId || !modelId) return [];
    const model = (state.modelsByProvider[providerId] || []).find((entry) => entry.id === modelId);
    return getModelReasoningEfforts(model, {
      unsupported: state.reasoningUnsupportedModelKeys,
      providerId,
    });
  },

  selectedSupportsReasoningEffort: () => {
    const state = get();
    return state.getAvailableReasoningEfforts(state.selectedProviderId, state.selectedModelId).length > 0;
  },

  initialize: async () => {
    const { loadProviderConfigs, loadProviderModels, scanModelsForProvider, testConnection } = get();
    await loadProviderConfigs();

    const { providerConfigs, selectProvider } = get();
    const connectivityChecks: Array<Promise<unknown>> = [];

    for (const provider of providerConfigs) {
      await loadProviderModels(provider.id);
      const models = get().modelsByProvider[provider.id] || [];

      const hasCredentials = providerHasRuntimeCredentials(provider);
      const shouldCheckConnectivity =
        provider.isEnabled && (provider.providerType === 'copilot' || hasCredentials);

      if (!shouldCheckConnectivity) {
        continue;
      }

      if (provider.providerType === 'copilot') {
        connectivityChecks.push(testConnection(provider.id));
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
          selectedReasoningEffort: persistedSelection.reasoningEffort ?? null,
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
          get().selectReasoningEffort(persistedSelection.reasoningEffort ?? null);
          return;
        }
      }
    }

    const enabledProvider = providerConfigs.find((provider) => providerHasCredentials(provider));
    if (enabledProvider) {
      selectProvider(enabledProvider.id);
    }
  },

  resolveProviderApiKey: async (providerId: string, options?: { forceRefresh?: boolean }) => {
    const config = get().providerConfigs.find((provider) => provider.id === providerId);
    if (!config) {
      throw new Error('Provider not found');
    }

    if (isLinkedProviderType(config.providerType) || config.isLocal) {
      return undefined;
    }

    if (!options?.forceRefresh && config.apiKeyLoaded) {
      return config.apiKey?.trim() ? config.apiKey : undefined;
    }

    if (!tauriIpc.isTauriAvailable()) {
      return config.apiKey?.trim() ? config.apiKey : undefined;
    }

    try {
      const apiKey = (await tauriIpc.revealProviderApiKey(providerId)) || undefined;
      set((state) => ({
        providerConfigs: state.providerConfigs.map((provider) =>
          provider.id === providerId
            ? applyNativeToolCallingToProviderConfig({
                ...provider,
                apiKey,
                hasStoredApiKey: !!apiKey,
                apiKeyLoaded: true,
              })
            : provider
        ),
      }));
      return apiKey?.trim() ? apiKey : undefined;
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to access the stored API key.');
      set({ lastError: message });
      throw new Error(message);
    }
  },

  loadProviderConfigs: async () => {
    set({ isLoading: true, lastError: null });
    
    try {
      if (tauriIpc.isTauriAvailable()) {
        const currentProviderConfigs = get().providerConfigs;
        const configs = await tauriIpc.listProviderConfigs();
        const normalizedConfigs: ProviderConfig[] = configs.map(normalizeDbProviderConfig);
        const providerConfigs = mergeRuntimeProviderConfigState(
          await mergeLocalProviderConfig(normalizedConfigs),
          currentProviderConfigs
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
        const nextSelectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId: nextSelectedProviderId,
          modelId: nextSelectedModelId,
          modelsByProvider: get().modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested:
            nextSelectedProviderId === currentSelectedProviderId
              ? get().selectedReasoningEffort
              : null,
        });
        
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
          selectedReasoningEffort: nextSelectedReasoningEffort,
        });

        for (const provider of providerConfigs) {
          get().loadProviderSettings(provider.id);
        }
      } else {
        // Fallback mock providers for development without Tauri
        const mockConfigs = [
          { id: 'openai', name: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com/v1', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: false },
          { id: 'chatgpt', name: 'ChatGPT', providerType: 'chatgpt', baseUrl: 'https://chatgpt.com/backend-api', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: false, authStatus: 'unauthenticated' },
          { id: 'copilot', name: 'GitHub Copilot', providerType: 'copilot', baseUrl: 'copilot://cli', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: false, authStatus: 'login_required' },
          { id: 'zai', name: 'z.ai', providerType: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: false },
          { id: 'anthropic', name: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: false },
          { id: 'openrouter', name: 'OpenRouter', providerType: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: false },
          { id: 'ollama', name: 'Ollama', providerType: 'ollama', baseUrl: 'http://localhost:11434/v1', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: true },
          { id: 'lmstudio', name: 'LM Studio', providerType: 'lmstudio', baseUrl: 'http://localhost:1234/v1', hasStoredApiKey: false, apiKeyLoaded: false, isEnabled: true, isLocal: true },
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
        const nextSelectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId: nextSelectedProviderId,
          modelId: nextSelectedModelId,
          modelsByProvider: get().modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested:
            nextSelectedProviderId === currentSelectedProviderId
              ? get().selectedReasoningEffort
              : null,
        });
        
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
          selectedReasoningEffort: nextSelectedReasoningEffort,
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
        const selectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId,
          modelId: normalized.some((m) => m.id === get().selectedModelId && m.isEnabled !== false)
            ? get().selectedModelId
            : getFirstEnabledModelId(normalized),
          modelsByProvider: {
            ...get().modelsByProvider,
            [providerId]: normalized,
          },
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        });
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          isLoadingModels: false,
          ...(state.selectedProviderId === providerId ? { selectedReasoningEffort } : {}),
        }));

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId) {
          const selectedExists = normalized.some((m) => m.id === selectedModelId && m.isEnabled !== false);
          if (!selectedExists) {
            const nextSelectedModelId = getFirstEnabledModelId(normalized);
            set({
              selectedModelId: nextSelectedModelId,
              selectedReasoningEffort: resolveSelectedReasoningEffort({
                providerId,
                modelId: nextSelectedModelId,
                modelsByProvider: { ...get().modelsByProvider, [providerId]: normalized },
                unsupported: get().reasoningUnsupportedModelKeys,
                requested: get().selectedReasoningEffort,
              }),
            });
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
    const { providerConfigs, modelsByProvider, resolveProviderApiKey } = get();
    const config = providerConfigs.find((c) => c.id === providerId);

    if (!config) {
      return modelsByProvider[providerId] || [];
    }

    if (isLinkedProviderType(config.providerType)) {
      const copilotStatus =
        config.providerType === 'copilot' ? get().copilotStatusByProvider[providerId] : undefined;
      const hasLinkedSession =
        config.providerType === 'copilot'
          ? isCopilotConnected(copilotStatus) || providerHasAuthSession(config)
          : providerHasAuthSession(config);

      if (!hasLinkedSession) {
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
        const nextSelectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId,
          modelId: normalized.some((m) => m.id === get().selectedModelId && m.isEnabled !== false)
            ? get().selectedModelId
            : getFirstEnabledModelId(normalized),
          modelsByProvider: {
            ...get().modelsByProvider,
            [providerId]: normalized,
          },
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        });
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          connectionStatus: { ...state.connectionStatus, [providerId]: 'online' },
          providers: state.providers.map((p) =>
            p.id === providerId ? { ...p, status: 'online' } : p
          ),
          isLoadingModels: false,
          ...(state.selectedProviderId === providerId ? { selectedReasoningEffort: nextSelectedReasoningEffort } : {}),
        }));

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId) {
          const selectedExists = normalized.some((m) => m.id === selectedModelId && m.isEnabled !== false);
          if (!selectedExists) {
            const nextSelectedModelId = getFirstEnabledModelId(normalized);
            set({
              selectedModelId: nextSelectedModelId,
              selectedReasoningEffort: resolveSelectedReasoningEffort({
                providerId,
                modelId: nextSelectedModelId,
                modelsByProvider: { ...get().modelsByProvider, [providerId]: normalized },
                unsupported: get().reasoningUnsupportedModelKeys,
                requested: get().selectedReasoningEffort,
              }),
            });
          }
        }

        return normalized;
      } catch (error) {
        if (tauriIpc.isTauriAvailable()) {
          try {
            await get().loadProviderConfigs();
          } catch {
            // Ignore provider metadata refresh failures after sync errors.
          }
        }

        const providerLabel = config.providerType === 'copilot' ? 'GitHub Copilot' : 'ChatGPT';
        const message =
          error instanceof Error ? error.message : `Failed to sync ${providerLabel} models`;
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
    const apiKey = requiresApiKey ? await resolveProviderApiKey(providerId) : undefined;
    if (requiresApiKey && !apiKey) {
      return modelsByProvider[providerId] || [];
    }

    set({ isLoadingModels: true });
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
    }));

    try {
      const result = await fetchModelsFromProvider({
        baseUrl: config.baseUrl,
        apiKey,
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
          models: result.models.map((model) => {
            const reasoningCapability = getReasoningCapabilityForModel({
              providerType: config.providerType,
              modelId: model.id,
              supportedParameters: model.supported_parameters,
            });

            return {
              model_id: model.id,
              name: model.name || model.id,
              description: model.description ?? null,
              owned_by: model.owned_by ?? null,
              pricing_prompt: model.pricing?.prompt ?? null,
              pricing_completion: model.pricing?.completion ?? null,
              pricing_request: model.pricing?.request ?? null,
              reasoning_efforts: reasoningCapability.reasoningEfforts,
              default_reasoning_effort: reasoningCapability.defaultReasoningEffort,
            };
          }),
        });

        const normalized = updated.map((model) => normalizeDbModel(model, config.providerType));
        const nextSelectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId,
          modelId: normalized.some((m) => m.id === get().selectedModelId && m.isEnabled !== false)
            ? get().selectedModelId
            : getFirstEnabledModelId(normalized),
          modelsByProvider: {
            ...get().modelsByProvider,
            [providerId]: normalized,
          },
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        });
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          connectionStatus: { ...state.connectionStatus, [providerId]: 'online' },
          isLoadingModels: false,
          ...(state.selectedProviderId === providerId ? { selectedReasoningEffort: nextSelectedReasoningEffort } : {}),
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
            const nextSelectedModelId = getFirstEnabledModelId(normalized);
            set({
              selectedModelId: nextSelectedModelId,
              selectedReasoningEffort: resolveSelectedReasoningEffort({
                providerId,
                modelId: nextSelectedModelId,
                modelsByProvider: { ...get().modelsByProvider, [providerId]: normalized },
                unsupported: get().reasoningUnsupportedModelKeys,
                requested: get().selectedReasoningEffort,
              }),
            });
          }
        }

        return normalized;
      }

      const models: AIModel[] = result.models.map((m) => {
        const reasoningCapability = getReasoningCapabilityForModel({
          providerType: config.providerType,
          modelId: m.id,
          supportedParameters: m.supported_parameters,
        });
        const normalized = {
          id: m.id,
          name: m.name || m.id,
          provider_id: providerId,
          owned_by: m.owned_by,
          description: m.description,
          reasoningEfforts: reasoningCapability.reasoningEfforts,
          defaultReasoningEffort: reasoningCapability.defaultReasoningEffort,
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
        const nextSelectedModelId = getFirstEnabledModelId(updatedModels);
        set({
          selectedModelId: nextSelectedModelId,
          selectedReasoningEffort: resolveSelectedReasoningEffort({
            providerId,
            modelId: nextSelectedModelId,
            modelsByProvider,
            unsupported: get().reasoningUnsupportedModelKeys,
            requested: get().selectedReasoningEffort,
          }),
        });
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
      const nextSelectedModelId = enabled ? getFirstEnabledModelId(updatedModels) : null;
      set({
        selectedModelId: nextSelectedModelId,
        selectedReasoningEffort: resolveSelectedReasoningEffort({
          providerId,
          modelId: nextSelectedModelId,
          modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        }),
      });
    }
  },

  addManualModel: async (providerId: string, modelId: string, name: string) => {
    if (tauriIpc.isTauriAvailable()) {
      const updated = await tauriIpc.registerManualModel({ providerId, modelId, name });
      const providerType = get().providerConfigs.find((provider) => provider.id === providerId)?.providerType;
      const normalized = updated.map((model) => normalizeDbModel(model, providerType));
      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
        ...(state.selectedProviderId === providerId
          ? {
              selectedReasoningEffort: resolveSelectedReasoningEffort({
                providerId,
                modelId: state.selectedModelId,
                modelsByProvider: {
                  ...state.modelsByProvider,
                  [providerId]: normalized,
                },
                unsupported: state.reasoningUnsupportedModelKeys,
                requested: state.selectedReasoningEffort,
              }),
            }
          : {}),
      }));
      return;
    }

    set((state) => ({
      modelsByProvider: {
        ...state.modelsByProvider,
        [providerId]: sortModelsByName([
          ...(state.modelsByProvider[providerId] || []),
          {
            id: modelId,
            name,
            provider_id: providerId,
            isEnabled: true,
            isManual: true,
            reasoningEfforts: getReasoningCapabilityForModel({
              providerType: get().providerConfigs.find((provider) => provider.id === providerId)?.providerType,
              modelId,
            }).reasoningEfforts,
            defaultReasoningEffort: getReasoningCapabilityForModel({
              providerType: get().providerConfigs.find((provider) => provider.id === providerId)?.providerType,
              modelId,
            }).defaultReasoningEffort,
            isFree: modelId.endsWith(':free'),
            nativeToolCalling: supportsNativeToolCallingForProviderType(
              get().providerConfigs.find((provider) => provider.id === providerId)?.providerType
            ),
          },
        ]),
      },
    }));
  },

  updateManualModel: async (
    providerId: string,
    currentModelId: string,
    nextModelId: string,
    name: string
  ) => {
    if (tauriIpc.isTauriAvailable()) {
      const updated = await tauriIpc.updateManualModel({
        providerId,
        currentModelId,
        nextModelId,
        name,
      });
      const providerType = get().providerConfigs.find((provider) => provider.id === providerId)?.providerType;
      const normalized = updated.map((model) => normalizeDbModel(model, providerType));
      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
        ...(state.selectedProviderId === providerId
          ? {
              selectedReasoningEffort: resolveSelectedReasoningEffort({
                providerId,
                modelId: state.selectedModelId,
                modelsByProvider: {
                  ...state.modelsByProvider,
                  [providerId]: normalized,
                },
                unsupported: state.reasoningUnsupportedModelKeys,
                requested: state.selectedReasoningEffort,
              }),
            }
          : {}),
      }));
    } else {
      set((state) => {
        const models = state.modelsByProvider[providerId] || [];
        const duplicate = models.some(
          (model) => model.id === nextModelId && model.id !== currentModelId
        );
        if (duplicate) {
          throw new Error(`Model ${nextModelId} already exists for provider ${providerId}.`);
        }

        const nextModels = sortModelsByName(
          models.map((model) => {
            if (model.id !== currentModelId) return model;
            const updatedModel: AIModel = {
              ...model,
              id: nextModelId,
              name,
            };
            return {
              ...updatedModel,
              isFree: computeIsFreeModel(updatedModel),
            };
          })
        );

        return {
          modelsByProvider: {
            ...state.modelsByProvider,
            [providerId]: nextModels,
          },
        };
      });
    }

    const { selectedProviderId, selectedModelId, modelsByProvider } = get();
    if (selectedProviderId !== providerId) {
      return;
    }

    const updatedModels = modelsByProvider[providerId] || [];
    if (selectedModelId === currentModelId) {
      set({
        selectedModelId: nextModelId,
        selectedReasoningEffort: resolveSelectedReasoningEffort({
          providerId,
          modelId: nextModelId,
          modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        }),
      });
      return;
    }

    const selected = updatedModels.find((model) => model.id === selectedModelId);
    if (!selected || selected.isEnabled === false) {
      const nextSelectedModelId = getFirstEnabledModelId(updatedModels);
      set({
        selectedModelId: nextSelectedModelId,
        selectedReasoningEffort: resolveSelectedReasoningEffort({
          providerId,
          modelId: nextSelectedModelId,
          modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        }),
      });
    }
  },

  deleteManualModel: async (providerId: string, modelId: string) => {
    if (tauriIpc.isTauriAvailable()) {
      const updated = await tauriIpc.deleteManualModel({ providerId, modelId });
      const providerType = get().providerConfigs.find((provider) => provider.id === providerId)?.providerType;
      const normalized = updated.map((model) => normalizeDbModel(model, providerType));
      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
        ...(state.selectedProviderId === providerId
          ? {
              selectedReasoningEffort: resolveSelectedReasoningEffort({
                providerId,
                modelId: state.selectedModelId,
                modelsByProvider: {
                  ...state.modelsByProvider,
                  [providerId]: normalized,
                },
                unsupported: state.reasoningUnsupportedModelKeys,
                requested: state.selectedReasoningEffort,
              }),
            }
          : {}),
      }));
    } else {
      set((state) => ({
        modelsByProvider: {
          ...state.modelsByProvider,
          [providerId]: (state.modelsByProvider[providerId] || []).filter(
            (model) => model.id !== modelId
          ),
        },
      }));
    }

    const { selectedProviderId, selectedModelId, modelsByProvider } = get();
    if (selectedProviderId !== providerId) {
      return;
    }

    const updatedModels = modelsByProvider[providerId] || [];
    if (selectedModelId === modelId) {
      const nextSelectedModelId = getFirstEnabledModelId(updatedModels);
      set({
        selectedModelId: nextSelectedModelId,
        selectedReasoningEffort: resolveSelectedReasoningEffort({
          providerId,
          modelId: nextSelectedModelId,
          modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        }),
      });
      return;
    }

    const selected = updatedModels.find((model) => model.id === selectedModelId);
    if (!selected || selected.isEnabled === false) {
      const nextSelectedModelId = getFirstEnabledModelId(updatedModels);
      set({
        selectedModelId: nextSelectedModelId,
        selectedReasoningEffort: resolveSelectedReasoningEffort({
          providerId,
          modelId: nextSelectedModelId,
          modelsByProvider,
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        }),
      });
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
      selectedReasoningEffort: resolveSelectedReasoningEffort({
        providerId,
        modelId: getFirstEnabledModelId(cachedModels),
        modelsByProvider,
        unsupported: get().reasoningUnsupportedModelKeys,
        requested: null,
      }),
    });

    if (cachedModels.length === 0) {
      loadProviderModels(providerId);
    }
  },

  selectModel: (modelId: string) => {
    const state = get();
    set({
      selectedModelId: modelId,
      selectedReasoningEffort: resolveSelectedReasoningEffort({
        providerId: state.selectedProviderId,
        modelId,
        modelsByProvider: state.modelsByProvider,
        unsupported: state.reasoningUnsupportedModelKeys,
        requested: state.selectedReasoningEffort,
      }),
    });
  },

  selectReasoningEffort: (effort: ReasoningEffort | null) => {
    const state = get();
    set({
      selectedReasoningEffort: resolveSelectedReasoningEffort({
        providerId: state.selectedProviderId,
        modelId: state.selectedModelId,
        modelsByProvider: state.modelsByProvider,
        unsupported: state.reasoningUnsupportedModelKeys,
        requested: effort,
      }),
    });
  },

  markReasoningUnsupportedForModel: (providerId: string, modelId: string) => {
    const state = get();
    const runtimeKey = getReasoningUnsupportedKey(providerId, modelId);
    if (!runtimeKey) return;
    set({
      reasoningUnsupportedModelKeys: {
        ...state.reasoningUnsupportedModelKeys,
        [runtimeKey]: true,
      },
      ...(state.selectedProviderId === providerId && state.selectedModelId === modelId
        ? { selectedReasoningEffort: null }
        : {}),
    });
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
    const nextModelId = models[nextIndex].id;
    set({
      selectedModelId: nextModelId,
      selectedReasoningEffort: resolveSelectedReasoningEffort({
        providerId: selectedProviderId,
        modelId: nextModelId,
        modelsByProvider,
        unsupported: get().reasoningUnsupportedModelKeys,
        requested: get().selectedReasoningEffort,
      }),
    });
  },

  updateProviderConfig: async (id: string, updates: Partial<ProviderConfig>) => {
    try {
      const currentConfig = get().providerConfigs.find((provider) => provider.id === id);
      const providerType = updates.providerType ?? currentConfig?.providerType;
      const persistedUpdates = isLinkedProviderType(providerType)
        ? {
            ...updates,
            baseUrl: undefined,
            apiKey: undefined,
          }
        : updates;

      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.updateProviderConfig({
          id,
          name: persistedUpdates.name,
          baseUrl: persistedUpdates.baseUrl,
          apiKey: persistedUpdates.apiKey,
          isEnabled: persistedUpdates.isEnabled,
        });
      }

      // Update local state
      set((state) => ({
        providerConfigs: state.providerConfigs.map((c) =>
          c.id === id
            ? applyNativeToolCallingToProviderConfig({
                ...c,
                ...persistedUpdates,
                hasStoredApiKey:
                  persistedUpdates.apiKey === undefined
                    ? c.hasStoredApiKey
                    : persistedUpdates.apiKey.trim() !== '',
                apiKey:
                  persistedUpdates.apiKey === undefined ? c.apiKey : persistedUpdates.apiKey || undefined,
                apiKeyLoaded:
                  persistedUpdates.apiKey === undefined ? c.apiKeyLoaded : true,
              })
            : c
        ),
        providers: state.providers.map((p) =>
          p.id === id
            ? applyNativeToolCallingToProvider(
                {
                  ...p,
                  name: persistedUpdates.name ?? p.name,
                  baseUrl: persistedUpdates.baseUrl ?? p.baseUrl,
                  isEnabled: persistedUpdates.isEnabled ?? p.isEnabled,
                },
                get().providerConfigs.find((provider) => provider.id === id)?.providerType
              )
            : p
        ),
      }));

      const config = get().providerConfigs.find((c) => c.id === id);
      const nextConfig = config ? ({ ...config, ...persistedUpdates } as ProviderConfig) : null;
      const shouldScan = nextConfig
        ? isLinkedProviderType(nextConfig.providerType)
          ? providerHasAuthSession(nextConfig)
          : providerHasRuntimeCredentials(nextConfig)
        : false;
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

  createProviderConfig: async (config: Omit<ProviderConfig, 'id' | 'hasStoredApiKey' | 'apiKeyLoaded'>) => {
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
          apiKey: config.apiKey?.trim() ? config.apiKey : undefined,
          hasStoredApiKey: created.has_stored_api_key,
          apiKeyLoaded: !!config.apiKey?.trim(),
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

        if (providerHasCredentials(newConfig)) {
          await get().scanModelsForProvider(created.id);
        }
      } else {
        // Mock creation for development
        const id = `provider_${Date.now()}`;
        const newConfig: ProviderConfig = applyNativeToolCallingToProviderConfig({
          id,
          ...config,
          hasStoredApiKey: !!config.apiKey?.trim(),
          apiKeyLoaded: !!config.apiKey?.trim(),
        });
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

        if (providerHasCredentials(newConfig)) {
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

  startCopilotRuntimeDownload: async (providerId = 'copilot') => {
    if (!tauriIpc.isTauriAvailable()) {
      throw new Error('GitHub Copilot runtime download requires the desktop app.');
    }

    const provider = get().providerConfigs.find((entry) => entry.id === providerId);
    if (!provider || provider.providerType !== 'copilot') {
      throw new Error('GitHub Copilot provider not found.');
    }

    const requestId = createRequestId();

    set((state) => ({
      authErrorsByProvider: { ...state.authErrorsByProvider, [providerId]: undefined },
      copilotDownloadStateByProvider: {
        ...state.copilotDownloadStateByProvider,
        [providerId]: {
          requestId,
          phase: 'starting',
          message: 'Preparing GitHub Copilot download...',
          downloadedBytes: 0,
          totalBytes: null,
        },
      },
      copilotAuthStateByProvider: {
        ...state.copilotAuthStateByProvider,
        [providerId]: undefined,
      },
      connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
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

        const finish = (fn: () => void, activeUnlisteners: UnlistenFn[]) => {
          if (settled) return;
          settled = true;
          cleanupListeners(activeUnlisteners);
          fn();
        };

        void (async () => {
          try {
            unlisteners = await Promise.all([
              listen<tauriIpc.CopilotDownloadProgressEvent>(
                'ai:copilot-download-progress',
                (event) => {
                  if (event.payload.request_id !== requestId) return;
                  set((state) => ({
                    copilotDownloadStateByProvider: {
                      ...state.copilotDownloadStateByProvider,
                      [providerId]: {
                        requestId,
                        phase: event.payload.phase,
                        message: event.payload.message,
                        downloadedBytes: event.payload.downloaded_bytes,
                        totalBytes: event.payload.total_bytes,
                      },
                    },
                  }));
                }
              ),
              listen<tauriIpc.CopilotDownloadCompleteEvent>(
                'ai:copilot-download-complete',
                (event) => {
                  if (event.payload.request_id !== requestId) return;
                  finish(() => resolve(), unlisteners);
                }
              ),
              listen<tauriIpc.CopilotDownloadErrorEvent>('ai:copilot-download-error', (event) => {
                if (event.payload.request_id !== requestId) return;
                const error = new Error(event.payload.message);
                (error as Error & { code?: string }).code = event.payload.code;
                finish(() => reject(error), unlisteners);
              }),
            ]);

            await tauriIpc.aiDownloadCopilotRuntime({ requestId, providerId });
          } catch (error) {
            finish(
              () =>
                reject(
                  new Error(
                    getErrorMessage(error, 'Failed to start GitHub Copilot runtime download.')
                  )
                ),
              unlisteners
            );
          }
        })();
      });
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to download GitHub Copilot runtime.');
      const isCancelled = message === 'GitHub Copilot runtime download was cancelled.';
      set((state) => ({
        authErrorsByProvider: {
          ...state.authErrorsByProvider,
          [providerId]: isCancelled
            ? undefined
            : { code: 'copilot_download_failed', message },
        },
      }));
      await get().testConnection(providerId);
      throw new Error(message);
    } finally {
      set((state) => ({
        copilotDownloadStateByProvider: {
          ...state.copilotDownloadStateByProvider,
          [providerId]:
            state.copilotDownloadStateByProvider[providerId]?.requestId === requestId
              ? undefined
              : state.copilotDownloadStateByProvider[providerId],
        },
      }));
    }

    const result = await get().testConnection(providerId);
    if (result.success) {
      await get().loadProviderModels(providerId);
      await get().scanModelsForProvider(providerId);
    }
  },

  cancelCopilotRuntimeDownload: async (providerId: string) => {
    if (!tauriIpc.isTauriAvailable()) {
      return;
    }

    const requestId = get().copilotDownloadStateByProvider[providerId]?.requestId;
    if (!requestId) {
      return;
    }

    await tauriIpc.aiCancelCopilotRuntimeDownload(requestId);
    set((state) => ({
      copilotDownloadStateByProvider: {
        ...state.copilotDownloadStateByProvider,
        [providerId]: undefined,
      },
    }));
    await get().testConnection(providerId);
  },

  startCopilotAuth: async (providerId = 'copilot') => {
    if (!tauriIpc.isTauriAvailable()) {
      throw new Error('GitHub Copilot authentication requires the desktop app.');
    }

    const provider = get().providerConfigs.find((entry) => entry.id === providerId);
    if (!provider || provider.providerType !== 'copilot') {
      throw new Error('GitHub Copilot provider not found.');
    }

    const requestId = createRequestId();

    set((state) => ({
      authErrorsByProvider: { ...state.authErrorsByProvider, [providerId]: undefined },
      copilotAuthStateByProvider: {
        ...state.copilotAuthStateByProvider,
        [providerId]: {
          requestId,
          phase: 'starting',
          message: 'Starting GitHub Copilot login...',
          verificationUrl: null,
          userCode: null,
        },
      },
      connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
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

        const finish = (fn: () => void, activeUnlisteners: UnlistenFn[]) => {
          if (settled) return;
          settled = true;
          cleanupListeners(activeUnlisteners);
          fn();
        };

        void (async () => {
          try {
            unlisteners = await Promise.all([
              listen<tauriIpc.CopilotAuthProgressEvent>('ai:copilot-auth-progress', (event) => {
                if (event.payload.request_id !== requestId) return;
                set((state) => ({
                  copilotAuthStateByProvider: {
                    ...state.copilotAuthStateByProvider,
                    [providerId]: {
                      requestId,
                      phase: event.payload.phase,
                      message: event.payload.message,
                      verificationUrl: event.payload.verification_url,
                      userCode: event.payload.user_code,
                    },
                  },
                }));
              }),
              listen<tauriIpc.CopilotAuthCompleteEvent>('ai:copilot-auth-complete', (event) => {
                if (event.payload.request_id !== requestId) return;
                finish(() => resolve(), unlisteners);
              }),
              listen<tauriIpc.CopilotAuthCancelledEvent>(
                'ai:copilot-auth-cancelled',
                (event) => {
                  if (event.payload.request_id !== requestId) return;
                  finish(
                    () => reject(new Error('GitHub Copilot login was cancelled.')),
                    unlisteners
                  );
                }
              ),
              listen<tauriIpc.CopilotAuthErrorEvent>('ai:copilot-auth-error', (event) => {
                if (event.payload.request_id !== requestId) return;
                const error = new Error(event.payload.message);
                (error as Error & { code?: string }).code = event.payload.code;
                finish(() => reject(error), unlisteners);
              }),
            ]);

            await tauriIpc.aiStartCopilotAuth({ requestId, providerId });
          } catch (error) {
            finish(
              () =>
                reject(
                  new Error(getErrorMessage(error, 'Failed to start GitHub Copilot login.'))
                ),
              unlisteners
            );
          }
        })();
      });
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to connect with GitHub Copilot.');
      const isCancelled = message === 'GitHub Copilot login was cancelled.';
      const code =
        error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'copilot_auth_failed';
      set((state) => ({
        authErrorsByProvider: {
          ...state.authErrorsByProvider,
          [providerId]:
            isCancelled
              ? undefined
              : {
                  code,
                  message,
                },
        },
      }));
      await get().testConnection(providerId);
      throw new Error(message);
    } finally {
      set((state) => ({
        copilotAuthStateByProvider: {
          ...state.copilotAuthStateByProvider,
          [providerId]:
            state.copilotAuthStateByProvider[providerId]?.requestId === requestId
              ? undefined
              : state.copilotAuthStateByProvider[providerId],
        },
      }));
    }

    const result = await get().testConnection(providerId);
    if (result.success) {
      await get().loadProviderModels(providerId);
      await get().scanModelsForProvider(providerId);
    }
  },

  cancelCopilotAuth: async (providerId: string) => {
    if (!tauriIpc.isTauriAvailable()) {
      return;
    }

    const requestId = get().copilotAuthStateByProvider[providerId]?.requestId;
    if (!requestId) {
      return;
    }

    await tauriIpc.aiCancelCopilotAuth(requestId);
    set((state) => ({
      copilotAuthStateByProvider: {
        ...state.copilotAuthStateByProvider,
        [providerId]: undefined,
      },
    }));
    await get().testConnection(providerId);
  },

  disconnectProviderAuth: async (providerId: string) => {
    if (!tauriIpc.isTauriAvailable()) {
      throw new Error('Provider auth disconnect requires the desktop app.');
    }

    const provider = get().providerConfigs.find((entry) => entry.id === providerId);
    if (provider?.providerType === 'copilot') {
      throw new Error('GitHub Copilot sign-out is managed in your terminal. Run `copilot logout` there.');
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
    const { providerConfigs, resolveProviderApiKey } = get();
    const config = providerConfigs.find((c) => c.id === providerId);
    
    if (!config) {
      return { success: false, message: 'Provider not found' };
    }

    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [providerId]: 'checking' },
    }));

    if (isLinkedProviderType(config.providerType)) {
      if (config.providerType !== 'copilot' && config.authStatus === 'authorizing') {
        return {
          success: false,
          message: 'Browser login is in progress.',
        };
      }

      if (config.providerType === 'copilot') {
        if (!tauriIpc.isTauriAvailable()) {
          const message = 'GitHub Copilot status checks require the desktop app.';
          set((state) => ({
            connectionStatus: {
              ...state.connectionStatus,
              [providerId]: 'offline',
            },
            providers: state.providers.map((p) =>
              p.id === providerId ? { ...p, status: 'offline' } : p
            ),
          }));

          return { success: false, message };
        }

        try {
          const status = await tauriIpc.aiGetCopilotStatus(providerId);
          const success = isCopilotConnected(status);
          const message = getCopilotStatusMessage(status);
          const authError = getCopilotAuthError(status);

          set((state) => ({
            copilotStatusByProvider: {
              ...state.copilotStatusByProvider,
              [providerId]: status,
            },
            connectionStatus: {
              ...state.connectionStatus,
              [providerId]: success ? 'online' : 'offline',
            },
            authErrorsByProvider: {
              ...state.authErrorsByProvider,
              [providerId]: authError,
            },
            providerConfigs: state.providerConfigs.map((provider) =>
              provider.id === providerId
                ? applyNativeToolCallingToProviderConfig({
                    ...provider,
                    authStatus: status.auth_status as ProviderConfig['authStatus'],
                    authSource: status.auth_source ?? undefined,
                    accountLabel: status.account_label ?? undefined,
                  })
                : provider
            ),
            providers: state.providers.map((p) =>
              p.id === providerId
                ? { ...p, status: success ? 'online' : 'offline' }
                : p
            ),
          }));

          return { success, message };
        } catch (error) {
          const message = getErrorMessage(error, 'Failed to check GitHub Copilot status.');
          set((state) => ({
            connectionStatus: {
              ...state.connectionStatus,
              [providerId]: 'offline',
            },
            copilotStatusByProvider: {
              ...state.copilotStatusByProvider,
              [providerId]: undefined,
            },
            authErrorsByProvider: {
              ...state.authErrorsByProvider,
              [providerId]: { code: 'copilot_health_failed', message },
            },
            providers: state.providers.map((p) =>
              p.id === providerId ? { ...p, status: 'offline' } : p
            ),
          }));

          return { success: false, message };
        }
      }

      const success = providerHasAuthSession(config);
      const message =
        success
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

    const apiKey = config.isLocal ? undefined : await resolveProviderApiKey(providerId);
    const result = await testProviderConnection(
      config.baseUrl,
      apiKey,
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
