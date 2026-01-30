/**
 * Provider API Service
 * Handles dynamic model fetching from OpenAI-compatible endpoints
 * Supports: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible API
 */

export interface ProviderModel {
  id: string;
  name: string;
  created?: number;
  owned_by?: string;
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
  const { baseUrl, apiKey, providerId, timeout = 5000 } = options;

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

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

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
      name: model.id, // Use ID as name if no specific name
      created: model.created,
      owned_by: model.owned_by,
    }));

    return {
      success: true,
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    
    // Provide helpful error messages for common issues
    if (message.includes('abort')) {
      return {
        success: false,
        models: [],
        error: `Connection timeout. Make sure ${providerId} is running and accessible.`,
      };
    }
    
    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
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
