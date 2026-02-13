/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool calling for web search and file reading
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { webSearch, fetchWebPage, formatSearchResultsAsContext, WebSearchOptions } from './webSearch';

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
  content: StreamMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type StreamMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

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
  enableWebFetch?: boolean;
  webSearchOptions?: WebSearchOptions;
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<string | void> | string | void;
  onToolResult?: (toolName: string, result: string) => void;
  fileToolContext?: Array<{
    title: string;
    source: string;
    path?: string;
    snippet?: string;
  }>;
  allowedToolIds?: string[];
}

// Tool definitions for the LLM
const WEB_SEARCH_TOOL = {
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
};

const WEB_FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch and read the content of a specific URL.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch and read',
        },
      },
      required: ['url'],
    },
  },
};

const MARK_SOURCE_PASSAGE_TOOL = {
  type: 'function',
  function: {
    name: 'mark_source_passage',
    description: 'Store important source passages. Use kind="interesting" for notable excerpts and kind="used" for excerpts directly used in the final answer.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title of the passage.',
        },
        passage: {
          type: 'string',
          description: 'Important excerpt to save.',
        },
        kind: {
          type: 'string',
          enum: ['interesting', 'used'],
          description: 'Classification of the passage: interesting while analyzing, or used in the final answer.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason describing why this passage matters.',
        },
        source: {
          type: 'string',
          description: 'Source label such as filename or site/domain.',
        },
        url: {
          type: 'string',
          description: 'URL of the source when available.',
        },
      },
      required: ['title', 'passage'],
    },
  },
};

const READ_SOURCES_TOOL = {
  type: 'function',
  function: {
    name: 'read_sources',
    description: 'Read saved source passages from the current conversation. Can filter by kind and query.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['all', 'interesting', 'used'],
          description: 'Optional filter by source passage kind.',
        },
        query: {
          type: 'string',
          description: 'Optional keyword filter over title, passage, source, url, and reason.',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of passages to return (1-50).',
        },
        include_snippet: {
          type: 'boolean',
          description: 'Include full passage snippets in results. Defaults to true.',
        },
      },
      required: [],
    },
  },
};

const EDIT_SOURCE_PASSAGE_TOOL = {
  type: 'function',
  function: {
    name: 'edit_source_passage',
    description: 'Update, reclassify, or delete a saved source passage by citation_id.',
    parameters: {
      type: 'object',
      properties: {
        citation_id: {
          type: 'string',
          description: 'ID of the source citation to modify.',
        },
        action: {
          type: 'string',
          enum: ['update', 'reclassify', 'delete'],
          description: 'Type of modification to apply.',
        },
        title: {
          type: 'string',
          description: 'Updated title for action="update".',
        },
        passage: {
          type: 'string',
          description: 'Updated passage text for action="update".',
        },
        source: {
          type: 'string',
          description: 'Updated source label for action="update".',
        },
        url: {
          type: 'string',
          description: 'Updated URL for action="update".',
        },
        reason: {
          type: 'string',
          description: 'Updated or new reason for action="update".',
        },
        kind: {
          type: 'string',
          enum: ['interesting', 'used'],
          description: 'Required for action="reclassify". Optional for action="update".',
        },
      },
      required: ['citation_id', 'action'],
    },
  },
};

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file already attached in the conversation context. Use this when asked to analyze or inspect a file.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File name/path/source to read (example: hotas.pr0).',
        },
        extract_text: {
          type: 'boolean',
          description: 'Optional hint to request text extraction for binary-like formats (e.g. .docx).',
        },
      },
      required: ['file'],
    },
  },
};

const LIST_TOOL = {
  type: 'function',
  function: {
    name: 'list',
    description: 'List files and directories under a path in the local workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Defaults to current workspace root.' },
        recursive: { type: 'boolean', description: 'Whether to list recursively.' },
        include_hidden: { type: 'boolean', description: 'Include hidden files/folders.' },
        max_depth: { type: 'number', description: 'Maximum recursion depth when recursive=true.' },
      },
      required: [],
    },
  },
};

const READ_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the local workspace by path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to read.' },
        start_line: { type: 'number', description: 'Optional 1-based start line.' },
        end_line: { type: 'number', description: 'Optional 1-based end line.' },
      },
      required: ['path'],
    },
  },
};

const WRITE_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'write',
    description: 'Create or overwrite a workspace file with full content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to write.' },
        content: { type: 'string', description: 'Final file content.' },
        create_dirs: { type: 'boolean', description: 'Create missing parent directories.' },
      },
      required: ['path', 'content'],
    },
  },
};

const EDIT_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'edit',
    description: 'Edit a workspace file by replacing exact text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to edit.' },
        old_text: { type: 'string', description: 'Exact text to replace.' },
        new_text: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace all matches (default false = first only).' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
};

const GLOB_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Find workspace files matching a glob pattern (example: src/**/*.ts).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        include_hidden: { type: 'boolean', description: 'Include hidden files/folders.' },
      },
      required: ['pattern'],
    },
  },
};

const GREP_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'grep',
    description: 'Search text in workspace files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex to search for.' },
        is_regexp: { type: 'boolean', description: 'Treat query as regex when true.' },
        include_pattern: { type: 'string', description: 'Optional file glob filter.' },
        include_hidden: { type: 'boolean', description: 'Include hidden files/folders.' },
        max_results: { type: 'number', description: 'Maximum result rows to return.' },
      },
      required: ['query'],
    },
  },
};

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
    enableWebFetch = true,
    webSearchOptions,
    onToolCall,
    onToolResult,
    fileToolContext = [],
    allowedToolIds,
    // Note: signal is not used with Tauri HTTP plugin - AbortController support is limited
  } = options;

  const allowedTools = new Set(allowedToolIds ?? []);

  const formatToolUsageLabel = (toolName: string, args: Record<string, unknown>) => {
    if (toolName === 'web_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      return `\n\n[TOOL] web_search${query ? ` ("${query}")` : ''}\n`;
    }

    if (toolName === 'web_fetch') {
      const url = typeof args.url === 'string' ? args.url : '';
      return `\n\n[TOOL] web_fetch${url ? ` ("${url}")` : ''}\n`;
    }

    if (toolName === 'mark_source_passage') {
      const title = typeof args.title === 'string' ? args.title : '';
      const kind = typeof args.kind === 'string' ? args.kind : 'used';
      return `\n\n[TOOL] mark_source_passage${title ? ` ("${title}", kind=${kind})` : ''}\n`;
    }

    if (toolName === 'read_sources') {
      const kind = typeof args.kind === 'string' ? args.kind : 'all';
      const query = typeof args.query === 'string' ? args.query : '';
      const suffix = query ? `, query="${query}"` : '';
      return `\n\n[TOOL] read_sources (kind=${kind}${suffix})\n`;
    }

    if (toolName === 'edit_source_passage') {
      const action = typeof args.action === 'string' ? args.action : '';
      const citationId = typeof args.citation_id === 'string' ? args.citation_id : '';
      return `\n\n[TOOL] edit_source_passage${citationId ? ` (id=${citationId}, action=${action || 'update'})` : ''}\n`;
    }

    if (toolName === 'read_file') {
      const file = typeof args.file === 'string' ? args.file : '';
      const extractText = args.extract_text === true;
      const suffix = extractText ? ', extract_text=true' : '';
      return `\n\n[TOOL] read_file${file ? ` ("${file}"${suffix})` : ''}\n`;
    }

    if (toolName === 'list') {
      const path = typeof args.path === 'string' ? args.path : '.';
      return `\n\n[TOOL] list${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'read') {
      const path = typeof args.path === 'string' ? args.path : '';
      return `\n\n[TOOL] read${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'write') {
      const path = typeof args.path === 'string' ? args.path : '';
      return `\n\n[TOOL] write${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'edit') {
      const path = typeof args.path === 'string' ? args.path : '';
      return `\n\n[TOOL] edit${path ? ` ("${path}")` : ''}\n`;
    }

    if (toolName === 'glob') {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      return `\n\n[TOOL] glob${pattern ? ` ("${pattern}")` : ''}\n`;
    }

    if (toolName === 'grep') {
      const query = typeof args.query === 'string' ? args.query : '';
      return `\n\n[TOOL] grep${query ? ` ("${query}")` : ''}\n`;
    }

    return `\n\n[TOOL] ${toolName}\n`;
  };

  const formatToolDoneLabel = (toolName: string) => `\n[TOOL_DONE] ${toolName}\n`;

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

  // Expose only explicitly allowed tools. Web search also requires provider keys.
  const tools: unknown[] = [];
  if (allowedTools.has('mark_source_passage')) {
    tools.push(MARK_SOURCE_PASSAGE_TOOL);
  }
  if (allowedTools.has('read_sources')) {
    tools.push(READ_SOURCES_TOOL);
  }
  if (allowedTools.has('edit_source_passage')) {
    tools.push(EDIT_SOURCE_PASSAGE_TOOL);
  }
  if (allowedTools.has('read_file')) {
    tools.push(READ_FILE_TOOL);
  }
  if (allowedTools.has('list')) {
    tools.push(LIST_TOOL);
  }
  if (allowedTools.has('read')) {
    tools.push(READ_WORKSPACE_TOOL);
  }
  if (allowedTools.has('write')) {
    tools.push(WRITE_WORKSPACE_TOOL);
  }
  if (allowedTools.has('edit')) {
    tools.push(EDIT_WORKSPACE_TOOL);
  }
  if (allowedTools.has('glob')) {
    tools.push(GLOB_WORKSPACE_TOOL);
  }
  if (allowedTools.has('grep')) {
    tools.push(GREP_WORKSPACE_TOOL);
  }
  if (
    allowedTools.has('web_search') &&
    enableWebSearch &&
    (webSearchOptions?.tavilyApiKey || webSearchOptions?.braveApiKey)
  ) {
    tools.push(WEB_SEARCH_TOOL);
  }
  if (allowedTools.has('web_fetch') && enableWebFetch) {
    tools.push(WEB_FETCH_TOOL);
  }
  if (tools.length > 0) {
    requestBody.tools = tools;
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
        let shouldEmitToolDone = false;
        let customToolResult: string | undefined;
        
        try {
          const args = JSON.parse(toolCall.function.arguments);

          if (!allowedTools.has(toolName)) {
            toolResult = `Tool ${toolName} is disabled for the current mode.`;
            toolResults.push({
              tool_call_id: toolCall.id,
              content: toolResult,
            });
            continue;
          }

          const customResult = await onToolCall?.(toolName, args);
          customToolResult = typeof customResult === 'string' ? customResult : undefined;

          const toolUsageMsg = formatToolUsageLabel(toolName, args);
          fullContent += toolUsageMsg;
          onToken(toolUsageMsg);
          shouldEmitToolDone = true;
          
          if (toolName === 'web_search') {
            // Execute web search
            const searchResults = await webSearch(args.query, webSearchOptions);
            toolResult = formatSearchResultsAsContext(searchResults);
            
            // Show search indicator in chat
            const searchMsg = `\n\n🔍 **Recherche web:** "${args.query}"\n`;
            fullContent += searchMsg;
            onToken(searchMsg);
          }

          if (toolName === 'web_fetch') {
            const url = typeof args.url === 'string' ? args.url : '';
            if (!url.trim()) {
              toolResult = 'Missing URL for web_fetch.';
            } else {
              const fetched = await fetchWebPage(url);
              toolResult = `TITLE: ${fetched.title}\nURL: ${fetched.url}\n\n${fetched.content}`;
            }
          }

          if (toolName === 'read_file') {
            const normalizeMatch = (value?: string) =>
              (value || '')
                .trim()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase();

            const requestedRaw = typeof args.file === 'string' ? args.file.trim() : '';
            const requested = normalizeMatch(requestedRaw);
            const extractText = args.extract_text === true;
            const available = fileToolContext.map((f) => f.path || f.title || f.source).filter(Boolean);

            const match = fileToolContext.find((f) => {
              const title = normalizeMatch(f.title);
              const source = normalizeMatch(f.source);
              const path = normalizeMatch(f.path);
              return (
                requested === title ||
                requested === source ||
                requested === path ||
                title.includes(requested) ||
                source.includes(requested) ||
                path.includes(requested)
              );
            });

            if (!requested) {
              toolResult = `No file provided. Available files: ${available.join(', ') || 'none'}`;
            } else if (!match) {
              toolResult = `File not found in context: "${requestedRaw}". Available files: ${available.join(', ') || 'none'}`;
            } else {
              const label = match.path || match.title || match.source;
              const content = (match.snippet || '').trim();
              const base = content
                ? `FILE: ${label}\n\n${content}`
                : `FILE: ${label}\n\nNo textual content available for this file in context.`;

              const isDocx = /\.docx$/i.test(label || '');
              const extractNotice =
                extractText && isDocx
                  ? '\n\nNote: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text.'
                  : '';

              toolResult = `${base}${extractNotice}`;
            }
          }
          
          if (toolName === 'mark_source_passage') {
            const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
            const kind = rawKind === 'interesting' ? 'interesting' : 'used';
            toolResult = `Source passage marked successfully (kind=${kind}).`;
          } else if (toolName === 'read_sources') {
            toolResult = customToolResult || 'No source passages available.';
          } else if (toolName === 'edit_source_passage') {
            toolResult = customToolResult || 'Source passage edit request processed.';
          } else if (customToolResult) {
            toolResult = customToolResult;
          } else if (toolName !== 'web_search' && toolName !== 'read_file' && toolName !== 'web_fetch') {
            toolResult = `Unsupported tool: ${toolName}`;
          }

          onToolResult?.(toolName, toolResult);
        } catch (e) {
          toolResult = `Error executing tool ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          if (shouldEmitToolDone) {
            const toolDoneMsg = formatToolDoneLabel(toolName);
            fullContent += toolDoneMsg;
            onToken(toolDoneMsg);
          }
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
