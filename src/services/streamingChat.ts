/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool/function calling with MCP integration
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ChatToolDefinition, ChatToolCall, McpToolCall, McpToolResult } from '../types/mcp';

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
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface StreamingChatOptions {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  messages: StreamMessage[];
  /** Tool definitions to send to the AI (OpenAI format) */
  tools?: ChatToolDefinition[];
  /** Callback for each text token */
  onToken: (token: string) => void;
  /** Callback when tool calls are detected */
  onToolCalls?: (toolCalls: ChatToolCall[]) => void;
  /** Callback when streaming completes */
  onComplete: (fullContent: string, toolCalls?: ChatToolCall[]) => void;
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
    tools,
    onToken,
    onToolCalls,
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
    // Build request body
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        // Add tool-related fields if present
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls;
        }
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }
        if (m.name) {
          msg.name = m.name;
        }
        return msg;
      }),
      stream: true,
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = 'auto';
    }

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
    
    // Track tool calls being built up from streaming chunks
    const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let finalToolCalls: ChatToolCall[] | undefined;

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

            if (delta?.content) {
              endThinking();
              const token = delta.content;
              fullContent += token;
              onToken(token);
            }

            // Handle streaming tool calls
            if (delta?.tool_calls) {
              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index ?? 0;
                
                // Initialize or update tool call
                if (!toolCallsInProgress.has(index)) {
                  toolCallsInProgress.set(index, {
                    id: toolCallDelta.id || '',
                    name: toolCallDelta.function?.name || '',
                    arguments: '',
                  });
                }
                
                const tc = toolCallsInProgress.get(index)!;
                
                // Update fields as they stream in
                if (toolCallDelta.id) {
                  tc.id = toolCallDelta.id;
                }
                if (toolCallDelta.function?.name) {
                  tc.name = toolCallDelta.function.name;
                }
                if (toolCallDelta.function?.arguments) {
                  tc.arguments += toolCallDelta.function.arguments;
                }
              }
            }
          } catch (e) {
            // Skip malformed JSON - some providers send non-JSON lines
            console.debug('Failed to parse SSE data:', data);
          }
        }
      }
    }

    endThinking();
    
    // Convert tool calls in progress to final format
    if (toolCallsInProgress.size > 0) {
      finalToolCalls = Array.from(toolCallsInProgress.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      
      // Notify about tool calls
      if (onToolCalls && finalToolCalls.length > 0) {
        onToolCalls(finalToolCalls);
      }
    }
    
    onComplete(fullContent, finalToolCalls);
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
    tools,
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
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls;
        }
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }
        if (m.name) {
          msg.name = m.name;
        }
        return msg;
      }),
      stream: false,
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = 'auto';
    }

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

// ============ Tool Execution Utilities ============

/**
 * Parse a tool call's function name to extract server ID and tool name
 * Tool names are formatted as "serverId__toolName" to namespace them
 */
export function parseToolName(fullName: string): { serverId: string; toolName: string } {
  const separatorIndex = fullName.indexOf('__');
  if (separatorIndex === -1) {
    // If no separator, assume it's a direct tool name (legacy format)
    return { serverId: '', toolName: fullName };
  }
  return {
    serverId: fullName.substring(0, separatorIndex),
    toolName: fullName.substring(separatorIndex + 2),
  };
}

/**
 * Convert ChatToolCall to McpToolCall for execution
 */
export function toMcpToolCall(chatToolCall: ChatToolCall): McpToolCall {
  const { serverId, toolName } = parseToolName(chatToolCall.function.name);
  
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(chatToolCall.function.arguments);
  } catch (e) {
    console.error('Failed to parse tool arguments:', e);
  }
  
  return {
    id: chatToolCall.id,
    name: toolName,
    arguments: args,
    serverId,
  };
}

/**
 * Format tool result for sending back to the AI
 */
export function formatToolResultMessage(
  toolCallId: string,
  toolName: string,
  result: McpToolResult
): StreamMessage {
  let content: string;
  
  if (!result.success) {
    content = `Error: ${result.error || 'Tool execution failed'}`;
  } else if (result.content && result.content.length > 0) {
    // Combine all text content
    content = result.content
      .map((c) => {
        if (c.type === 'text') {
          return c.text;
        } else if (c.type === 'image') {
          return `[Image: ${c.mimeType}]`;
        } else if (c.type === 'resource') {
          return c.resource.text || `[Resource: ${c.resource.uri}]`;
        }
        return '';
      })
      .join('\n');
  } else {
    content = 'Tool executed successfully (no output)';
  }
  
  return {
    role: 'tool',
    content,
    tool_call_id: toolCallId,
    name: toolName,
  };
}

