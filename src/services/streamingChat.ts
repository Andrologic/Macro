/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 */

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
    providerType,
    baseUrl,
    apiKey,
    modelId,
    messages,
    onToken,
    onComplete,
    onError,
    signal,
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

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
      signal,
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
            
            if (delta?.content) {
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

    onComplete(fullContent);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
      return;
    }
    onError(error instanceof Error ? error : new Error(String(error)));
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
    signal,
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
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
      signal,
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
    const content = data.choices?.[0]?.message?.content || '';
    onComplete(content);
    return content;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
    throw err;
  }
}
