import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  ProviderConfig,
  AIProvider,
  AIModel,
  ProviderSettings,
  ReasoningEffort,
} from '../types';
import * as tauriIpc from '../services/tauriIpc';
import {
  probeModelsEndpoint,
  probeProviderReachability,
} from '../services/providerApi';
import {
  buildCatalogModelContextLimitOverlay,
  buildProviderModelContextLimitOverlay,
  enrichModelWithCatalogContextLimits,
  inferProviderContextWindowTokens,
  inferProviderInputLimitTokens,
  inferProviderOutputLimitTokens,
  mergeProviderModelContextLimitOverlays,
} from '../services/providerModelContextLimits';
import { refreshModelContextCatalog } from '../services/modelContextCatalog';
import { findProviderConfig, loadAIConfigFile } from '../services/aiConfig';
import { getReasoningCapabilityForModel, getValidReasoningEffort } from '../services/reasoningCatalog';
import {
  isLinkedProviderType,
  providerHasAuthSession,
  providerHasUsableCredentials,
} from '../services/providerCredentials';
import { devLogger } from '../utils/devLogger';

export { isLinkedProviderType, providerHasAuthSession };

const {
  isTauriAvailable: ipcIsTauriAvailable,
  revealProviderApiKey: ipcRevealProviderApiKey,
  listProviderConfigs: ipcListProviderConfigs,
  listProviderModels: ipcListProviderModels,
  getProviderSettings: ipcGetProviderSettings,
  updateProviderConfig: ipcUpdateProviderConfig,
  createProviderConfig: ipcCreateProviderConfig,
} = tauriIpc;

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

type ProviderModelRefreshReason =
  | 'boot'
  | 'provider_selection'
  | 'model_selection'
  | 'pre_send'
  | 'manual';

const MODEL_REFRESH_SELECTION_COOLDOWN_MS = 5 * 60 * 1000;
const MODEL_CONTEXT_METADATA_STALE_MS = 5 * 60 * 1000;
const modelRefreshInFlightByProviderId = new Map<string, Promise<AIModel[]>>();
const lastModelRefreshStartedAtByProviderId = new Map<string, number>();

const NATIVE_TOOL_CALLING_PROVIDER_TYPES = new Set(['chatgpt', 'copilot', 'openai', 'openrouter']);
const PROVIDER_CONFIGURATION_REQUIRES_DESKTOP_IPC =
  'Provider configuration requires Tauri IPC; use remote transport for web/mobile runtimes.';

const requireProviderConfigurationIpc = (): void => {
  if (!ipcIsTauriAvailable()) {
    throw new Error(PROVIDER_CONFIGURATION_REQUIRES_DESKTOP_IPC);
  }
};

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
    contextWindowTokens: model.context_window_tokens ?? undefined,
    inputLimitTokens: model.input_limit_tokens ?? undefined,
    outputLimitTokens: model.output_limit_tokens ?? undefined,
    contextWindowSource:
      (model.context_window_source as AIModel['contextWindowSource'] | null) ??
      (model.context_window_tokens
        ? model.is_manual
          ? 'user_override'
          : 'model_metadata'
        : undefined),
    contextLimitsUpdatedAt: model.context_limits_updated_at ?? undefined,
    first_seen_at: model.first_seen_at,
    last_seen_at: model.last_seen_at,
    db_id: model.id,
    nativeToolCalling: supportsNativeToolCallingForProviderType(providerType),
  };
  return { ...normalized, isFree: computeIsFreeModel(normalized) };
};

const enrichModelsWithCatalogContextLimits = (
  models: AIModel[],
  params: {
    providerType?: string | null;
    providerId?: string | null;
    baseUrl?: string | null;
  }
): AIModel[] =>
  models.map((model) =>
    enrichModelWithCatalogContextLimits(model, params),
  );

const toDbProviderModelInput = (model: AIModel): tauriIpc.DbProviderModelInput => ({
  model_id: model.id,
  name: model.name || model.id,
  description: model.description ?? null,
  owned_by: model.owned_by ?? null,
  pricing_prompt: model.pricing?.prompt ?? null,
  pricing_completion: model.pricing?.completion ?? null,
  pricing_request: model.pricing?.request ?? null,
  reasoning_efforts: model.reasoningEfforts ?? null,
  default_reasoning_effort: model.defaultReasoningEffort ?? null,
  context_window_tokens: model.contextWindowTokens ?? null,
  input_limit_tokens: model.inputLimitTokens ?? null,
  output_limit_tokens: model.outputLimitTokens ?? null,
  context_window_source: model.contextWindowSource ?? null,
  context_limits_updated_at: model.contextLimitsUpdatedAt ?? null,
});

const modelContextFieldsChanged = (left: AIModel, right: AIModel): boolean =>
  left.contextWindowTokens !== right.contextWindowTokens ||
  left.inputLimitTokens !== right.inputLimitTokens ||
  left.outputLimitTokens !== right.outputLimitTokens ||
  left.contextWindowSource !== right.contextWindowSource ||
  left.contextLimitsUpdatedAt !== right.contextLimitsUpdatedAt;

const modelContextMetadataIsStale = (model: AIModel): boolean => {
  if (!model.contextLimitsUpdatedAt) return true;
  const updatedAt = Date.parse(model.contextLimitsUpdatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > MODEL_CONTEXT_METADATA_STALE_MS;
};

const shouldRefreshModelContextMetadata = (model: AIModel | undefined): boolean => {
  if (!model) return true;
  if (model.contextWindowSource === 'user_override') return false;
  if (!model.contextWindowTokens || !model.contextWindowSource) return true;
  if (model.contextWindowSource === 'macro_fallback') return true;
  return model.contextWindowSource === 'provider_metadata' && modelContextMetadataIsStale(model);
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

export const providerHasCredentials = (
  provider: Pick<
    ProviderConfig,
    'isEnabled' | 'isLocal' | 'apiKey' | 'hasStoredApiKey' | 'providerType' | 'authStatus'
  >
): boolean => providerHasUsableCredentials(provider);

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

const toAIProvider = (
  config: ProviderConfig,
  connectionStatus: 'online' | 'offline' | 'checking' | undefined = undefined
): AIProvider =>
  applyNativeToolCallingToProvider(
    {
      id: config.id,
      name: config.name,
      status: toProviderStatus(config, connectionStatus),
      baseUrl: config.baseUrl,
      isLocal: config.isLocal,
      isEnabled: config.isEnabled,
    },
    config.providerType
  );

const normalizeCreatedProviderConfig = (
  config: tauriIpc.DbProviderConfig,
  apiKey?: string
): ProviderConfig => {
  const trimmedApiKey = apiKey?.trim();
  return applyNativeToolCallingToProviderConfig({
    ...normalizeDbProviderConfig(config),
    apiKey: trimmedApiKey ? apiKey : undefined,
    apiKeyLoaded: !!trimmedApiKey,
  });
};

export type ProviderReachabilityStatus =
  | 'unknown'
  | 'checking'
  | 'reachable'
  | 'unreachable'
  | 'probe_unsupported';

export type ProviderReachabilityVerifiedBy =
  | 'models_endpoint'
  | 'chat_completions_probe'
  | 'chat_completion_runtime'
  | 'linked_auth';

export interface ProviderReachabilityRecord {
  status: ProviderReachabilityStatus;
  lastVerifiedAt?: string;
  lastVerifiedBy?: ProviderReachabilityVerifiedBy;
  lastError?: string;
  modelIdUsed?: string;
}

export interface ProviderConnectionTestResult {
  success: boolean;
  message: string;
  status: ProviderReachabilityStatus;
  source?: ProviderReachabilityVerifiedBy;
  modelIdUsed?: string;
}

const toLegacyConnectionStatus = (
  status: ProviderReachabilityStatus
): 'online' | 'offline' | 'checking' | undefined => {
  if (status === 'reachable') return 'online';
  if (status === 'unreachable') return 'offline';
  if (status === 'checking') return 'checking';
  return undefined;
};

const omitRuntimeStateKey = <T extends Record<string, unknown>>(input: T, providerId: string): T => {
  const { [providerId]: _removed, ...rest } = input;
  return rest as T;
};

const buildReachabilityRecord = (params: {
  status: ProviderReachabilityStatus;
  lastVerifiedBy?: ProviderReachabilityVerifiedBy;
  lastError?: string;
  modelIdUsed?: string;
}): ProviderReachabilityRecord => ({
  status: params.status,
  lastVerifiedAt:
    params.status === 'checking' || params.status === 'unknown'
      ? undefined
      : new Date().toISOString(),
  lastVerifiedBy: params.lastVerifiedBy,
  lastError: params.lastError,
  modelIdUsed: params.modelIdUsed,
});

const applyReachabilityState = <
  T extends Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'>
>(
  state: T,
  providerId: string,
  next: ProviderReachabilityRecord | undefined
): Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'> => {
  const providerReachabilityById = next
    ? { ...state.providerReachabilityById, [providerId]: next }
    : omitRuntimeStateKey(state.providerReachabilityById, providerId);
  const legacyStatus = next ? toLegacyConnectionStatus(next.status) : undefined;
  const connectionStatus = legacyStatus
    ? { ...state.connectionStatus, [providerId]: legacyStatus }
    : omitRuntimeStateKey(state.connectionStatus, providerId);

  return {
    providerReachabilityById,
    connectionStatus,
    providers: state.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            status: next?.status === 'reachable' ? 'online' : 'offline',
          }
        : provider
    ),
  };
};

const withReachabilityRecord = <
  T extends Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'>
>(
  state: T,
  providerId: string,
  params: Parameters<typeof buildReachabilityRecord>[0]
): Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'> =>
  applyReachabilityState(state, providerId, buildReachabilityRecord(params));

const clearProviderReachability = <
  T extends Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'>
>(
  state: T,
  providerId: string
): Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'> =>
  applyReachabilityState(state, providerId, undefined);

const invalidateRuntimeProviderReachability = <
  T extends Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'>
>(
  state: T,
  providerId: string,
  providerType?: string | null
): Partial<Pick<ProviderStore, 'providerReachabilityById' | 'connectionStatus' | 'providers'>> =>
  isLinkedProviderType(providerType) ? {} : clearProviderReachability(state, providerId);

const getReachabilityProbeModels = (params: {
  providerId: string;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  modelsByProvider: Record<string, AIModel[]>;
}): { preferredModelId: string | null; modelIds: string[] } => {
  const models = (params.modelsByProvider[params.providerId] || []).filter(
    (model) => model.isEnabled !== false
  );
  const preferredModelId =
    params.selectedProviderId === params.providerId ? params.selectedModelId : null;
  const modelIds = models
    .map((model) => model.id)
    .filter((modelId) => modelId !== preferredModelId);

  return { preferredModelId, modelIds };
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

const applyCopilotStatusPatch = (
  state: ProviderStore,
  providerId: string,
  status: tauriIpc.CopilotStatusDto
): Partial<ProviderStore> => {
  const success = isCopilotConnected(status);
  const message = getCopilotStatusMessage(status);
  const authError = getCopilotAuthError(status);

  return {
    copilotStatusByProvider: {
      ...state.copilotStatusByProvider,
      [providerId]: status,
    },
    ...withReachabilityRecord(state, providerId, {
      status: success ? 'reachable' : 'unreachable',
      lastVerifiedBy: 'linked_auth',
      lastError: success ? undefined : message,
    }),
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
  };
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
  providerReachabilityById: Record<string, ProviderReachabilityRecord | undefined>;
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
  refreshModelsForProviderIfNeeded: (
    providerId: string,
    reason: ProviderModelRefreshReason
  ) => Promise<AIModel[]>;
  ensureSelectedModelContextMetadata: (
    providerId: string,
    modelId: string,
    reason: ProviderModelRefreshReason
  ) => Promise<AIModel[]>;
  refreshLoadedModelContextCatalog: (providerId?: string) => Promise<void>;
  setProviderModelEnabled: (providerId: string, modelId: string, enabled: boolean) => Promise<void>;
  setAllProviderModelsEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  addManualModel: (providerId: string, modelId: string, name: string) => Promise<void>;
  updateManualModel: (
    providerId: string,
    currentModelId: string,
    nextModelId: string,
    name: string
  ) => Promise<void>;
  recordProviderModelContextOverflowLimit: (
    providerId: string,
    modelId: string,
    contextWindowTokens: number,
  ) => Promise<void>;
  resetProviderModelContextOverflowLimit: (
    providerId: string,
    modelId: string,
  ) => Promise<void>;
  setProviderModelContextWindowOverride: (
    providerId: string,
    modelId: string,
    contextWindowTokens: number | null,
  ) => Promise<void>;
  deleteManualModel: (providerId: string, modelId: string) => Promise<void>;
  loadProviderSettings: (providerId: string) => Promise<ProviderSettings | null>;
  updateProviderSettings: (providerId: string, updates: Partial<ProviderSettings>) => Promise<void>;
  commitRestoredSelection: (
    selection: {
      providerId: string;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort | null;
    },
    options?: { isActive?: () => boolean }
  ) => Promise<{
    providerId: string;
    modelId: string;
    reasoningEffort: ReasoningEffort | null;
  } | null>;
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
  testConnection: (providerId: string) => Promise<ProviderConnectionTestResult>;
  markProviderReachable: (providerId: string, options?: { modelId?: string | null }) => void;
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
  providerReachabilityById: {},
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

  markProviderReachable: (providerId: string, options?: { modelId?: string | null }) => {
    const provider = get().providerConfigs.find((entry) => entry.id === providerId);
    if (!provider || isLinkedProviderType(provider.providerType)) {
      return;
    }

    set((state) => ({
      ...withReachabilityRecord(state, providerId, {
        status: 'reachable',
        lastVerifiedBy: 'chat_completion_runtime',
        modelIdUsed: options?.modelId ?? undefined,
      }),
    }));
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

  refreshModelsForProviderIfNeeded: async (providerId, reason) => {
    const provider = get().providerConfigs.find((candidate) => candidate.id === providerId);
    if (!provider || !providerHasCredentials(provider)) {
      devLogger.debug('[providers] skipped model refresh: unavailable provider', {
        providerId,
        reason,
      });
      return get().modelsByProvider[providerId] || [];
    }

    const inFlight = modelRefreshInFlightByProviderId.get(providerId);
    if (inFlight) {
      devLogger.debug('[providers] reusing in-flight model refresh', {
        providerId,
        reason,
      });
      return inFlight;
    }

    const now = Date.now();
    const lastStartedAt = lastModelRefreshStartedAtByProviderId.get(providerId) ?? 0;
    if (
      reason !== 'manual' &&
      lastStartedAt > 0 &&
      now - lastStartedAt < MODEL_REFRESH_SELECTION_COOLDOWN_MS
    ) {
      devLogger.debug('[providers] skipped model refresh: cooldown', {
        providerId,
        reason,
        remainingMs: MODEL_REFRESH_SELECTION_COOLDOWN_MS - (now - lastStartedAt),
      });
      return get().modelsByProvider[providerId] || [];
    }

    lastModelRefreshStartedAtByProviderId.set(providerId, now);
    devLogger.debug('[providers] refreshing models', { providerId, reason });
    const refreshPromise = get()
      .scanModelsForProvider(providerId)
      .catch((error) => {
        devLogger.warn('[providers] model refresh failed', {
          providerId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        return get().modelsByProvider[providerId] || [];
      })
      .finally(() => {
        modelRefreshInFlightByProviderId.delete(providerId);
      });

    modelRefreshInFlightByProviderId.set(providerId, refreshPromise);
    return refreshPromise;
  },

  ensureSelectedModelContextMetadata: async (providerId, modelId, reason) => {
    const provider = get().providerConfigs.find((candidate) => candidate.id === providerId);
    const model = (get().modelsByProvider[providerId] || []).find(
      (candidate) => candidate.id === modelId,
    );

    if (!provider || !providerHasCredentials(provider)) {
      return get().modelsByProvider[providerId] || [];
    }
    if (!shouldRefreshModelContextMetadata(model)) {
      return get().modelsByProvider[providerId] || [];
    }

    return get().refreshModelsForProviderIfNeeded(providerId, reason);
  },

  refreshLoadedModelContextCatalog: async (providerId?: string) => {
    await refreshModelContextCatalog();

    const state = get();
    const providerIds = providerId
      ? [providerId]
      : Object.keys(state.modelsByProvider);
    const nextModelsByProvider = { ...state.modelsByProvider };
    const changedModelsByProvider: Record<string, AIModel[]> = {};

    for (const currentProviderId of providerIds) {
      const models = state.modelsByProvider[currentProviderId] || [];
      if (models.length === 0) continue;

      const providerConfig = state.providerConfigs.find(
        (provider) => provider.id === currentProviderId,
      );
      const enriched = models.map((model) =>
        enrichModelWithCatalogContextLimits(
          model,
          {
            providerType: providerConfig?.providerType,
            providerId: currentProviderId,
            baseUrl: providerConfig?.baseUrl,
          },
          { refreshCatalogSource: true },
        ),
      );
      const changed = enriched.filter((model, index) =>
        modelContextFieldsChanged(models[index] ?? model, model),
      );
      if (changed.length === 0) continue;

      nextModelsByProvider[currentProviderId] = sortModelsByName(enriched);
      changedModelsByProvider[currentProviderId] = changed;
    }

    if (Object.keys(changedModelsByProvider).length === 0) {
      return;
    }

    set({ modelsByProvider: nextModelsByProvider });

    if (!tauriIpc.isTauriAvailable()) {
      return;
    }

    await Promise.all(
      Object.entries(changedModelsByProvider).map(
        async ([currentProviderId, changedModels]) => {
          const reliableCatalogModels = changedModels.filter(
            (model) => model.contextWindowSource === 'models_dev',
          );
          if (reliableCatalogModels.length === 0) return;
          await tauriIpc.upsertProviderModels({
            providerId: currentProviderId,
            models: reliableCatalogModels.map(toDbProviderModelInput),
          });
        },
      ),
    );
  },

  initialize: async () => {
    const { loadProviderConfigs, loadProviderModels, testConnection } = get();
    await loadProviderConfigs();

    const { providerConfigs, selectedProviderId } = get();

    const connectivityChecks: Array<Promise<unknown>> = [];

    for (const provider of providerConfigs) {
      await loadProviderModels(provider.id);
      const models = get().modelsByProvider[provider.id] || [];

      if (!provider.isEnabled) {
        continue;
      }

      if (provider.id === selectedProviderId) {
        connectivityChecks.push(get().refreshModelsForProviderIfNeeded(provider.id, 'boot'));
        continue;
      }

      if (provider.providerType === 'copilot') {
        connectivityChecks.push(testConnection(provider.id));
        continue;
      }

      // Avoid secret reveals on boot for API-key and ChatGPT providers.
      if (!provider.isLocal) {
        continue;
      }

      connectivityChecks.push(
        models.length === 0
          ? get().refreshModelsForProviderIfNeeded(provider.id, 'boot')
          : testConnection(provider.id)
      );
    }

    void Promise.allSettled(connectivityChecks);
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

    if (!ipcIsTauriAvailable()) {
      return config.apiKey?.trim() ? config.apiKey : undefined;
    }

    try {
      const apiKey = (await ipcRevealProviderApiKey(providerId)) || undefined;
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
      if (ipcIsTauriAvailable()) {
        const currentProviderConfigs = get().providerConfigs;
        const configs = await ipcListProviderConfigs();
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
        const nextSelectedProviderId =
          currentSelectedProvider && providerHasCredentials(currentSelectedProvider)
            ? currentSelectedProvider.id
            : null;
        const nextSelectedModelId =
          nextSelectedProviderId === currentSelectedProviderId
            ? currentSelectedModelId
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
        
        const providers: AIProvider[] = providerConfigs.map((config) =>
          toAIProvider(config, get().connectionStatus[config.id])
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
        set({
          providerConfigs: [],
          providers: [],
          isLoading: false,
          selectedProviderId: null,
          selectedModelId: null,
          selectedReasoningEffort: null,
        });
        throw new Error(PROVIDER_CONFIGURATION_REQUIRES_DESKTOP_IPC);
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
    const providerConfig = providerConfigs.find((provider) => provider.id === providerId);
    const providerType = providerConfig?.providerType;
    if (ipcIsTauriAvailable()) {
      set({ isLoadingModels: true });
      try {
        void refreshModelContextCatalog();
        const models = await ipcListProviderModels(providerId);
        const normalized = enrichModelsWithCatalogContextLimits(
          models.map((model) => normalizeDbModel(model, providerType)),
          {
            providerType,
            providerId,
            baseUrl: providerConfig?.baseUrl,
          },
        );
        const currentSelectedModelId = get().selectedModelId;
        const candidateSelectedModelId =
          currentSelectedModelId == null
            ? null
            : normalized.some((m) => m.id === currentSelectedModelId && m.isEnabled !== false)
              ? currentSelectedModelId
              : getFirstEnabledModelId(normalized);
        const selectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId,
          modelId: candidateSelectedModelId,
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
        void get().refreshLoadedModelContextCatalog(providerId);

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId && selectedModelId) {
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
        ...withReachabilityRecord(state, providerId, {
          status: 'checking',
          lastVerifiedBy: 'linked_auth',
        }),
      }));

      try {
        void refreshModelContextCatalog();
        const updated = tauriIpc.isTauriAvailable()
          ? await tauriIpc.aiSyncProviderModels(providerId)
          : [];
        let normalized = enrichModelsWithCatalogContextLimits(
          updated.map((model) => normalizeDbModel(model, config.providerType)),
          {
            providerType: config.providerType,
            providerId,
            baseUrl: config.baseUrl,
          },
        );
        if (tauriIpc.isTauriAvailable()) {
          const hasCatalogEnrichment = normalized.some(
            (model) => model.contextWindowSource === 'models_dev',
          );
          if (hasCatalogEnrichment) {
            const persisted = await tauriIpc.upsertProviderModels({
              providerId,
              models: normalized.map(toDbProviderModelInput),
            });
            normalized = enrichModelsWithCatalogContextLimits(
              persisted.map((model) => normalizeDbModel(model, config.providerType)),
              {
                providerType: config.providerType,
                providerId,
                baseUrl: config.baseUrl,
              },
            );
          }
        }
        const currentSelectedModelId = get().selectedModelId;
        const candidateSelectedModelId =
          currentSelectedModelId == null
            ? null
            : normalized.some((m) => m.id === currentSelectedModelId && m.isEnabled !== false)
              ? currentSelectedModelId
              : getFirstEnabledModelId(normalized);
        const nextSelectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId,
          modelId: candidateSelectedModelId,
          modelsByProvider: {
            ...get().modelsByProvider,
            [providerId]: normalized,
          },
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        });
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          ...withReachabilityRecord(state, providerId, {
            status: 'reachable',
            lastVerifiedBy: 'linked_auth',
          }),
          isLoadingModels: false,
          ...(state.selectedProviderId === providerId ? { selectedReasoningEffort: nextSelectedReasoningEffort } : {}),
        }));
        void get().refreshLoadedModelContextCatalog(providerId);

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId && selectedModelId) {
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
          ...withReachabilityRecord(state, providerId, {
            status: 'unreachable',
            lastVerifiedBy: 'linked_auth',
            lastError: message,
          }),
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
      ...withReachabilityRecord(state, providerId, { status: 'checking' }),
    }));

    try {
      const result = await probeModelsEndpoint({
        baseUrl: config.baseUrl,
        apiKey,
        providerId: config.providerType,
        providerType: config.providerType,
      });

      if (!result.success) {
        set((state) => ({
          ...withReachabilityRecord(state, providerId, {
            status: result.status,
            lastVerifiedBy: result.source,
            lastError: result.message,
            modelIdUsed: result.modelIdUsed,
          }),
          isLoadingModels: false,
          lastError: result.message,
        }));

        return modelsByProvider[providerId] || [];
      }

      if (tauriIpc.isTauriAvailable()) {
        void refreshModelContextCatalog();
        const updated = await tauriIpc.upsertProviderModels({
          providerId,
          models: result.models.map((model) => {
            const existingModel = (modelsByProvider[providerId] || []).find(
              (candidate) => candidate.id === model.id,
            );
            const reasoningCapability = getReasoningCapabilityForModel({
              providerType: config.providerType,
              modelId: model.id,
              supportedParameters: model.supported_parameters,
              supportedReasoningEfforts: model.supported_reasoning_efforts,
              defaultReasoningEffort: model.default_reasoning_effort,
            });
            const providerContextWindowTokens = inferProviderContextWindowTokens(model);
            const providerInputLimitTokens = inferProviderInputLimitTokens(model);
            const providerOutputLimitTokens = inferProviderOutputLimitTokens(model);
            const catalogOverlay = providerContextWindowTokens
              ? {}
              : buildCatalogModelContextLimitOverlay({
                  providerType: config.providerType,
                  providerId,
                  baseUrl: config.baseUrl,
                  modelId: model.id,
                });
            const contextWindowTokens =
              providerContextWindowTokens ??
              catalogOverlay.contextWindowTokens ??
              null;
            const contextWindowSource = providerContextWindowTokens
              ? 'provider_metadata'
              : catalogOverlay.contextWindowSource ?? null;
            const contextLimitsUpdatedAt =
              contextWindowSource === 'provider_metadata'
                ? new Date().toISOString()
                : catalogOverlay.contextLimitsUpdatedAt ?? null;
            const userOverrideContext =
              existingModel?.contextWindowSource === 'user_override' &&
              existingModel.contextWindowTokens
                ? {
                    contextWindowTokens: existingModel.contextWindowTokens,
                    contextWindowSource: 'user_override' as const,
                    contextLimitsUpdatedAt:
                      existingModel.contextLimitsUpdatedAt ?? contextLimitsUpdatedAt,
                  }
                : null;

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
              context_window_tokens:
                userOverrideContext?.contextWindowTokens ?? contextWindowTokens,
              input_limit_tokens:
                providerInputLimitTokens ?? catalogOverlay.inputLimitTokens ?? null,
              output_limit_tokens:
                providerOutputLimitTokens ?? catalogOverlay.outputLimitTokens ?? null,
              context_window_source:
                userOverrideContext?.contextWindowSource ?? contextWindowSource,
              context_limits_updated_at:
                userOverrideContext?.contextLimitsUpdatedAt ?? contextLimitsUpdatedAt,
            };
          }),
        });

        const normalized = enrichModelsWithCatalogContextLimits(
          mergeProviderModelContextLimitOverlays(
            updated.map((model) => normalizeDbModel(model, config.providerType)),
            result.models,
          ),
          {
            providerType: config.providerType,
            providerId,
            baseUrl: config.baseUrl,
          },
        );
        const currentSelectedModelId = get().selectedModelId;
        const candidateSelectedModelId =
          currentSelectedModelId == null
            ? null
            : normalized.some((m) => m.id === currentSelectedModelId && m.isEnabled !== false)
              ? currentSelectedModelId
              : getFirstEnabledModelId(normalized);
        const nextSelectedReasoningEffort = resolveSelectedReasoningEffort({
          providerId,
          modelId: candidateSelectedModelId,
          modelsByProvider: {
            ...get().modelsByProvider,
            [providerId]: normalized,
          },
          unsupported: get().reasoningUnsupportedModelKeys,
          requested: get().selectedReasoningEffort,
        });
        set((state) => ({
          modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
          ...withReachabilityRecord(state, providerId, {
            status: 'reachable',
            lastVerifiedBy: result.source,
          }),
          isLoadingModels: false,
          ...(state.selectedProviderId === providerId ? { selectedReasoningEffort: nextSelectedReasoningEffort } : {}),
        }));
        void get().refreshLoadedModelContextCatalog(providerId);

        const { selectedProviderId, selectedModelId } = get();
        if (selectedProviderId === providerId && selectedModelId) {
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

      void refreshModelContextCatalog();
      const models: AIModel[] = result.models.map((m) => {
        const existingModel = (modelsByProvider[providerId] || []).find(
          (candidate) => candidate.id === m.id,
        );
        const reasoningCapability = getReasoningCapabilityForModel({
          providerType: config.providerType,
          modelId: m.id,
          supportedParameters: m.supported_parameters,
          supportedReasoningEfforts: m.supported_reasoning_efforts,
          defaultReasoningEffort: m.default_reasoning_effort,
        });
        const providerOverlay = buildProviderModelContextLimitOverlay(m);
        const catalogOverlay = providerOverlay.contextWindowTokens
          ? {}
          : buildCatalogModelContextLimitOverlay({
              providerType: config.providerType,
              providerId,
              baseUrl: config.baseUrl,
              modelId: m.id,
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
          ...catalogOverlay,
          ...providerOverlay,
          ...(existingModel?.contextWindowSource === 'user_override' &&
          existingModel.contextWindowTokens
            ? {
                contextWindowTokens: existingModel.contextWindowTokens,
                contextWindowSource: existingModel.contextWindowSource,
                contextLimitsUpdatedAt: existingModel.contextLimitsUpdatedAt,
              }
            : {}),
        } satisfies AIModel;
        return { ...normalized, isFree: computeIsFreeModel(normalized) };
      });

      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: models },
        ...withReachabilityRecord(state, providerId, {
          status: 'reachable',
          lastVerifiedBy: result.source,
        }),
        isLoadingModels: false,
      }));
      void get().refreshLoadedModelContextCatalog(providerId);

      return models;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan models';
      set((state) => ({
        ...withReachabilityRecord(state, providerId, {
          status: 'unreachable',
          lastVerifiedBy: 'models_endpoint',
          lastError: message,
        }),
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
        ...invalidateRuntimeProviderReachability(state, providerId, providerType),
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
      ...invalidateRuntimeProviderReachability(
        state,
        providerId,
        get().providerConfigs.find((provider) => provider.id === providerId)?.providerType
      ),
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
        ...invalidateRuntimeProviderReachability(state, providerId, providerType),
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
          ...invalidateRuntimeProviderReachability(
            state,
            providerId,
            get().providerConfigs.find((provider) => provider.id === providerId)?.providerType
          ),
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

  recordProviderModelContextOverflowLimit: async (
    providerId: string,
    modelId: string,
    contextWindowTokens: number,
  ) => {
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return;
    const currentModels = get().modelsByProvider[providerId] || [];
    const currentModel = currentModels.find((model) => model.id === modelId);
    if (!currentModel) return;
    const observedLimit = Math.trunc(contextWindowTokens);
    if (currentModel.contextWindowSource === 'user_override') {
      return;
    }
    if (
      currentModel.contextWindowTokens &&
      observedLimit >= currentModel.contextWindowTokens
    ) {
      return;
    }

    const updatedAt = new Date().toISOString();
    const nextModel: AIModel = {
      ...currentModel,
      contextWindowTokens: observedLimit,
      contextWindowSource: 'provider_overflow_error',
      contextLimitsUpdatedAt: updatedAt,
    };
    const providerType = get().providerConfigs.find(
      (provider) => provider.id === providerId,
    )?.providerType;

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.upsertProviderModels({
        providerId,
        models: [toDbProviderModelInput(nextModel)],
      });
    }

    set((state) => {
      const models = state.modelsByProvider[providerId] || [];
      const normalized = sortModelsByName(
        models.map((model) =>
          model.id === modelId
            ? {
                ...nextModel,
                nativeToolCalling:
                  supportsNativeToolCallingForProviderType(providerType),
                isFree: computeIsFreeModel(nextModel),
              }
            : model,
        ),
      );
      return {
        modelsByProvider: {
          ...state.modelsByProvider,
          [providerId]: normalized,
        },
      };
    });
  },

  resetProviderModelContextOverflowLimit: async (
    providerId: string,
    modelId: string,
  ) => {
    const currentModels = get().modelsByProvider[providerId] || [];
    const currentModel = currentModels.find((model) => model.id === modelId);
    if (!currentModel || currentModel.contextWindowSource !== 'provider_overflow_error') {
      return;
    }

    const providerConfig = get().providerConfigs.find(
      (provider) => provider.id === providerId,
    );
    const {
      contextWindowTokens: _contextWindowTokens,
      contextWindowSource: _contextWindowSource,
      contextLimitsUpdatedAt: _contextLimitsUpdatedAt,
      ...modelWithoutLearnedLimit
    } = currentModel;
    const catalogOverlay = buildCatalogModelContextLimitOverlay({
      providerType: providerConfig?.providerType,
      providerId,
      baseUrl: providerConfig?.baseUrl,
      modelId,
    });
    const nextModel: AIModel = {
      ...modelWithoutLearnedLimit,
      ...catalogOverlay,
    };

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.upsertProviderModels({
        providerId,
        models: [toDbProviderModelInput(nextModel)],
      });
    }

    set((state) => {
      const models = state.modelsByProvider[providerId] || [];
      const normalized = sortModelsByName(
        models.map((model) =>
          model.id === modelId
            ? {
                ...nextModel,
                nativeToolCalling:
                  supportsNativeToolCallingForProviderType(providerConfig?.providerType),
                isFree: computeIsFreeModel(nextModel),
              }
            : model,
        ),
      );
      return {
        modelsByProvider: {
          ...state.modelsByProvider,
          [providerId]: normalized,
        },
      };
    });
  },

  setProviderModelContextWindowOverride: async (
    providerId: string,
    modelId: string,
    contextWindowTokens: number | null,
  ) => {
    const currentModels = get().modelsByProvider[providerId] || [];
    const currentModel = currentModels.find((model) => model.id === modelId);
    if (!currentModel) return;

    const providerConfig = get().providerConfigs.find(
      (provider) => provider.id === providerId,
    );
    const normalizedTokens =
      typeof contextWindowTokens === 'number' &&
      Number.isFinite(contextWindowTokens) &&
      contextWindowTokens > 0
        ? Math.trunc(contextWindowTokens)
        : null;
    if (contextWindowTokens !== null && !normalizedTokens) {
      throw new Error('Context window must be a positive token count.');
    }

    const {
      contextWindowTokens: _overrideContextWindowTokens,
      contextWindowSource: _overrideContextWindowSource,
      contextLimitsUpdatedAt: _overrideContextLimitsUpdatedAt,
      ...baseModel
    } = currentModel;
    const nextModel: AIModel = normalizedTokens
      ? {
          ...currentModel,
          contextWindowTokens: normalizedTokens,
          contextWindowSource: 'user_override',
          contextLimitsUpdatedAt: new Date().toISOString(),
        }
      : enrichModelWithCatalogContextLimits(baseModel, {
          providerType: providerConfig?.providerType,
          providerId,
          baseUrl: providerConfig?.baseUrl,
        });

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.upsertProviderModels({
        providerId,
        models: [toDbProviderModelInput(nextModel)],
      });
    }

    set((state) => {
      const providerType = state.providerConfigs.find(
        (provider) => provider.id === providerId,
      )?.providerType;
      const models = state.modelsByProvider[providerId] || [];
      const normalized = sortModelsByName(
        models.map((model) =>
          model.id === modelId
            ? {
                ...nextModel,
                nativeToolCalling:
                  supportsNativeToolCallingForProviderType(providerType),
                isFree: computeIsFreeModel(nextModel),
              }
            : model,
        ),
      );
      return {
        modelsByProvider: {
          ...state.modelsByProvider,
          [providerId]: normalized,
        },
      };
    });

    if (!normalizedTokens && providerConfig && providerHasCredentials(providerConfig)) {
      void get().refreshModelsForProviderIfNeeded(providerId, 'manual');
    }
  },

  deleteManualModel: async (providerId: string, modelId: string) => {
    if (tauriIpc.isTauriAvailable()) {
      const updated = await tauriIpc.deleteManualModel({ providerId, modelId });
      const providerType = get().providerConfigs.find((provider) => provider.id === providerId)?.providerType;
      const normalized = updated.map((model) => normalizeDbModel(model, providerType));
      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [providerId]: normalized },
        ...invalidateRuntimeProviderReachability(state, providerId, providerType),
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
        ...invalidateRuntimeProviderReachability(
          state,
          providerId,
          get().providerConfigs.find((provider) => provider.id === providerId)?.providerType
        ),
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
    if (ipcIsTauriAvailable()) {
      try {
        const settings = await ipcGetProviderSettings(providerId);
        const normalized: ProviderSettings = {
          providerId: settings.provider_id,
          filterFreeModels: settings.filter_free_models,
          copilotSendTimeoutMs: settings.copilot_send_timeout_ms,
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

    const fallback: ProviderSettings = {
      providerId,
      filterFreeModels: false,
      copilotSendTimeoutMs: null,
    };
    set((state) => ({
      providerSettingsById: { ...state.providerSettingsById, [providerId]: fallback },
    }));
    return fallback;
  },

  updateProviderSettings: async (providerId: string, updates: Partial<ProviderSettings>) => {
    const current = get().providerSettingsById[providerId] ?? {
      providerId,
      filterFreeModels: false,
      copilotSendTimeoutMs: null,
    };
    const next: ProviderSettings = { ...current, ...updates, providerId };

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.updateProviderSettings({
        providerId,
        ...(Object.prototype.hasOwnProperty.call(updates, 'filterFreeModels')
          ? { filterFreeModels: next.filterFreeModels }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(updates, 'copilotSendTimeoutMs')
          ? { copilotSendTimeoutMs: next.copilotSendTimeoutMs ?? null }
          : {}),
      });
    }

    set((state) => ({
      providerSettingsById: { ...state.providerSettingsById, [providerId]: next },
    }));
  },

  commitRestoredSelection: async (selection, options) => {
    const { providerId } = selection;
    const provider = get().providerConfigs.find((candidate) => candidate.id === providerId);
    if (!provider || !providerHasCredentials(provider)) {
      return null;
    }

    const isActive = options?.isActive ?? (() => true);
    if (!isActive()) {
      return null;
    }

    let models = get().modelsByProvider[providerId] || [];
    if (models.length === 0) {
      models = await get().loadProviderModels(providerId);
      if (!isActive()) {
        return null;
      }
    }

    let resolvedModelId = selection.modelId ?? null;
    let hasResolvedModel =
      !!resolvedModelId &&
      models.some((model) => model.id === resolvedModelId && model.isEnabled !== false);

    if ((models.length === 0 || (resolvedModelId && !hasResolvedModel)) && providerHasCredentials(provider)) {
      const scannedModels = await get().scanModelsForProvider(providerId);
      if (!isActive()) {
        return null;
      }
      if (scannedModels.length > 0) {
        models = scannedModels;
      }
      hasResolvedModel =
        !!resolvedModelId &&
        models.some((model) => model.id === resolvedModelId && model.isEnabled !== false);
    }

    if (!resolvedModelId || !hasResolvedModel) {
      resolvedModelId = getFirstEnabledModelId(models);
    }

    if (!resolvedModelId) {
      return null;
    }

    const selectedReasoningEffort = resolveSelectedReasoningEffort({
      providerId,
      modelId: resolvedModelId,
      modelsByProvider: {
        ...get().modelsByProvider,
        [providerId]: models,
      },
      unsupported: get().reasoningUnsupportedModelKeys,
      requested: selection.reasoningEffort ?? null,
    });

    if (!isActive()) {
      return null;
    }

    set({
      selectedProviderId: providerId,
      selectedModelId: resolvedModelId,
      selectedReasoningEffort,
    });
    void get().refreshModelsForProviderIfNeeded(providerId, 'boot');

    return {
      providerId,
      modelId: resolvedModelId,
      reasoningEffort: selectedReasoningEffort,
    };
  },

  selectProvider: (providerId: string) => {
    const { providers, loadProviderModels, selectedProviderId } = get();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;

    set({
      selectedProviderId: providerId,
      selectedModelId: providerId === selectedProviderId ? get().selectedModelId : null,
      selectedReasoningEffort: providerId === selectedProviderId ? get().selectedReasoningEffort : null,
    });

    void (async () => {
      if ((get().modelsByProvider[providerId] || []).length === 0) {
        await loadProviderModels(providerId);
      }
      await get().refreshModelsForProviderIfNeeded(providerId, 'provider_selection');
    })();
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
    if (state.selectedProviderId) {
      void get().ensureSelectedModelContextMetadata(
        state.selectedProviderId,
        modelId,
        'model_selection',
      );
    }
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
      requireProviderConfigurationIpc();

      const currentConfig = get().providerConfigs.find((provider) => provider.id === id);
      const providerType = updates.providerType ?? currentConfig?.providerType;
      const currentApiKey = currentConfig?.apiKey?.trim() ?? '';
      const nextApiKey =
        updates.apiKey === undefined ? currentApiKey : updates.apiKey.trim();
      const shouldInvalidateReachability =
        !!currentConfig &&
        (
          (updates.baseUrl !== undefined && updates.baseUrl !== currentConfig.baseUrl) ||
          updates.providerType !== undefined ||
          updates.apiKey !== undefined && nextApiKey !== currentApiKey ||
          updates.isEnabled === false
        );
      const persistedUpdates = isLinkedProviderType(providerType)
        ? {
            ...updates,
            baseUrl: undefined,
            apiKey: undefined,
          }
        : updates;

      await ipcUpdateProviderConfig({
        id,
        name: persistedUpdates.name,
        providerType: persistedUpdates.providerType,
        baseUrl: persistedUpdates.baseUrl,
        apiKey: persistedUpdates.apiKey,
        isLocal: persistedUpdates.isLocal,
        isEnabled: persistedUpdates.isEnabled,
      });

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
        ...(shouldInvalidateReachability
          ? clearProviderReachability(state, id)
          : {}),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update provider';
      set({ lastError: message });
      throw error;
    }
  },

  createProviderConfig: async (config: Omit<ProviderConfig, 'id' | 'hasStoredApiKey' | 'apiKeyLoaded'>) => {
    try {
      requireProviderConfigurationIpc();

      const created = await ipcCreateProviderConfig({
        name: config.name,
        providerType: config.providerType,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        isLocal: config.isLocal,
      });

      const newConfig = normalizeCreatedProviderConfig(created, config.apiKey);
      const newProvider = toAIProvider(newConfig);

      set((state) => ({
        providerConfigs: [...state.providerConfigs, newConfig],
        providers: [...state.providers, newProvider],
        providerReachabilityById: { ...state.providerReachabilityById, [created.id]: undefined },
      }));

      await get().loadProviderSettings(created.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create provider';
      set({ lastError: message });
      throw error;
    }
  },

  deleteProviderConfig: async (id: string) => {
    try {
      requireProviderConfigurationIpc();

      await tauriIpc.deleteProviderConfig(id);

      set((state) => ({
        providerConfigs: state.providerConfigs.filter((c) => c.id !== id),
        providers: state.providers.filter((p) => p.id !== id),
        modelsByProvider: Object.fromEntries(
          Object.entries(state.modelsByProvider).filter(([key]) => key !== id)
        ),
        providerSettingsById: Object.fromEntries(
          Object.entries(state.providerSettingsById).filter(([key]) => key !== id)
        ),
        providerReachabilityById: omitRuntimeStateKey(state.providerReachabilityById, id),
        connectionStatus: omitRuntimeStateKey(state.connectionStatus, id),
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

    let completedStatus: tauriIpc.CopilotStatusDto | null = null;

    try {
      completedStatus = await new Promise<tauriIpc.CopilotStatusDto | null>((resolve, reject) => {
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
                  const status = event.payload.status ?? null;
                  if (status) {
                    set((state) => ({
                      ...applyCopilotStatusPatch(state, providerId, status),
                      copilotDownloadStateByProvider: {
                        ...state.copilotDownloadStateByProvider,
                        [providerId]:
                          state.copilotDownloadStateByProvider[providerId]?.requestId === requestId
                            ? undefined
                            : state.copilotDownloadStateByProvider[providerId],
                      },
                    }));
                  }
                  finish(() => resolve(status), unlisteners);
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

    const result = completedStatus
      ? {
          success: isCopilotConnected(completedStatus),
        }
      : await get().testConnection(providerId);
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
        ...clearProviderReachability(state, providerId),
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
      return { success: false, message: 'Provider not found', status: 'unknown' };
    }

    set((state) => ({
      ...withReachabilityRecord(state, providerId, {
        status: 'checking',
        lastVerifiedBy: isLinkedProviderType(config.providerType) ? 'linked_auth' : undefined,
      }),
    }));

    if (isLinkedProviderType(config.providerType)) {
      if (config.providerType !== 'copilot' && config.authStatus === 'authorizing') {
        return {
          success: false,
          message: 'Browser login is in progress.',
          status: 'checking',
        };
      }

      if (config.providerType === 'copilot') {
        if (!tauriIpc.isTauriAvailable()) {
          const message = 'GitHub Copilot status checks require the desktop app.';
          set((state) => ({
            ...withReachabilityRecord(state, providerId, {
              status: 'unreachable',
              lastVerifiedBy: 'linked_auth',
              lastError: message,
            }),
          }));

          return { success: false, message, status: 'unreachable', source: 'linked_auth' };
        }

        try {
          const status = await tauriIpc.aiGetCopilotStatus(providerId);
          const success = isCopilotConnected(status);
          const message = getCopilotStatusMessage(status);

          set((state) => ({
            ...applyCopilotStatusPatch(state, providerId, status),
          }));

          return {
            success,
            message,
            status: success ? 'reachable' : 'unreachable',
            source: 'linked_auth',
          };
        } catch (error) {
          const message = getErrorMessage(error, 'Failed to check GitHub Copilot status.');
          set((state) => ({
            ...withReachabilityRecord(state, providerId, {
              status: 'unreachable',
              lastVerifiedBy: 'linked_auth',
              lastError: message,
            }),
            copilotStatusByProvider: {
              ...state.copilotStatusByProvider,
              [providerId]: undefined,
            },
            authErrorsByProvider: {
              ...state.authErrorsByProvider,
              [providerId]: { code: 'copilot_health_failed', message },
            },
          }));

          return {
            success: false,
            message,
            status: 'unreachable',
            source: 'linked_auth',
          };
        }
      }

      const success = providerHasAuthSession(config);
      const message =
        success
          ? `ChatGPT linked${config.planType ? ` (${config.planType})` : ''}.`
          : 'Not linked. Use Connect with ChatGPT.';

      set((state) => ({
        ...withReachabilityRecord(state, providerId, {
          status: success ? 'reachable' : 'unreachable',
          lastVerifiedBy: 'linked_auth',
          lastError: success ? undefined : message,
        }),
      }));

      return {
        success,
        message,
        status: success ? 'reachable' : 'unreachable',
        source: 'linked_auth',
      };
    }

    const apiKey = config.isLocal ? undefined : await resolveProviderApiKey(providerId);
    const { selectedProviderId, selectedModelId, modelsByProvider } = get();
    const probeModels = getReachabilityProbeModels({
      providerId,
      selectedProviderId,
      selectedModelId,
      modelsByProvider,
    });
    const result = await probeProviderReachability({
      baseUrl: config.baseUrl,
      apiKey,
      providerId: config.providerType,
      providerType: config.providerType,
      preferredModelId: probeModels.preferredModelId,
      modelIds: probeModels.modelIds,
      timeout: 5000,
    });

    set((state) => ({
      ...withReachabilityRecord(state, providerId, {
        status: result.status,
        lastVerifiedBy: result.source,
        lastError: result.success ? undefined : result.message,
        modelIdUsed: result.modelIdUsed,
      }),
    }));

    return {
      success: result.success,
      message: result.message,
      status: result.status,
      source: result.source,
      modelIdUsed: result.modelIdUsed,
    };
  },
}));
