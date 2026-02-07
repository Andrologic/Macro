/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool calling for web search and file reading
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { webSearch, formatSearchResultsAsContext, WebSearchOptions } from './webSearch';

// Global references to active streaming resources for cancellation
let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let currentStream: ReadableStream<Uint8Array> | null = null;

/**
 * Cancel the currently active stream
 */
export function cancelStream(): void {
  if (currentReader) {
    currentReader.cancel().catch(() => {
      // Ignore errors during cancel
    });
    currentReader = null;
  }
  if (currentStream) {
    currentStream.cancel().catch(() => {
      // Ignore errors during cancel
    });
    currentStream = null;
  }
}

export interface StreamMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
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
  // Tool calling options
  enableWebSearch?: boolean;
  webSearchOptions?: WebSearchOptions;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string) => void;
}

// Tool definitions for the LLM
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Use this when you need up-to-date information about any topic.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up',
          },
        },
        required: ['query'],
      },
    },
  },
];

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
    enableWebSearch = true,
    webSearchOptions,
    onToolCall,
    onToolResult,
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

  // Build request body with optional tools
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls && { tool_calls: m.tool_calls }),
      ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
    })),
    stream: true,
  };

  // Add tools if web search is enabled
  if (enableWebSearch && webSearchOptions?.tavilyApiKey) {
    requestBody.tools = TOOLS;
  }

  try {
    const response = await tauriFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
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

    // Store references for cancellation
    currentStream = response.body;
    const reader = currentStream.getReader();
    currentReader = reader;
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let isThinking = false;
    let toolCalls: ToolCall[] = [];

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
      // Check if the stream was cancelled
      if (options.signal?.aborted) {
        try {
          await reader.cancel();
        } catch (e) {
          // Ignore cancel errors
        }
        onComplete(options.messages.length > 0 ? '' : 'Request cancelled');
        return;
      }

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

            // Handle tool calls
            if (delta?.tool_calls) {
              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index ?? 0;
                if (!toolCalls[index]) {
                  toolCalls[index] = {
                    id: toolCallDelta.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (toolCallDelta.id) {
                  toolCalls[index].id = toolCallDelta.id;
                }
                if (toolCallDelta.function?.name) {
                  toolCalls[index].function.name = toolCallDelta.function.name;
                }
                if (toolCallDelta.function?.arguments) {
                  toolCalls[index].function.arguments += toolCallDelta.function.arguments;
                }
              }
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
    
    // Handle tool calls if any
    const validToolCalls = toolCalls.filter(tc => tc.id && tc.function.name);
    if (validToolCalls.length > 0) {
      const toolResults: ToolResult[] = [];
      
      for (const toolCall of validToolCalls) {
        const toolName = toolCall.function.name;
        let toolResult = '';
        
        try {
          const args = JSON.parse(toolCall.function.arguments);
          onToolCall?.(toolName, args);
          
          if (toolName === 'web_search') {
            // Execute web search
            const searchResults = await webSearch(args.query, webSearchOptions);
            toolResult = formatSearchResultsAsContext(searchResults);
            
            // Show search indicator in chat
            const searchMsg = `\n\n🔍 **Recherche web:** "${args.query}"\n`;
            fullContent += searchMsg;
            onToken(searchMsg);
          }
          
          onToolResult?.(toolName, toolResult);
        } catch (e) {
          toolResult = `Error executing tool ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
        }
        
        toolResults.push({
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
      
      // If we have tool results, make a follow-up request to get the final response
      if (toolResults.length > 0) {
        const messagesWithToolResults: StreamMessage[] = [
          ...messages,
          { role: 'assistant', content: fullContent, tool_calls: validToolCalls },
          ...toolResults.map(tr => ({ role: 'tool' as const, content: tr.content, tool_call_id: tr.tool_call_id })),
        ];
        
        // Make a follow-up request without tools to get the final response
        const followUpResponse = await tauriFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: messagesWithToolResults.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.tool_calls && { tool_calls: m.tool_calls }),
              ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
            })),
            stream: true,
          }),
        });
        
        if (followUpResponse.ok && followUpResponse.body) {
          currentStream = followUpResponse.body;
          const followUpReader = currentStream.getReader();
          currentReader = followUpReader;
          
          buffer = '';
          while (true) {
            const { done, value } = await followUpReader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;
              
              const data = trimmedLine.slice(6);
              if (data === '[DONE]') continue;
              
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                
                if (delta?.content) {
                  const token = delta.content;
                  fullContent += token;
                  onToken(token);
                }
              } catch (e) {
                console.debug('Failed to parse follow-up SSE data:', data);
              }
            }
          }
        }
      }
    }
    
    onComplete(fullContent);
  } catch (error) {
    // Cleanup on error
    if (currentReader) {
      currentReader = null;
    }
    if (currentStream) {
      currentStream = null;
    }
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
  } finally {
    // Always cleanup references to prevent memory leaks
    currentReader = null;
    currentStream = null;
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
