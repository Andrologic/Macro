/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface StreamMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamingChatOptions {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  messages: StreamMessage[];
  onToken: (token: string) => void;
  onComplete: (fullContent: string) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

/**
 * Send a streaming chat completion request
 */
export async function streamChat(options: StreamingChatOptions): Promise<void> {
  const {
    providerId,
    providerType,
    baseUrl,
    apiKey,
    modelId,
    messages,
    onToken,
    onComplete,
    onError,
    // Note: signal is not used with Tauri HTTP plugin - AbortController support is limited
  } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // OpenRouter specific headers
  if (providerType === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  // LM Studio: Log connection attempt for debugging
  const isLocalProvider = providerType === 'lmstudio' || providerType === 'ollama';
  if (isLocalProvider) {
    console.log(`[${providerId}] Connecting to ${baseUrl}/chat/completions`);
  }

  try {
    const response = await tauriFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      let errorMessage = `Request failed: ${response.status}`;
      
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }
      
      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let isThinking = false;

    const startThinking = () => {
      if (!isThinking) {
        fullContent += '<think>';
        onToken('<think>');
        isThinking = true;
      }
    };

    const endThinking = () => {
      if (isThinking) {
        fullContent += '</think>';
        onToken('</think>');
        isThinking = false;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmedLine = line.trim();
        
        if (!trimmedLine || trimmedLine === '') {
          continue;
        }

        if (trimmedLine.startsWith('data: ')) {
          const data = trimmedLine.slice(6);
          
          if (data === '[DONE]') {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const reasoning = delta?.reasoning ?? delta?.reasoning_content;

            if (typeof reasoning === 'string' && reasoning.length > 0) {
              startThinking();
              fullContent += reasoning;
              onToken(reasoning);
            }

            if (delta?.content) {
              endThinking();
              const token = delta.content;
              fullContent += token;
              onToken(token);
            }
          } catch (e) {
            // Skip malformed JSON - some providers send non-JSON lines
            console.debug('Failed to parse SSE data:', data);
          }
        }
      }
    }

    endThinking();
    onComplete(fullContent);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
      return;
    }
    
    // Better error messages for local providers
    const err = error instanceof Error ? error : new Error(String(error));
    const isLocalProvider = options.providerType === 'lmstudio' || options.providerType === 'ollama';
    
    if (isLocalProvider && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('connection'))) {
      const providerName = options.providerType === 'lmstudio' ? 'LM Studio' : 'Ollama';
      onError(new Error(`Cannot connect to ${providerName}. Make sure the server is running and accessible at ${options.baseUrl}`));
      return;
    }
    
    onError(err);
  }
}

/**
 * Non-streaming fallback for providers that don't support streaming
 */
export async function sendChatNonStreaming(options: Omit<StreamingChatOptions, 'onToken'>): Promise<string> {
  const {
    providerType,
    baseUrl,
    apiKey,
    modelId,
    messages,
    onComplete,
    onError,
  } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  if (providerType === 'openrouter') {
    if (typeof window !== 'undefined') {
      headers['HTTP-Referer'] = window.location.origin;
    }
    headers['X-Title'] = 'Macro';
  }

  try {
    const response = await tauriFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      let errorMessage = `Request failed: ${response.status}`;
      
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }
      
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    const messageContent = message.content || '';
    const reasoning = message.reasoning || message.reasoning_content || '';
    const content = reasoning
      ? `<think>${reasoning}</think>${messageContent ? `\n${messageContent}` : ''}`
      : messageContent;
    onComplete(content);
    return content;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
    throw err;
  }
}
