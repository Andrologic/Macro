/**
 * Provider API Service
 * Handles dynamic model fetching from OpenAI-compatible endpoints
 * Supports: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible API
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getPageLifecycleSignal, isPageShuttingDown } from '../utils/pageLifecycle';
import { createCombinedAbortSignal } from '../utils/abortSignals';
import { devLogger } from '../utils/devLogger';
import { resolveProviderCapabilities } from './providerCapabilities';

export interface ProviderModel {
  id: string;
  name?: string;
  created?: number;
  owned_by?: string;
  description?: string;
  context_window?: number;
  context_window_tokens?: number;
  max_input_tokens?: number;
  supported_parameters?: string[];
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

const isLocalProvider = (providerId: string): boolean =>
  providerId === 'lmstudio' || providerId === 'ollama';

const buildProviderHeaders = (params: {
  apiKey?: string;
  providerId: string;
}): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (params.apiKey) {
    headers['Authorization'] = `Bearer ${params.apiKey}`;
  }

  if (params.providerId === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  return headers;
};

const getEffectiveTimeout = (providerId: string, timeout: number): number =>
  isLocalProvider(providerId) ? Math.max(timeout, 15000) : timeout;

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
    return {
      id: entry.id,
      name: entry.name || entry.id,
      created: entry.created,
      owned_by: entry.owned_by,
      description: entry.description,
      context_window: entry.context_window,
      context_window_tokens: entry.context_window_tokens,
      max_input_tokens: entry.max_input_tokens,
      ...(Array.isArray(entry.supported_parameters)
        ? {
            supported_parameters: entry.supported_parameters.filter(
              (value): value is string => typeof value === 'string'
            ),
          }
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

/**
 * Fetch models from an OpenAI-compatible /v1/models endpoint
 */
export async function probeModelsEndpoint(
  options: FetchModelsOptions
): Promise<ProviderProbeResult> {
  const { baseUrl, apiKey, providerId, timeout = 10000 } = options;
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

  const effectiveTimeout = getEffectiveTimeout(providerId, timeout);
  const headers = buildProviderHeaders({ apiKey, providerId });

  // Log connection attempt for debugging
  if (isLocalProvider(providerId)) {
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
  const { baseUrl, apiKey, providerId, modelId, timeout = 10000 } = options;
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

  const effectiveTimeout = getEffectiveTimeout(providerId, timeout);
  const headers = buildProviderHeaders({ apiKey, providerId });

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
