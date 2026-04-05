/**
 * Provider API Service
 * Handles dynamic model fetching from OpenAI-compatible endpoints
 * Supports: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible API
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getPageLifecycleSignal, isPageShuttingDown } from '../utils/pageLifecycle';
import { createCombinedAbortSignal } from '../utils/abortSignals';
import { devLogger } from '../utils/devLogger';

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

/**
 * Fetch models from an OpenAI-compatible /v1/models endpoint
 */
export async function fetchModelsFromProvider(
  options: FetchModelsOptions
): Promise<FetchModelsResult> {
  const { baseUrl, apiKey, providerId, timeout = 10000 } = options;
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (isPageShuttingDown()) {
    return {
      success: false,
      models: [],
      error: 'Request cancelled.',
    };
  }

  // Use longer timeout for local providers (model loading can take time)
  const isLocalProvider = providerId === 'lmstudio' || providerId === 'ollama';
  const effectiveTimeout = isLocalProvider ? Math.max(timeout, 15000) : timeout;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add auth header if API key is provided (not needed for local providers)
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // OpenRouter specific headers
  if (providerId === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  // Log connection attempt for debugging
  if (isLocalProvider) {
    devLogger.log(`[${providerId}] Fetching models from ${baseUrl}/models`);
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
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          success: false,
          models: [],
          error: `Failed to fetch models: ${response.status} - ${errorText}`,
        };
      }

      const data: ModelsListResponse = await response.json();
      
      // Normalize model data
      const models = (data.data || []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        created: model.created,
        owned_by: model.owned_by,
        description: model.description,
        ...(Array.isArray(model.supported_parameters)
          ? {
              supported_parameters: model.supported_parameters.filter(
                (entry): entry is string => typeof entry === 'string'
              ),
            }
          : {}),
        pricing: model.pricing,
      }));

      return {
        success: true,
        models,
      };
    } finally {
      dispose();
    }
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    const message = error instanceof Error ? error.message : 'Unknown error';

    if (didTimeout) {
      return {
        success: false,
        models: [],
        error: `Connection timeout. Make sure ${providerId} is running and accessible.`,
      };
    }

    if (isPageShuttingDown() || message === 'Request cancelled') {
      return {
        success: false,
        models: [],
        error: 'Request cancelled.',
      };
    }
    
    // Provide helpful error messages for common issues
    if (message.includes('abort')) {
      return {
        success: false,
        models: [],
        error: `Connection timeout. Make sure ${providerId} is running and accessible.`,
      };
    }
    
    if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('connection')) {
      const isLocalProvider = providerId === 'lmstudio' || providerId === 'ollama';
      if (isLocalProvider) {
        const providerName = providerId === 'lmstudio' ? 'LM Studio' : 'Ollama';
        return {
          success: false,
          models: [],
          error: `Cannot connect to ${providerName}. Make sure the server is started (in ${providerName}, go to Developer tab > Start Server).`,
        };
      }
      return {
        success: false,
        models: [],
        error: `Cannot connect to ${providerId}. Please check if the service is running.`,
      };
    }

    return {
      success: false,
      models: [],
      error: message,
    };
  }
}

/**
 * Test connection to a provider
 */
export async function testProviderConnection(
  baseUrl: string,
  apiKey?: string,
  providerId: string = 'custom'
): Promise<{ success: boolean; message: string }> {
  const result = await fetchModelsFromProvider({
    baseUrl,
    apiKey,
    providerId,
    timeout: 5000,
  });

  if (result.success) {
    return {
      success: true,
      message: `Connected! Found ${result.models.length} models.`,
    };
  }

  return {
    success: false,
    message: result.error || 'Connection failed',
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
