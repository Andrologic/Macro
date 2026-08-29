/**
 * Provider API Service
 * Handles dynamic model fetching from OpenAI-compatible endpoints
 * Supports: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible API
 */

import { tauriFetch } from './tauriHttp';
import { getPageLifecycleSignal, isPageShuttingDown } from '../utils/pageLifecycle';
import { createCombinedAbortSignal } from '../utils/abortSignals';
import { devLogger } from '../utils/devLogger';
import { resolveProviderCapabilities } from './providerCapabilities';

export interface ProviderModel {
  id: string;
  name?: string;
  display_name?: string;
  created?: number;
  owned_by?: string;
  description?: string;
  context_window?: number;
  context_window_tokens?: number;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  output_tokens?: number;
  max_completion_tokens?: number;
  max_context_length?: number;
  max_model_len?: number;
  loaded_instances?: Array<{
    id?: string;
    config?: {
      context_length?: number;
    };
  }>;
  capabilities?: {
    reasoning?: {
      allowed_options?: string[];
      default?: string;
    };
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
  };
  supported_parameters?: string[];
  supported_reasoning_efforts?: string[];
  reasoning_efforts?: string[];
  supported_reasoning_levels?: Array<string | { effort?: string; description?: string }>;
  default_reasoning_effort?: string;
  default_reasoning_level?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

export interface ModelsListResponse {
  data: ProviderModel[];
  object: string;
}

export interface FetchModelsOptions {
  baseUrl: string;
  apiKey?: string;
  providerId: string;
  providerType?: string;
  timeout?: number;
}

export interface FetchModelsResult {
  success: boolean;
  models: ProviderModel[];
  error?: string;
}

export type ProviderProbeStatus =
  | 'reachable'
  | 'unreachable'
  | 'probe_unsupported'
  | 'unknown';

export type ProviderProbeSource =
  | 'models_endpoint'
  | 'chat_completions_probe';

export type ProviderProbeErrorKind =
  | 'auth'
  | 'unsupported'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface ProviderProbeResult {
  success: boolean;
  status: ProviderProbeStatus;
  source: ProviderProbeSource;
  message: string;
  models: ProviderModel[];
  httpStatus?: number;
  modelIdUsed?: string;
  errorKind?: ProviderProbeErrorKind;
}

export interface ProbeProviderReachabilityOptions extends FetchModelsOptions {
  modelIds?: string[];
  preferredModelId?: string | null;
}

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
};

const normalizeReasoningLevelEfforts = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object') {
      const effort = (entry as { effort?: unknown }).effort;
      return typeof effort === 'string' ? [effort] : [];
    }
    return [];
  });
};

const normalizeProviderReasoningEfforts = (entry: ProviderModel): string[] => {
  const supportedEfforts = normalizeStringArray(entry.supported_reasoning_efforts);
  if (supportedEfforts.length > 0) return supportedEfforts;

  const reasoningEfforts = normalizeStringArray(entry.reasoning_efforts);
  if (reasoningEfforts.length > 0) return reasoningEfforts;

  return normalizeReasoningLevelEfforts(entry.supported_reasoning_levels);
};

const normalizeProviderDefaultReasoningEffort = (entry: ProviderModel): string | undefined => {
  if (typeof entry.default_reasoning_effort === 'string') return entry.default_reasoning_effort;
  if (typeof entry.default_reasoning_level === 'string') return entry.default_reasoning_level;
  return undefined;
};

const normalizeProviderKind = (value?: string | null): string =>
  (value || '').trim().toLowerCase();

const isLmStudioProvider = (providerId: string, providerType?: string): boolean =>
  normalizeProviderKind(providerId) === 'lmstudio' ||
  normalizeProviderKind(providerType) === 'lmstudio';

const isOllamaProvider = (providerId: string, providerType?: string): boolean =>
  normalizeProviderKind(providerId) === 'ollama' ||
  normalizeProviderKind(providerType) === 'ollama';

const isLocalProvider = (providerId: string, providerType?: string): boolean =>
  isLmStudioProvider(providerId, providerType) || isOllamaProvider(providerId, providerType);

const buildProviderHeaders = (params: {
  apiKey?: string;
  providerId: string;
  providerType?: string;
}): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (params.apiKey) {
    headers['Authorization'] = `Bearer ${params.apiKey}`;
    if (
      normalizeProviderKind(params.providerId) === 'anthropic' ||
      normalizeProviderKind(params.providerType) === 'anthropic'
    ) {
      headers['x-api-key'] = params.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  }

  if (params.providerId === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  return headers;
};

const getEffectiveTimeout = (
  providerId: string,
  timeout: number,
  providerType?: string,
): number =>
  isLocalProvider(providerId, providerType) ? Math.max(timeout, 15000) : timeout;

const toPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

const normalizeProviderModels = (data: unknown): ProviderModel[] => {
  if (!data || typeof data !== 'object') {
    throw new Error('Models response payload is not an object.');
  }

  const payload = data as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new Error('Models response payload did not include a data array.');
  }

  return payload.data.map((model) => {
    const entry = (model ?? {}) as ProviderModel;
    const reasoningEfforts = normalizeProviderReasoningEfforts(entry);
    const defaultReasoningEffort = normalizeProviderDefaultReasoningEffort(entry);
    const topProvider =
      entry.top_provider &&
      typeof entry.top_provider === 'object' &&
      !Array.isArray(entry.top_provider)
        ? {
            context_length: entry.top_provider.context_length,
            max_completion_tokens: entry.top_provider.max_completion_tokens,
            max_input_tokens: entry.top_provider.max_input_tokens,
            max_output_tokens: entry.top_provider.max_output_tokens,
          }
        : undefined;
    return {
      id: entry.id,
      name: entry.name || entry.display_name || entry.id,
      created: entry.created,
      owned_by: entry.owned_by,
      description: entry.description,
      context_window: entry.context_window,
      context_window_tokens: entry.context_window_tokens,
      context_length: entry.context_length,
      max_input_tokens: entry.max_input_tokens,
      max_output_tokens: entry.max_output_tokens,
      output_tokens: entry.output_tokens,
      max_completion_tokens: entry.max_completion_tokens,
      ...(typeof entry.max_context_length === 'number'
        ? { max_context_length: entry.max_context_length }
        : {}),
      ...(typeof entry.max_model_len === 'number'
        ? { max_model_len: entry.max_model_len }
        : {}),
      ...(Array.isArray(entry.loaded_instances)
        ? { loaded_instances: entry.loaded_instances }
        : {}),
      ...(entry.capabilities && typeof entry.capabilities === 'object'
        ? { capabilities: entry.capabilities }
        : {}),
      ...(topProvider ? { top_provider: topProvider } : {}),
      ...(Array.isArray(entry.supported_parameters)
        ? {
            supported_parameters: entry.supported_parameters.filter(
              (value): value is string => typeof value === 'string'
            ),
          }
        : {}),
      ...(reasoningEfforts.length > 0
        ? { supported_reasoning_efforts: reasoningEfforts }
        : {}),
      ...(defaultReasoningEffort
        ? { default_reasoning_effort: defaultReasoningEffort }
        : {}),
      pricing: entry.pricing,
    };
  });
};

const buildFailureResult = (params: {
  status: ProviderProbeStatus;
  source: ProviderProbeSource;
  message: string;
  errorKind: ProviderProbeErrorKind;
  httpStatus?: number;
  modelIdUsed?: string;
}): ProviderProbeResult => ({
  success: false,
  status: params.status,
  source: params.source,
  message: params.message,
  models: [],
  httpStatus: params.httpStatus,
  modelIdUsed: params.modelIdUsed,
  errorKind: params.errorKind,
});

const describeConnectionFailure = (providerId: string): string => {
  if (isLocalProvider(providerId)) {
    const providerName = providerId === 'lmstudio' ? 'LM Studio' : 'Ollama';
    return `Cannot connect to ${providerName}. Make sure the server is started (in ${providerName}, go to Developer tab > Start Server).`;
  }

  return `Cannot connect to ${providerId}. Please check if the service is running.`;
};

const describeTimeoutFailure = (providerId: string): string => {
  if (isLocalProvider(providerId)) {
    const providerName = providerId === 'lmstudio' ? 'LM Studio' : 'Ollama';
    return `Connection timeout. Make sure ${providerName} is running and accessible.`;
  }

  return `Connection timeout. Make sure ${providerId} is running and accessible.`;
};

const parseProbeFailure = (params: {
  error: unknown;
  providerId: string;
  source: ProviderProbeSource;
  didTimeout: boolean;
  modelIdUsed?: string;
}): ProviderProbeResult => {
  const message = params.error instanceof Error ? params.error.message : 'Unknown error';

  if (params.didTimeout) {
    return buildFailureResult({
      status: 'unreachable',
      source: params.source,
      message: describeTimeoutFailure(params.providerId),
      errorKind: 'timeout',
      modelIdUsed: params.modelIdUsed,
    });
  }

  if (isPageShuttingDown() || message === 'Request cancelled') {
    return buildFailureResult({
      status: 'unknown',
      source: params.source,
      message: 'Request cancelled.',
      errorKind: 'cancelled',
      modelIdUsed: params.modelIdUsed,
    });
  }

  if (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('connection')
  ) {
    return buildFailureResult({
      status: 'unreachable',
      source: params.source,
      message: describeConnectionFailure(params.providerId),
      errorKind: 'network',
      modelIdUsed: params.modelIdUsed,
    });
  }

  if (message.includes('abort')) {
    return buildFailureResult({
      status: 'unreachable',
      source: params.source,
      message: describeTimeoutFailure(params.providerId),
      errorKind: 'timeout',
      modelIdUsed: params.modelIdUsed,
    });
  }

  return buildFailureResult({
    status: 'unreachable',
    source: params.source,
    message,
    errorKind: 'unknown',
    modelIdUsed: params.modelIdUsed,
  });
};

const readResponseErrorText = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    return text || response.statusText || 'Unknown error';
  } catch {
    return response.statusText || 'Unknown error';
  }
};

const stripOpenAiCompatibilitySuffix = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
};

const requestModelsJson = async (params: {
  url: string;
  headers: Record<string, string>;
  timeout: number;
  signal: AbortSignal;
}): Promise<{ response: Response; data?: unknown; errorText?: string }> => {
  const response = await tauriFetch(params.url, {
    method: 'GET',
    headers: params.headers,
    connectTimeout: params.timeout,
    signal: params.signal,
  });

  if (!response.ok) {
    return {
      response,
      errorText: await readResponseErrorText(response),
    };
  }

  return {
    response,
    data: await response.json(),
  };
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeLmStudioV1Models = (payload: unknown): ProviderModel[] => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('LM Studio native models response payload is not an object.');
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new Error('LM Studio native models response did not include a models array.');
  }

  return models.flatMap((rawModel) => {
    const model = (rawModel ?? {}) as {
      type?: unknown;
      publisher?: unknown;
      key?: unknown;
      display_name?: unknown;
      max_context_length?: unknown;
      loaded_instances?: unknown;
      capabilities?: unknown;
    };
    if (stringValue(model.type)?.toLowerCase() !== 'llm') {
      return [];
    }

    const key = stringValue(model.key);
    if (!key) return [];
    const displayName = stringValue(model.display_name) ?? key;
    const loadedInstances = Array.isArray(model.loaded_instances)
      ? model.loaded_instances
          .map((instance) => {
            const record = (instance ?? {}) as {
              id?: unknown;
              config?: { context_length?: unknown };
            };
            return {
              id: stringValue(record.id),
              config: {
                context_length: toPositiveInteger(record.config?.context_length),
              },
            };
          })
          .filter((instance) => instance.id)
      : [];
    const maxContextLength = toPositiveInteger(model.max_context_length);
    const capabilities =
      model.capabilities &&
      typeof model.capabilities === 'object' &&
      !Array.isArray(model.capabilities)
        ? (model.capabilities as ProviderModel['capabilities'])
        : undefined;
    const reasoningEfforts = normalizeStringArray(
      capabilities?.reasoning?.allowed_options,
    );
    const defaultReasoningEffort = stringValue(capabilities?.reasoning?.default);

    if (loadedInstances.length === 0) {
      return [
        {
          id: key,
          name: displayName,
          owned_by: stringValue(model.publisher),
          ...(maxContextLength ? { max_context_length: maxContextLength } : {}),
          ...(capabilities ? { capabilities } : {}),
          ...(reasoningEfforts.length > 0
            ? { supported_reasoning_efforts: reasoningEfforts }
            : {}),
          ...(defaultReasoningEffort
            ? { default_reasoning_effort: defaultReasoningEffort }
            : {}),
        },
      ];
    }

    return loadedInstances.map((instance) => ({
      id: instance.id ?? key,
      name: displayName,
      owned_by: stringValue(model.publisher),
      context_length: instance.config.context_length,
      loaded_instances: [instance],
      ...(maxContextLength ? { max_context_length: maxContextLength } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(reasoningEfforts.length > 0
        ? { supported_reasoning_efforts: reasoningEfforts }
        : {}),
      ...(defaultReasoningEffort
        ? { default_reasoning_effort: defaultReasoningEffort }
        : {}),
    }));
  });
};

const normalizeLmStudioV0Models = (payload: unknown): ProviderModel[] => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('LM Studio v0 models response payload is not an object.');
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('LM Studio v0 models response did not include a data array.');
  }

  return data.flatMap((rawModel) => {
    const model = (rawModel ?? {}) as {
      id?: unknown;
      type?: unknown;
      publisher?: unknown;
      max_context_length?: unknown;
    };
    if (stringValue(model.type)?.toLowerCase() !== 'llm') {
      return [];
    }
    const id = stringValue(model.id);
    if (!id) return [];
    const maxContextLength = toPositiveInteger(model.max_context_length);
    return [
      {
        id,
        name: id,
        owned_by: stringValue(model.publisher),
        ...(maxContextLength ? { max_context_length: maxContextLength } : {}),
      },
    ];
  });
};

const probeLmStudioNativeModels = async (params: {
  baseUrl: string;
  headers: Record<string, string>;
  timeout: number;
  signal: AbortSignal;
}): Promise<ProviderProbeResult | null> => {
  const nativeBaseUrl = stripOpenAiCompatibilitySuffix(params.baseUrl);
  const attempts = [
    {
      url: `${nativeBaseUrl}/api/v1/models`,
      normalize: normalizeLmStudioV1Models,
    },
    {
      url: `${nativeBaseUrl}/api/v0/models`,
      normalize: normalizeLmStudioV0Models,
    },
  ];

  for (const attempt of attempts) {
    devLogger.log(`[lmstudio] Fetching native model metadata from ${attempt.url}`);
    try {
      const { response, data, errorText } = await requestModelsJson({
        url: attempt.url,
        headers: params.headers,
        timeout: params.timeout,
        signal: params.signal,
      });

      if (!response.ok) {
        if ([404, 405, 422].includes(response.status)) {
          continue;
        }
        return buildFailureResult({
          status: 'unreachable',
          source: 'models_endpoint',
          message: `Failed to fetch LM Studio native models: ${response.status} - ${errorText}`,
          errorKind: response.status === 401 || response.status === 403 ? 'auth' : 'unknown',
          httpStatus: response.status,
        });
      }

      const models = attempt.normalize(data);
      return {
        success: true,
        status: 'reachable',
        source: 'models_endpoint',
        message: `Connected! Found ${models.length} LM Studio models.`,
        models,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('aborted') || message.includes('Request cancelled')) {
        throw error;
      }
      continue;
    }
  }

  return null;
};

/**
 * Fetch models from an OpenAI-compatible /v1/models endpoint
 */
export async function probeModelsEndpoint(
  options: FetchModelsOptions
): Promise<ProviderProbeResult> {
  const { baseUrl, apiKey, providerId, providerType, timeout = 10000 } = options;
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (isPageShuttingDown()) {
    return buildFailureResult({
      status: 'unknown',
      source: 'models_endpoint',
      message: 'Request cancelled.',
      errorKind: 'cancelled',
    });
  }

  const effectiveTimeout = getEffectiveTimeout(providerId, timeout, providerType);
  const headers = buildProviderHeaders({ apiKey, providerId, providerType });

  // Log connection attempt for debugging
  if (isLocalProvider(providerId, providerType)) {
    devLogger.log(`[${providerId}] Fetching models from ${baseUrl}/models`);
  } else if (resolveProviderCapabilities({ providerId, baseUrl }).providerId === 'opencode-go') {
    devLogger.log('[opencode_http_probe] Fetching OpenCode models over HTTP');
  }

  try {
    const controller = new AbortController();
    const { signal, dispose } = createCombinedAbortSignal([
      controller.signal,
      getPageLifecycleSignal(),
    ]);
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort('timeout');
    }, effectiveTimeout);

    try {
      if (isLmStudioProvider(providerId, providerType)) {
        const nativeResult = await probeLmStudioNativeModels({
          baseUrl,
          headers,
          timeout: effectiveTimeout,
          signal,
        });
        if (nativeResult) {
          clearTimeout(timeoutId);
          timeoutId = null;
          return nativeResult;
        }
      }

      const response = await tauriFetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        connectTimeout: effectiveTimeout,
        signal,
      });

      clearTimeout(timeoutId);
      timeoutId = null;

      if (!response.ok) {
        const errorText = await readResponseErrorText(response);
        if (response.status === 401 || response.status === 403) {
          return buildFailureResult({
            status: 'unreachable',
            source: 'models_endpoint',
            message: `Authentication failed while fetching models: ${response.status} - ${errorText}`,
            errorKind: 'auth',
            httpStatus: response.status,
          });
        }

        if ([404, 405, 422].includes(response.status)) {
          return buildFailureResult({
            status: 'probe_unsupported',
            source: 'models_endpoint',
            message: `The models endpoint is not supported or not usable for this provider: ${response.status} - ${errorText}`,
            errorKind: 'unsupported',
            httpStatus: response.status,
          });
        }

        return buildFailureResult({
          status: 'unreachable',
          source: 'models_endpoint',
          message: `Failed to fetch models: ${response.status} - ${errorText}`,
          errorKind: 'unknown',
          httpStatus: response.status,
        });
      }

      let models: ProviderModel[];
      try {
        const data: ModelsListResponse = await response.json();
        models = normalizeProviderModels(data);
      } catch (error) {
        const parseMessage =
          error instanceof Error ? error.message : 'Failed to parse models response.';
        return buildFailureResult({
          status: 'probe_unsupported',
          source: 'models_endpoint',
          message: `The models endpoint returned an unsupported payload: ${parseMessage}`,
          errorKind: 'unsupported',
          httpStatus: response.status,
        });
      }

      return {
        success: true,
        status: 'reachable',
        source: 'models_endpoint',
        message: `Connected! Found ${models.length} models.`,
        models,
      };
    } finally {
      dispose();
    }
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return parseProbeFailure({
      error,
      providerId,
      source: 'models_endpoint',
      didTimeout,
    });
  }
}

export async function probeChatCompletionsEndpoint(
  options: FetchModelsOptions & { modelId: string }
): Promise<ProviderProbeResult> {
  const { baseUrl, apiKey, providerId, providerType, modelId, timeout = 10000 } = options;
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (isPageShuttingDown()) {
    return buildFailureResult({
      status: 'unknown',
      source: 'chat_completions_probe',
      message: 'Request cancelled.',
      errorKind: 'cancelled',
      modelIdUsed: modelId,
    });
  }

  const effectiveTimeout = getEffectiveTimeout(providerId, timeout, providerType);
  const headers = buildProviderHeaders({ apiKey, providerId, providerType });

  if (resolveProviderCapabilities({ providerId, baseUrl }).providerId === 'opencode-go') {
    devLogger.log('[opencode_http_probe] Probing OpenCode chat completions over HTTP');
  }

  try {
    const controller = new AbortController();
    const { signal, dispose } = createCombinedAbortSignal([
      controller.signal,
      getPageLifecycleSignal(),
    ]);
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort('timeout');
    }, effectiveTimeout);

    try {
      const response = await tauriFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        connectTimeout: effectiveTimeout,
        signal,
      });

      clearTimeout(timeoutId);
      timeoutId = null;

      if (!response.ok) {
        const errorText = await readResponseErrorText(response);
        if (response.status === 401 || response.status === 403) {
          return buildFailureResult({
            status: 'unreachable',
            source: 'chat_completions_probe',
            message: `Authentication failed while probing chat completions: ${response.status} - ${errorText}`,
            errorKind: 'auth',
            httpStatus: response.status,
            modelIdUsed: modelId,
          });
        }

        return buildFailureResult({
          status: 'unreachable',
          source: 'chat_completions_probe',
          message: `Chat completions probe failed: ${response.status} - ${errorText}`,
          errorKind: 'unknown',
          httpStatus: response.status,
          modelIdUsed: modelId,
        });
      }

      try {
        await response.json();
      } catch (error) {
        const parseMessage =
          error instanceof Error ? error.message : 'Failed to parse chat completions response.';
        return buildFailureResult({
          status: 'unreachable',
          source: 'chat_completions_probe',
          message: `Chat completions probe returned an invalid payload: ${parseMessage}`,
          errorKind: 'unknown',
          httpStatus: response.status,
          modelIdUsed: modelId,
        });
      }

      return {
        success: true,
        status: 'reachable',
        source: 'chat_completions_probe',
        message: `Connected using model ${modelId}.`,
        models: [],
        httpStatus: response.status,
        modelIdUsed: modelId,
      };
    } finally {
      dispose();
    }
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return parseProbeFailure({
      error,
      providerId,
      source: 'chat_completions_probe',
      didTimeout,
      modelIdUsed: modelId,
    });
  }
}

export async function probeProviderReachability(
  options: ProbeProviderReachabilityOptions
): Promise<ProviderProbeResult> {
  const { modelIds = [], preferredModelId, ...rest } = options;
  const modelsProbe = await probeModelsEndpoint(rest);
  if (modelsProbe.success) {
    return modelsProbe;
  }

  if (
    modelsProbe.status !== 'probe_unsupported' &&
    modelsProbe.errorKind !== 'unsupported'
  ) {
    return modelsProbe;
  }

  const candidateModels = [
    preferredModelId ?? undefined,
    ...modelIds,
  ].filter((value, index, items): value is string =>
    typeof value === 'string' && value.trim().length > 0 && items.indexOf(value) === index
  );

  if (candidateModels.length === 0) {
    return buildFailureResult({
      status: 'probe_unsupported',
      source: 'chat_completions_probe',
      message:
        'Provider is configured, but verification requires a known model because the models endpoint is not supported.',
      errorKind: 'unsupported',
    });
  }

  return probeChatCompletionsEndpoint({
    ...rest,
    modelId: candidateModels[0],
  });
}

export async function fetchModelsFromProvider(
  options: FetchModelsOptions
): Promise<FetchModelsResult> {
  const result = await probeModelsEndpoint(options);
  if (result.success) {
    return {
      success: true,
      models: result.models,
    };
  }

  return {
    success: false,
    models: [],
    error: result.message || 'Connection failed',
  };
}

/**
 * Test connection to a provider
 */
export async function testProviderConnection(
  baseUrl: string,
  apiKey?: string,
  providerId: string = 'custom',
  options?: { modelIds?: string[]; preferredModelId?: string | null }
): Promise<{ success: boolean; message: string }> {
  const result = await probeProviderReachability({
    baseUrl,
    apiKey,
    providerId,
    timeout: 5000,
    modelIds: options?.modelIds,
    preferredModelId: options?.preferredModelId,
  });

  return {
    success: result.success,
    message: result.message,
  };
}

/**
 * Format model name for display
 * Handles various model ID formats from different providers
 */
export function formatModelName(modelId: string): string {
  // OpenRouter format: "openai/gpt-4o" -> "GPT-4o"
  if (modelId.includes('/')) {
    const parts = modelId.split('/');
    return parts[parts.length - 1];
  }

  // Common model name improvements
  return modelId
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Gpt/g, 'GPT')
    .replace(/Llama/g, 'LLaMA')
    .replace(/Claude/g, 'Claude');
}
