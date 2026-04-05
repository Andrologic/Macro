/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool calling for web search and file reading
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { webSearch, fetchWebPage, formatSearchResultsAsContext, WebSearchOptions } from './webSearch';
import * as tauriIpc from './tauriIpc';
import {
  requireMacroToolRegistryEntry,
  toFunctionToolShape,
} from '../shared/macroToolRegistry';
import type { ProjectMount, ReasoningEffort, ToolTrace } from '../types';
import { devLogger } from '../utils/devLogger';
import { useProviderStore } from '../stores/useProviderStore';

// Global references to active streaming resources for cancellation
let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let currentStream: ReadableStream<Uint8Array> | null = null;
let currentTauriRequestId: string | null = null;
let currentTauriUnlisteners: UnlistenFn[] = [];

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
  if (currentTauriRequestId && tauriIpc.isTauriAvailable()) {
    void tauriIpc.aiCancelStream(currentTauriRequestId).catch(() => {
      // Ignore backend cancel failures
    });
  }
  currentTauriRequestId = null;
  if (currentTauriUnlisteners.length > 0) {
    currentTauriUnlisteners.forEach((unlisten) => {
      try {
        unlisten();
      } catch {
        // Ignore listener cleanup errors
      }
    });
    currentTauriUnlisteners = [];
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
  tool_name?: string;
}

export interface StreamCompletionResult {
  visibleContent: string;
  toolTraces: ToolTrace[];
  hiddenContext?: string;
}

export interface StreamingChatOptions {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  messages: StreamMessage[];
  onToken: (token: string) => void;
  onComplete: (result: StreamCompletionResult) => void;
  onError: (error: Error) => void;
  onToolTracesUpdate?: (toolTraces: ToolTrace[]) => void;
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
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  showToolTraces?: boolean;
  guidedToolRetry?: {
    requiredToolNames: string[];
    retrySystemPrompt: string;
    maxRetries?: number;
  };
}

const emptyStreamCompletionResult = (visibleContent = ''): StreamCompletionResult => ({
  visibleContent,
  toolTraces: [],
});

const CHATGPT_MAX_TOOL_CONTEXT_CHARS_PER_TURN = 12000;
const CHATGPT_MAX_TOOL_RESULT_CHARS = 3200;
const CHATGPT_MIN_TOOL_RESULT_CHARS = 400;

const isReasoningUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('reasoning_effort') ||
    normalized.includes('reasoning.effort') ||
    normalized.includes('unsupported value for reasoning') ||
    normalized.includes('unsupported parameter: reasoning') ||
    normalized.includes('unknown parameter: reasoning') ||
    normalized.includes('unknown parameter: reasoning_effort') ||
    normalized.includes('does not support reasoning')
  );
};

const disableReasoningForSession = (providerId: string, modelId: string) => {
  try {
    useProviderStore.getState().markReasoningUnsupportedForModel(providerId, modelId);
  } catch {
    // Ignore runtime fallback bookkeeping outside app contexts.
  }
};

const applyReasoningToChatCompletionsRequest = (
  requestBody: Record<string, unknown>,
  providerType: string,
  reasoningEffort?: ReasoningEffort | null
) => {
  delete requestBody.reasoning_effort;
  delete requestBody.reasoning;
  delete requestBody.include_reasoning;

  if (!reasoningEffort) {
    return;
  }

  if (providerType === 'openrouter') {
    requestBody.reasoning = { effort: reasoningEffort };
    requestBody.include_reasoning = true;
    return;
  }

  if (providerType === 'openai' || providerType === 'ollama' || providerType === 'lmstudio') {
    requestBody.reasoning_effort = reasoningEffort;
  }
};

const escapeToolContextAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const formatToolTraceDetail = (toolName: string, args: Record<string, unknown>): string | undefined => {
  if (toolName === 'web_search') {
    return typeof args.query === 'string' ? args.query : undefined;
  }

  if (toolName === 'web_fetch') {
    return typeof args.url === 'string' ? args.url : undefined;
  }

  if (toolName === 'mark_source_passage') {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    if (title && kind) return `${title}, kind=${kind}`;
    return title || kind || undefined;
  }

  if (toolName === 'read_sources') {
    const parts = [
      typeof args.kind === 'string' && args.kind.trim() ? `kind=${args.kind.trim()}` : '',
      typeof args.query === 'string' && args.query.trim() ? `query=${args.query.trim()}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }

  if (toolName === 'edit_source_passage') {
    const parts = [
      typeof args.citation_id === 'string' && args.citation_id.trim()
        ? `id=${args.citation_id.trim()}`
        : '',
      typeof args.action === 'string' && args.action.trim() ? `action=${args.action.trim()}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }

  if (toolName === 'read_file') {
    const file = typeof args.file === 'string' ? args.file.trim() : '';
    const extractText = args.extract_text === true ? 'extract_text=true' : '';
    return [file, extractText].filter(Boolean).join(', ') || undefined;
  }

  if (
    toolName === 'list' ||
    toolName === 'read' ||
    toolName === 'write' ||
    toolName === 'edit'
  ) {
    return typeof args.path === 'string' ? args.path.trim() : undefined;
  }

  if (toolName === 'glob') {
    return typeof args.pattern === 'string' ? args.pattern.trim() : undefined;
  }

  if (toolName === 'grep') {
    return typeof args.query === 'string' ? args.query.trim() : undefined;
  }

  if (toolName === 'terminal_create_session') {
    return typeof args.project_id === 'string' ? args.project_id.trim() : undefined;
  }

  if (toolName === 'terminal_run') {
    return typeof args.command === 'string' ? args.command.trim() : undefined;
  }

  if (toolName === 'need_add') {
    return typeof args.title === 'string' ? args.title.trim() : undefined;
  }

  return undefined;
};

const formatToolUsageLabel = (toolName: string, args: Record<string, unknown>) => {
  const detail = formatToolTraceDetail(toolName, args);
  return detail ? `\n\n[TOOL] ${toolName} (${detail})\n` : `\n\n[TOOL] ${toolName}\n`;
};

const buildToolContextBlock = (
  toolCallId: string,
  toolName: string,
  detail: string | undefined,
  result: string
): string | null => {
  if (!result.trim()) return null;
  const attrs = [
    `tool_call_id="${escapeToolContextAttribute(toolCallId)}"`,
    `tool="${escapeToolContextAttribute(toolName)}"`,
    detail ? `detail="${escapeToolContextAttribute(detail)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<tool_context ${attrs}>\n${result}\n</tool_context>`;
};

const createStreamAccumulator = (options: Pick<StreamingChatOptions, 'onToken' | 'onToolTracesUpdate'>) => {
  let visibleContent = '';
  const toolTraces = new Map<string, ToolTrace>();
  const toolTraceOrder: string[] = [];
  const hiddenContextBlocks: string[] = [];

  const snapshotToolTraces = (): ToolTrace[] =>
    toolTraceOrder
      .map((toolCallId) => toolTraces.get(toolCallId))
      .filter((trace): trace is ToolTrace => Boolean(trace))
      .map((trace) => ({ ...trace }));

  const publishToolTraces = () => {
    options.onToolTracesUpdate?.(snapshotToolTraces());
  };

  const markRunningToolTracesDone = () => {
    let changed = false;
    for (const toolCallId of toolTraceOrder) {
      const trace = toolTraces.get(toolCallId);
      if (!trace || trace.status !== 'running') continue;
      toolTraces.set(toolCallId, { ...trace, status: 'done' });
      changed = true;
    }
    if (changed) {
      publishToolTraces();
    }
  };

  const appendVisibleChunk = (chunk: string, markToolsDone = true) => {
    if (!chunk) return;
    if (markToolsDone) {
      markRunningToolTracesDone();
    }
    visibleContent += chunk;
    options.onToken(chunk);
  };

  return {
    appendProviderDelta(chunk: string) {
      appendVisibleChunk(chunk, true);
    },
    flushProviderDelta() {
      // Provider deltas are appended directly.
    },
    appendSystemChunk(chunk: string, markToolsDone = false) {
      appendVisibleChunk(chunk, markToolsDone);
    },
    upsertRunningToolTrace(toolCallId: string, toolName: string, detail?: string) {
      const existingTrace = toolTraces.get(toolCallId);
      const nextTrace: ToolTrace = {
        tool_call_id: toolCallId,
        tool_name: toolName,
        detail,
        status: 'running',
        visible_offset: existingTrace?.visible_offset ?? visibleContent.length,
      };
      if (!toolTraces.has(toolCallId)) {
        toolTraceOrder.push(toolCallId);
      }
      toolTraces.set(toolCallId, nextTrace);
      publishToolTraces();
    },
    addHiddenToolContext(toolCallId: string, toolName: string, detail: string | undefined, result: string) {
      const block = buildToolContextBlock(toolCallId, toolName, detail, result);
      if (block) {
        hiddenContextBlocks.push(block);
      }
    },
    buildResult(): StreamCompletionResult {
      markRunningToolTracesDone();
      const hiddenContext = hiddenContextBlocks.join('\n\n').trim();
      return {
        visibleContent,
        toolTraces: snapshotToolTraces(),
        hiddenContext: hiddenContext || undefined,
      };
    },
  };
};

// Tool definitions for the LLM
const WEB_SEARCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('web_search'));
const WEB_FETCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('web_fetch'));
const MARK_SOURCE_PASSAGE_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('mark_source_passage')
);
const READ_SOURCES_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('read_sources'));
const EDIT_SOURCE_PASSAGE_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('edit_source_passage')
);
const READ_FILE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('read_file'));
const LIST_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('list'));
const READ_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('read'));
const WRITE_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('write'));
const EDIT_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('edit'));
const GLOB_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('glob'));
const GREP_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('grep'));
const GIT_STATUS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_status'));
const GIT_LOG_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_log'));
const GIT_BRANCH_LIST_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_branch_list'));
const GIT_DIFF_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_diff'));
const GIT_GET_TREE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_get_tree'));
const GIT_ADD_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_add'));
const GIT_COMMIT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_commit'));
const GIT_CHECKOUT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_checkout'));
const GIT_MERGE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_merge'));
const GIT_RESET_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_reset'));
const GIT_STASH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('git_stash'));
const TERMINAL_CREATE_SESSION_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('terminal_create_session')
);
const TERMINAL_RUN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('terminal_run'));
const TERMINAL_READ_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('terminal_read'));
const TERMINAL_KILL_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('terminal_kill'));
const ADD_NEED_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('need_add'));
export const GENERATE_PLAN_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('strategy_generate')
);
export const CREATE_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_create'));
export const LIST_PLANS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_list'));
export const GET_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_get'));
export const UPDATE_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_update'));
export const DELETE_PLAN_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('plan_delete'));
export const RESTORE_PLAN_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('plan_restore')
);
export const SET_ACTIVE_PLAN_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('plan_set_active')
);
const GET_STRATEGY_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('strategy_get'));
const UPDATE_STRATEGY_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('strategy_update')
);
const DELETE_STRATEGY_TOOL = toFunctionToolShape(
  requireMacroToolRegistryEntry('strategy_delete')
);

/**
 * Send a streaming chat completion request
 */
const createStreamingRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const clearTauriListeners = () => {
  if (currentTauriUnlisteners.length > 0) {
    currentTauriUnlisteners.forEach((unlisten) => {
      try {
        unlisten();
      } catch {
        // Ignore listener cleanup errors
      }
    });
    currentTauriUnlisteners = [];
  }
};

interface StreamingTurnResult {
  content: string;
  toolCalls: ToolCall[];
  responseId?: string;
  reasoningSummary?: string;
  toolTraces?: ToolTrace[];
  hiddenContext?: string;
}

const getValidToolCalls = (toolCalls: ToolCall[]): ToolCall[] =>
  toolCalls.filter((toolCall) => toolCall.id && toolCall.function.name);

const buildChatGptVisibleTurnContent = (
  content: string,
  reasoningSummary?: string | null
): string => {
  const trimmedContent = content.trim();
  const trimmedSummary = (reasoningSummary || '').trim();

  if (!trimmedSummary) {
    return content;
  }

  return trimmedContent
    ? `<think>${trimmedSummary}</think>\n${trimmedContent}`
    : `<think>${trimmedSummary}</think>`;
};

const isEmptyTerminalChatGptTurn = (content: string, toolCalls: ToolCall[]): boolean =>
  toolCalls.length === 0 && content.trim().length === 0;

const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 64) {
    return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
  }

  const marker = '\n\n[... truncated for model context ...]\n\n';
  const tailChars = Math.min(800, Math.max(160, Math.floor(maxChars * 0.25)));
  const headChars = Math.max(0, maxChars - marker.length - tailChars);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
};

const compactToolResultForChatGptModelContext = (
  toolName: string,
  result: string,
  maxChars: number
): string => {
  const normalizedMaxChars = Math.max(CHATGPT_MIN_TOOL_RESULT_CHARS, maxChars);
  if (result.length <= normalizedMaxChars) {
    return result;
  }

  const truncationNotice = `\n\n[Tool output truncated for model context. Tool=${toolName}; original_length=${result.length} chars.]`;
  const contentBudget = Math.max(0, normalizedMaxChars - truncationNotice.length);
  if (contentBudget === 0) {
    return `[Tool output truncated for model context. Tool=${toolName}; original_length=${result.length} chars.]`;
  }

  const fileMatch = result.match(/^(FILE:\s*[^\n]+(?:\n[^\n]+)*)\n\n([\s\S]*)$/m);
  if (fileMatch) {
    const header = fileMatch[1];
    const body = fileMatch[2];
    const headerBudget = Math.min(header.length, Math.max(80, Math.floor(contentBudget * 0.2)));
    const safeHeader = header.slice(0, headerBudget);
    const remainingBudget = Math.max(0, contentBudget - safeHeader.length - 2);
    const compactBody = truncateMiddle(body, remainingBudget);
    return `${safeHeader}\n\n${compactBody}${truncationNotice}`;
  }

  return `${truncateMiddle(result, contentBudget)}${truncationNotice}`;
};

export const __testables = {
  applyReasoningToChatCompletionsRequest,
  buildToolContextBlock,
  buildChatGptVisibleTurnContent,
  compactToolResultForChatGptModelContext,
  formatToolTraceDetail,
  isEmptyTerminalChatGptTurn,
  isReasoningUnsupportedError,
  shouldRetryMissingRequiredTool,
};

function shouldRetryMissingRequiredTool(
  policy: StreamingChatOptions['guidedToolRetry'],
  toolCalls: ToolCall[],
  retryCount: number
): boolean {
  if (!policy || retryCount >= (policy.maxRetries ?? 1)) {
    return false;
  }

  const requiredToolNames = new Set(policy.requiredToolNames);
  if (requiredToolNames.size === 0) {
    return false;
  }

  return !toolCalls.some((toolCall) => requiredToolNames.has(toolCall.function.name));
}

const collectAllowedTools = (params: {
  allowedTools: Set<string>;
  enableWebSearch: boolean;
  enableWebFetch: boolean;
  webSearchOptions?: WebSearchOptions;
}): unknown[] => {
  const { allowedTools, enableWebSearch, enableWebFetch, webSearchOptions } = params;
  const tools: unknown[] = [];

  if (allowedTools.has('list')) tools.push(LIST_TOOL);
  if (allowedTools.has('read')) tools.push(READ_WORKSPACE_TOOL);
  if (allowedTools.has('write')) tools.push(WRITE_WORKSPACE_TOOL);
  if (allowedTools.has('edit')) tools.push(EDIT_WORKSPACE_TOOL);
  if (allowedTools.has('glob')) tools.push(GLOB_WORKSPACE_TOOL);
  if (allowedTools.has('grep')) tools.push(GREP_WORKSPACE_TOOL);
  if (allowedTools.has('read_file')) tools.push(READ_FILE_TOOL);
  if (allowedTools.has('mark_source_passage')) tools.push(MARK_SOURCE_PASSAGE_TOOL);
  if (allowedTools.has('read_sources')) tools.push(READ_SOURCES_TOOL);
  if (allowedTools.has('edit_source_passage')) tools.push(EDIT_SOURCE_PASSAGE_TOOL);
  if (allowedTools.has('git_status')) tools.push(GIT_STATUS_TOOL);
  if (allowedTools.has('git_diff')) tools.push(GIT_DIFF_TOOL);
  if (allowedTools.has('git_log')) tools.push(GIT_LOG_TOOL);
  if (allowedTools.has('git_branch_list')) tools.push(GIT_BRANCH_LIST_TOOL);
  if (allowedTools.has('git_checkout')) tools.push(GIT_CHECKOUT_TOOL);
  if (allowedTools.has('git_commit')) tools.push(GIT_COMMIT_TOOL);
  if (allowedTools.has('git_add')) tools.push(GIT_ADD_TOOL);
  if (allowedTools.has('git_reset')) tools.push(GIT_RESET_TOOL);
  if (allowedTools.has('git_merge')) tools.push(GIT_MERGE_TOOL);
  if (allowedTools.has('git_stash')) tools.push(GIT_STASH_TOOL);
  if (allowedTools.has('git_get_tree')) tools.push(GIT_GET_TREE_TOOL);
  if (allowedTools.has('terminal_create_session')) tools.push(TERMINAL_CREATE_SESSION_TOOL);
  if (allowedTools.has('terminal_run')) tools.push(TERMINAL_RUN_TOOL);
  if (allowedTools.has('terminal_read')) tools.push(TERMINAL_READ_TOOL);
  if (allowedTools.has('terminal_kill')) tools.push(TERMINAL_KILL_TOOL);
  if (
    allowedTools.has('web_search') &&
    enableWebSearch &&
    (webSearchOptions?.tavilyApiKey || webSearchOptions?.braveApiKey)
  ) {
    tools.push(WEB_SEARCH_TOOL);
  }
  if (allowedTools.has('web_fetch') && enableWebFetch) tools.push(WEB_FETCH_TOOL);
  if (allowedTools.has('need_add')) tools.push(ADD_NEED_TOOL);
  if (allowedTools.has('strategy_generate')) tools.push(GENERATE_PLAN_TOOL);
  if (allowedTools.has('plan_create')) tools.push(CREATE_PLAN_TOOL);
  if (allowedTools.has('plan_list')) tools.push(LIST_PLANS_TOOL);
  if (allowedTools.has('plan_get')) tools.push(GET_PLAN_TOOL);
  if (allowedTools.has('plan_update')) tools.push(UPDATE_PLAN_TOOL);
  if (allowedTools.has('plan_delete')) tools.push(DELETE_PLAN_TOOL);
  if (allowedTools.has('plan_restore')) tools.push(RESTORE_PLAN_TOOL);
  if (allowedTools.has('plan_set_active')) tools.push(SET_ACTIVE_PLAN_TOOL);
  if (allowedTools.has('strategy_get')) tools.push(GET_STRATEGY_TOOL);
  if (allowedTools.has('strategy_update')) tools.push(UPDATE_STRATEGY_TOOL);
  if (allowedTools.has('strategy_delete')) tools.push(DELETE_STRATEGY_TOOL);

  return tools;
};

const streamNativeTurnViaTauri = async (params: {
  providerId: string;
  providerType: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  previousResponseId?: string | null;
  messages: StreamMessage[];
  tools: unknown[];
  allowedToolIds?: string[];
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}): Promise<StreamingTurnResult> => {
  if (!tauriIpc.isTauriAvailable()) {
    throw new Error(`${params.providerType} provider requires the desktop backend.`);
  }

  clearTauriListeners();

  const requestId = createStreamingRequestId();
  currentTauriRequestId = requestId;

  let fullContent = '';

  return new Promise<StreamingTurnResult>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTauriListeners();
      currentTauriRequestId = null;
      fn();
    };

    const signalHandler = () => {
      void tauriIpc.aiCancelStream(requestId).catch(() => {
        // Ignore backend cancel failures
      });
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };

    if (params.signal?.aborted) {
      signalHandler();
      return;
    }

    if (params.signal) {
      params.signal.addEventListener('abort', signalHandler, { once: true });
    }

    void (async () => {
      try {
        const unlisteners = await Promise.all([
          listen<tauriIpc.AiStreamChunkEvent>('ai:stream', (event) => {
            if (event.payload.request_id !== requestId) return;
            fullContent += event.payload.delta;
            params.onDelta(event.payload.delta);
          }),
          listen<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            finish(() =>
              resolve({
                content: event.payload.output_text || fullContent,
                toolCalls: event.payload.tool_calls || [],
                responseId: event.payload.response_id ?? undefined,
                reasoningSummary: event.payload.reasoning_summary ?? undefined,
                toolTraces: event.payload.tool_traces ?? undefined,
                hiddenContext: event.payload.hidden_context ?? undefined,
              })
            );
          }),
          listen<tauriIpc.AiStreamErrorEvent>('ai:error', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            finish(() => reject(new Error(event.payload.message)));
          }),
        ]);

        currentTauriUnlisteners = unlisteners;

        await tauriIpc.aiStreamChat({
          requestId,
          providerId: params.providerId,
          modelId: params.modelId,
          reasoningEffort: params.reasoningEffort ?? null,
          previousResponseId: params.previousResponseId ?? null,
          messages: params.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
          })),
          tools: params.tools,
          toolChoice: 'auto',
          parallelToolCalls: false,
          workspacePath: params.workspacePath,
          defaultWorkspacePath: params.defaultWorkspacePath,
          projectMounts: params.projectMounts,
          virtualRootEnabled: params.virtualRootEnabled,
          focusedProjectId: params.focusedProjectId,
          allowedToolIds: params.allowedToolIds,
        });
      } catch (error) {
        if (params.signal) {
          params.signal.removeEventListener('abort', signalHandler);
        }
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
};

const streamChatViaChatGptProvider = async (options: StreamingChatOptions): Promise<void> => {
  const {
    providerId,
    modelId,
    messages,
    onToken,
    onComplete,
    onError,
    onToolTracesUpdate,
    enableWebSearch = true,
    enableWebFetch = true,
    webSearchOptions,
    onToolCall,
    onToolResult,
    fileToolContext = [],
    allowedToolIds,
    showToolTraces = false,
  } = options;

  const allowedTools = new Set(allowedToolIds ?? []);
  const tools = collectAllowedTools({
    allowedTools,
    enableWebSearch,
    enableWebFetch,
    webSearchOptions,
  });
  const streamAccumulator = createStreamAccumulator({
    onToken,
    onToolTracesUpdate,
  });
  let currentMessages: StreamMessage[] = [...messages];
  const readEvidenceBySource = new Map<string, string>();
  const MAX_TURNS = 10;
  let turnCount = 0;
  let guidedRetryCount = 0;
  let enforceGuidedToolRetry = Boolean(options.guidedToolRetry);

  const normalizeSourceKey = (value?: string): string =>
    (value || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();

  const rememberReadEvidence = (source: string, content: string) => {
    const key = normalizeSourceKey(source);
    if (!key || !content.trim()) return;
    readEvidenceBySource.set(key, content);
  };

  const rememberReadEvidenceFromWorkspaceResult = (result: string) => {
    const fileHeaderMatch = result.match(/^FILE:\s*(.+)$/m);
    if (!fileHeaderMatch) return;

    const filePath = fileHeaderMatch[1].trim();
    const separatorIndex = result.indexOf('\n\n');
    const content = separatorIndex >= 0 ? result.slice(separatorIndex + 2) : '';
    rememberReadEvidence(filePath, content);
  };

  try {
    while (turnCount < MAX_TURNS) {
      if (options.signal?.aborted) {
        onComplete(streamAccumulator.buildResult());
        return;
      }

      const shouldBufferTurnOutput = enforceGuidedToolRetry;
      let streamedTurnContent = '';
      const turnResult = await streamNativeTurnViaTauri({
        providerId,
        providerType: 'chatgpt',
        modelId,
        reasoningEffort: options.reasoningEffort,
        messages: currentMessages,
        tools,
        allowedToolIds: options.allowedToolIds,
        workspacePath: options.workspacePath,
        defaultWorkspacePath: options.defaultWorkspacePath,
        projectMounts: options.projectMounts,
        virtualRootEnabled: options.virtualRootEnabled,
        focusedProjectId: options.focusedProjectId,
        signal: options.signal,
        onDelta: (delta) => {
          streamedTurnContent += delta;
          if (!shouldBufferTurnOutput) {
            streamAccumulator.appendProviderDelta(delta);
          }
        },
      });

      const turnContent = buildChatGptVisibleTurnContent(
        turnResult.content || streamedTurnContent,
        turnResult.reasoningSummary
      );
      const validToolCalls = getValidToolCalls(turnResult.toolCalls);

      if (shouldRetryMissingRequiredTool(options.guidedToolRetry, validToolCalls, guidedRetryCount)) {
        guidedRetryCount += 1;
        currentMessages.push({
          role: 'system',
          content: options.guidedToolRetry?.retrySystemPrompt || '',
        });
        turnCount += 1;
        continue;
      }

      enforceGuidedToolRetry = false;
      if (shouldBufferTurnOutput && turnContent) {
        streamAccumulator.appendProviderDelta(turnContent);
      }
      streamAccumulator.flushProviderDelta();

      if (turnContent.trim().length > 0 || validToolCalls.length > 0) {
        currentMessages.push({
          role: 'assistant',
          content: turnContent,
          ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
        });
      }

      if (validToolCalls.length === 0) {
        if (isEmptyTerminalChatGptTurn(turnContent, validToolCalls)) {
          throw new Error('Reponse ChatGPT vide apres execution des outils.');
        }
        break;
      }

      const toolResults: ToolResult[] = [];

      for (const toolCall of validToolCalls) {
        const toolName = toolCall.function.name;
        let toolResult = '';
        let customToolResult: string | undefined;
        let detail: string | undefined;

        try {
          const args = JSON.parse(toolCall.function.arguments);
          detail = formatToolTraceDetail(toolName, args);
          streamAccumulator.upsertRunningToolTrace(toolCall.id, toolName, detail);

          if (!allowedTools.has(toolName)) {
            toolResult = `Tool ${toolName} is disabled for the current mode.`;
            toolResults.push({ tool_call_id: toolCall.id, content: toolResult, tool_name: toolName });
            streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
            continue;
          }

          const customResult = await onToolCall?.(toolName, args);
          customToolResult = typeof customResult === 'string' ? customResult : undefined;

          if (showToolTraces) {
            streamAccumulator.appendSystemChunk(formatToolUsageLabel(toolName, args), false);
          }

          if (toolName === 'web_search') {
            if (!enableWebSearch || (!webSearchOptions?.tavilyApiKey && !webSearchOptions?.braveApiKey)) {
              toolResult = 'Web search is not configured for this provider.';
              onToolResult?.(toolName, toolResult);
              toolResults.push({ tool_call_id: toolCall.id, content: toolResult, tool_name: toolName });
              streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
              continue;
            }
            const searchResults = await webSearch(args.query, webSearchOptions);
            toolResult = formatSearchResultsAsContext(searchResults);

            if (showToolTraces) {
              const searchMsg = `\n\n🔍 **Recherche web:** "${args.query}"\n`;
              streamAccumulator.appendSystemChunk(searchMsg, false);
            }
          }

          if (toolName === 'web_fetch') {
            if (!enableWebFetch) {
              toolResult = 'Web fetch is disabled for this provider.';
              onToolResult?.(toolName, toolResult);
              toolResults.push({ tool_call_id: toolCall.id, content: toolResult, tool_name: toolName });
              streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
              continue;
            }
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
            let workspaceReadAttempted = false;
            const workspaceMode = allowedTools.has('read') || allowedTools.has('list');

            if (requestedRaw && allowedTools.has('read') && onToolCall) {
              workspaceReadAttempted = true;
              const workspaceResult = await onToolCall('read', {
                path: requestedRaw,
                start_line: typeof args.start_line === 'number' ? args.start_line : undefined,
                end_line: typeof args.end_line === 'number' ? args.end_line : undefined,
              });

              if (typeof workspaceResult === 'string' && workspaceResult.trim()) {
                const isWorkspaceReadError =
                  /^Error executing read:/i.test(workspaceResult) ||
                  /^Missing\s+/i.test(workspaceResult) ||
                  /^No match found/i.test(workspaceResult) ||
                  /^File not found/i.test(workspaceResult) ||
                  /^Cannot\s+/i.test(workspaceResult);

                if (isWorkspaceReadError) {
                  toolResult = `Error executing tool read_file: ${workspaceResult}`;
                } else {
                  toolResult = workspaceResult;
                  rememberReadEvidenceFromWorkspaceResult(workspaceResult);
                }
              } else {
                toolResult = 'Error executing tool read_file: workspace read returned no content.';
              }
            }

            if (!toolResult.trim()) {
              if (workspaceReadAttempted) {
                toolResult = `Error executing tool read_file: unable to read "${requestedRaw}" from workspace.`;
              } else if (workspaceMode) {
                toolResult =
                  `Error executing tool read_file: workspace read tool is unavailable for "${requestedRaw}".` +
                  ' Use the read tool directly with an explicit path.';
              } else {
                const contextMatch = fileToolContext.find((file) => {
                  const title = normalizeMatch(file.title);
                  const source = normalizeMatch(file.source);
                  const path = normalizeMatch(file.path);
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
                } else if (!contextMatch) {
                  toolResult = `File not found in context: "${requestedRaw}". Available files: ${available.join(', ') || 'none'}`;
                } else {
                  const label = contextMatch.path || contextMatch.title || contextMatch.source;
                  const content = (contextMatch.snippet || '').trim();
                  const base = content
                    ? `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\n${content}`
                    : `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\nNo textual content available for this file in context.`;

                  const isDocx = /\.docx$/i.test(label || '');
                  const extractNotice =
                    extractText && isDocx
                      ? '\n\nNote: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text.'
                      : '';

                  toolResult = `${base}${extractNotice}`;
                  if (label) {
                    rememberReadEvidence(label, content);
                  }
                }
              }
            }
          }

          if (toolName === 'mark_source_passage') {
            const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
            const kind = rawKind === 'interesting' ? 'interesting' : 'used';
            const source = typeof args.source === 'string' ? args.source : '';
            const title = typeof args.title === 'string' ? args.title : '';
            const passage = typeof args.passage === 'string' ? args.passage : '';
            const normalizedPassage = passage.trim();

            const sourceKey = normalizeSourceKey(source || title);
            const sourceEvidence = sourceKey ? readEvidenceBySource.get(sourceKey) : undefined;
            const anyEvidence = Array.from(readEvidenceBySource.values());
            const hasMatchingEvidence = normalizedPassage
              ? (
                (sourceEvidence && sourceEvidence.includes(normalizedPassage)) ||
                anyEvidence.some((evidence) => evidence.includes(normalizedPassage))
              )
              : false;

            if (!hasMatchingEvidence) {
              toolResult = 'Error executing tool mark_source_passage: passage is not present in previously read file content.';
            } else {
              toolResult = `Source passage marked successfully (kind=${kind}).`;
            }
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
          streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
        } catch (error) {
          toolResult = `Error executing tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
          onToolResult?.(toolName, toolResult);
          streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
        }

        toolResults.push({
          tool_call_id: toolCall.id,
          content: toolResult,
          tool_name: toolName,
        });
      }

      if (toolResults.length > 0) {
        const hasToolErrors = toolResults.some((result) => {
          const content = result.content.trim();
          return (
            /^Error executing/i.test(content) ||
            /^Missing\s+/i.test(content) ||
            /^No match found/i.test(content) ||
            /^File not found/i.test(content) ||
            /^Cannot\s+/i.test(content)
          );
        });
        const hasFileReadResults = toolResults.some((result) => /^FILE:\s+/m.test(result.content));
        let remainingToolContextBudget = CHATGPT_MAX_TOOL_CONTEXT_CHARS_PER_TURN;
        const compactedToolMessages = toolResults.map((result) => {
          const perToolBudget = Math.min(
            CHATGPT_MAX_TOOL_RESULT_CHARS,
            Math.max(CHATGPT_MIN_TOOL_RESULT_CHARS, remainingToolContextBudget)
          );
          const compactContent = compactToolResultForChatGptModelContext(
            result.tool_name || 'tool',
            result.content,
            perToolBudget
          );
          remainingToolContextBudget = Math.max(0, remainingToolContextBudget - compactContent.length);
          return {
            role: 'tool' as const,
            content: compactContent,
            tool_call_id: result.tool_call_id,
          };
        });

        currentMessages.push(...compactedToolMessages);

        if (hasToolErrors || hasFileReadResults) {
          devLogger.info('ChatGPT follow-up turn proceeding with full transcript after guarded tool results', {
            hasToolErrors,
            hasFileReadResults,
            toolResultCount: toolResults.length,
          });
        }
      }

      turnCount++;
    }

    onComplete(streamAccumulator.buildResult());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onComplete(streamAccumulator.buildResult());
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
  } finally {
    clearTauriListeners();
    currentTauriRequestId = null;
  }
};

const streamChatViaCopilotProvider = async (options: StreamingChatOptions): Promise<void> => {
  try {
    const turn = await streamNativeTurnViaTauri({
      providerId: options.providerId,
      providerType: 'copilot',
      modelId: options.modelId,
      reasoningEffort: options.reasoningEffort,
      messages: options.messages,
      tools: [],
      allowedToolIds: options.allowedToolIds,
      workspacePath: options.workspacePath,
      defaultWorkspacePath: options.defaultWorkspacePath,
      projectMounts: options.projectMounts,
      virtualRootEnabled: options.virtualRootEnabled,
      focusedProjectId: options.focusedProjectId,
      signal: options.signal,
      onDelta: options.onToken,
    });

    if (turn.toolTraces) {
      options.onToolTracesUpdate?.(turn.toolTraces);
    }

    options.onComplete({
      visibleContent: turn.content,
      toolTraces: turn.toolTraces ?? [],
      hiddenContext: turn.hiddenContext,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    options.onError(err);
  }
};

export async function streamChat(options: StreamingChatOptions): Promise<void> {
  if (options.providerType === 'chatgpt') {
    return streamChatViaChatGptProvider(options);
  }

  if (options.providerType === 'copilot') {
    return streamChatViaCopilotProvider(options);
  }

  const {
    providerId,
    providerType,
    baseUrl,
    apiKey,
    modelId,
    reasoningEffort,
    messages,
    onToken,
    onComplete,
    onError,
    onToolTracesUpdate,
    enableWebSearch = true,
    enableWebFetch = true,
    webSearchOptions,
    onToolCall,
    onToolResult,
    fileToolContext = [],
    allowedToolIds,
    showToolTraces = false,
    // Note: signal is not used with Tauri HTTP plugin - AbortController support is limited
  } = options;

  const allowedTools = new Set(allowedToolIds ?? []);
  const streamAccumulator = createStreamAccumulator({
    onToken,
    onToolTracesUpdate,
  });

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
    devLogger.log(`[${providerId}] Connecting to ${baseUrl}/chat/completions`);
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
  let currentReasoningEffort = reasoningEffort;
  let didRetryWithoutReasoning = false;
  applyReasoningToChatCompletionsRequest(requestBody, providerType, currentReasoningEffort);

  const tools = collectAllowedTools({
    allowedTools,
    enableWebSearch,
    enableWebFetch,
    webSearchOptions,
  });
  if (tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
    requestBody.parallel_tool_calls = false;
  }

  // Storage for the entire conversation (mutated across loop turns)
  let currentMessages: StreamMessage[] = [...messages];
  const readEvidenceBySource = new Map<string, string>();
  const MAX_TURNS = 10;
  let turnCount = 0;
  let guidedRetryCount = 0;
  let enforceGuidedToolRetry = Boolean(options.guidedToolRetry);

  const normalizeSourceKey = (value?: string): string =>
    (value || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();

  const rememberReadEvidence = (source: string, content: string) => {
    const key = normalizeSourceKey(source);
    if (!key || !content.trim()) return;
    readEvidenceBySource.set(key, content);
  };

  const rememberReadEvidenceFromWorkspaceResult = (result: string) => {
    const fileHeaderMatch = result.match(/^FILE:\s*(.+)$/m);
    if (!fileHeaderMatch) return;

    const filePath = fileHeaderMatch[1].trim();
    const separatorIndex = result.indexOf('\n\n');
    const content = separatorIndex >= 0 ? result.slice(separatorIndex + 2) : '';
    rememberReadEvidence(filePath, content);
  };

  try {
    while (turnCount < MAX_TURNS) {
      if (options.signal?.aborted) {
        onComplete(streamAccumulator.buildResult());
        return;
      }

      requestBody.messages = currentMessages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      }));
      applyReasoningToChatCompletionsRequest(requestBody, providerType, currentReasoningEffort);

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

        if (
          currentReasoningEffort &&
          !didRetryWithoutReasoning &&
          isReasoningUnsupportedError(errorMessage)
        ) {
          didRetryWithoutReasoning = true;
          currentReasoningEffort = null;
          disableReasoningForSession(providerId, modelId);
          continue;
        }

        if (turnCount === 0) {
          throw new Error(errorMessage);
        } else {
          const loopError = `\n\n[System: The agent loop stopped due to an API error: ${errorMessage}]`;
          streamAccumulator.appendSystemChunk(loopError, true);
          break;
        }
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      // Store references for cancellation
      currentStream = response.body;
      const reader = currentStream.getReader();
      currentReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let isThinking = false;
      let toolCalls: ToolCall[] = [];
      let turnContent = ''; // The text generated *in this specific turn*
      const shouldBufferTurnOutput = enforceGuidedToolRetry;
      const appendTurnChunk = (chunk: string) => {
        if (!chunk) return;
        turnContent += chunk;
        if (!shouldBufferTurnOutput) {
          streamAccumulator.appendProviderDelta(chunk);
        }
      };

      const startThinking = () => {
        if (!isThinking) {
          appendTurnChunk('<think>');
          isThinking = true;
        }
      };

      const endThinking = () => {
        if (isThinking) {
          appendTurnChunk('</think>');
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
          onComplete(streamAccumulator.buildResult());
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
                appendTurnChunk(reasoning);
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
                appendTurnChunk(delta.content);
              }
            } catch (e) {
              // Skip malformed JSON - some providers send non-JSON lines
              devLogger.debug('Failed to parse SSE data:', data);
            }
          }
        }
      }

      endThinking();

      // Handle tool calls if any
      const validToolCalls = getValidToolCalls(toolCalls);

      if (shouldRetryMissingRequiredTool(options.guidedToolRetry, validToolCalls, guidedRetryCount)) {
        guidedRetryCount += 1;
        currentMessages.push({
          role: 'system',
          content: options.guidedToolRetry?.retrySystemPrompt || '',
        });
        turnCount += 1;
        continue;
      }

      enforceGuidedToolRetry = false;
      if (shouldBufferTurnOutput && turnContent) {
        streamAccumulator.appendProviderDelta(turnContent);
      }
      streamAccumulator.flushProviderDelta();

      if (turnContent.trim().length > 0 || validToolCalls.length > 0) {
        currentMessages.push({
          role: 'assistant',
          content: turnContent,
          ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
        });
      }

      if (validToolCalls.length > 0) {
        const toolResults: ToolResult[] = [];

        for (const toolCall of validToolCalls) {
          const toolName = toolCall.function.name;
          let toolResult = '';
          let customToolResult: string | undefined;
          let detail: string | undefined;

          try {
            const args = JSON.parse(toolCall.function.arguments);
            detail = formatToolTraceDetail(toolName, args);
            streamAccumulator.upsertRunningToolTrace(toolCall.id, toolName, detail);

            if (!allowedTools.has(toolName)) {
              toolResult = `Tool ${toolName} is disabled for the current mode.`;
              toolResults.push({
                tool_call_id: toolCall.id,
                content: toolResult,
              });
              streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
              continue;
            }

            const customResult = await onToolCall?.(toolName, args);
            customToolResult = typeof customResult === 'string' ? customResult : undefined;

            if (showToolTraces) {
              streamAccumulator.appendSystemChunk(formatToolUsageLabel(toolName, args), false);
            }

            if (toolName === 'web_search') {
              if (!enableWebSearch || (!webSearchOptions?.tavilyApiKey && !webSearchOptions?.braveApiKey)) {
                toolResult = 'Web search is not configured for this provider.';
                onToolResult?.(toolName, toolResult);
                toolResults.push({
                  tool_call_id: toolCall.id,
                  content: toolResult,
                });
                streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
                continue;
              }

              // Execute web search
              const searchResults = await webSearch(args.query, webSearchOptions);
              toolResult = formatSearchResultsAsContext(searchResults);

              // Show search indicator in chat
              if (showToolTraces) {
                const searchMsg = `\n\n🔍 **Recherche web:** "${args.query}"\n`;
                streamAccumulator.appendSystemChunk(searchMsg, false);
              }
            }

            if (toolName === 'web_fetch') {
              if (!enableWebFetch) {
                toolResult = 'Web fetch is disabled for this provider.';
                onToolResult?.(toolName, toolResult);
                toolResults.push({
                  tool_call_id: toolCall.id,
                  content: toolResult,
                });
                streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
                continue;
              }

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
              let workspaceReadAttempted = false;
              const workspaceMode = allowedTools.has('read') || allowedTools.has('list');

              if (requestedRaw && allowedTools.has('read') && onToolCall) {
                workspaceReadAttempted = true;
                const workspaceResult = await onToolCall('read', {
                  path: requestedRaw,
                  start_line: typeof args.start_line === 'number' ? args.start_line : undefined,
                  end_line: typeof args.end_line === 'number' ? args.end_line : undefined,
                });

                if (typeof workspaceResult === 'string' && workspaceResult.trim()) {
                  const isWorkspaceReadError =
                    /^Error executing read:/i.test(workspaceResult) ||
                    /^Missing\s+/i.test(workspaceResult) ||
                    /^No match found/i.test(workspaceResult) ||
                    /^File not found/i.test(workspaceResult) ||
                    /^Cannot\s+/i.test(workspaceResult);

                  if (isWorkspaceReadError) {
                    toolResult = `Error executing tool read_file: ${workspaceResult}`;
                  } else {
                    toolResult = workspaceResult;
                    rememberReadEvidenceFromWorkspaceResult(workspaceResult);
                  }
                } else {
                  toolResult = 'Error executing tool read_file: workspace read returned no content.';
                }
              }

              if (toolResult.trim()) {
                // We already have authoritative workspace output; do not fall back to context snippets.
              } else if (workspaceReadAttempted) {
                toolResult = `Error executing tool read_file: unable to read "${requestedRaw}" from workspace.`;
              } else if (workspaceMode) {
                toolResult =
                  `Error executing tool read_file: workspace read tool is unavailable for "${requestedRaw}".` +
                  ` Use the read tool directly with an explicit path.`;
              } else {
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
                    ? `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\n${content}`
                    : `FILE: ${label}\nSOURCE: CONTEXT_SNIPPET\n\nNo textual content available for this file in context.`;

                  const isDocx = /\.docx$/i.test(label || '');
                  const extractNotice =
                    extractText && isDocx
                      ? '\n\nNote: extract_text=true requested. Rich DOCX extraction is not available in this build; using available context text.'
                      : '';

                  toolResult = `${base}${extractNotice}`;
                  if (label) {
                    rememberReadEvidence(label, content);
                  }
                }
              }
            }

            if (toolName === 'mark_source_passage') {
              const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
              const kind = rawKind === 'interesting' ? 'interesting' : 'used';
              const source = typeof args.source === 'string' ? args.source : '';
              const title = typeof args.title === 'string' ? args.title : '';
              const passage = typeof args.passage === 'string' ? args.passage : '';
              const normalizedPassage = passage.trim();

              const sourceKey = normalizeSourceKey(source || title);
              const sourceEvidence = sourceKey ? readEvidenceBySource.get(sourceKey) : undefined;
              const anyEvidence = Array.from(readEvidenceBySource.values());
              const hasMatchingEvidence = normalizedPassage
                ? (
                  (sourceEvidence && sourceEvidence.includes(normalizedPassage)) ||
                  anyEvidence.some((evidence) => evidence.includes(normalizedPassage))
                )
                : false;

              if (!hasMatchingEvidence) {
                toolResult = 'Error executing tool mark_source_passage: passage is not present in previously read file content.';
              } else {
                toolResult = `Source passage marked successfully (kind=${kind}).`;
              }
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
            streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
          } catch (e) {
            toolResult = `Error executing tool ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
            onToolResult?.(toolName, toolResult);
            streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
          }

          toolResults.push({
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        // If we have tool results, make a follow-up request to get the final response
        if (toolResults.length > 0) {
          const hasToolErrors = toolResults.some((result) => {
            const content = result.content.trim();
            return (
              /^Error executing/i.test(content) ||
              /^Missing\s+/i.test(content) ||
              /^No match found/i.test(content) ||
              /^File not found/i.test(content) ||
              /^Cannot\s+/i.test(content)
            );
          });
          const hasFileReadResults = toolResults.some((result) => /^FILE:\s+/m.test(result.content));
          if (providerType === '__legacy_workspace_fallback__') {
            const deterministicError = [
              'La lecture fichier ne provient pas du workspace actif (context snippet uniquement).',
              'Je refuse de synthétiser ce contenu pour éviter les hallucinations.',
              'Relance avec un chemin explicite (ex: README.md) ou vérifie le root Debug.',
            ].join('\n');

            void deterministicError;
          }

          if (providerType === '__legacy_workspace_fallback__') {
            const errorLines = toolResults
              .map((result) => result.content.trim())
              .filter((content) => /^Error executing/i.test(content) || /^Missing\s+/i.test(content) || /^File not found/i.test(content));

            if (errorLines.length > 0) {
              const deterministicError = [
                'La lecture workspace a échoué. Sortie brute des outils :',
                ...errorLines.map((line) => `- ${line}`),
                '',
                'Je ne peux pas déduire le contenu du fichier sans sortie de lecture valide.',
              ].join('\n');

              void deterministicError;
            }
          }

          currentMessages.push(
            ...toolResults.map((result) => ({
              role: 'tool' as const,
              content: result.content,
              tool_call_id: result.tool_call_id,
            }))
          );

          const guardSystemMessages: StreamMessage[] = [];
          if (hasToolErrors) {
            guardSystemMessages.push({
              role: 'system',
              content:
                'One or more tool calls failed. Do not fabricate file contents or command outputs. ' +
                'State the exact failure and ask for a corrected path/context when needed.',
            });
          }
          if (hasFileReadResults) {
            guardSystemMessages.push({
              role: 'system',
              content:
                'For file analysis tasks, use ONLY the exact tool outputs provided in this conversation. ' +
                'Do not invent code symbols, structs, handlers, routes, or data not present in tool output. ' +
                'If uncertain, say that the information is not present in the file content you received.',
            });
          }

          if (guardSystemMessages.length > 0) {
            currentMessages.push(...guardSystemMessages);
          }
        }
      }

      // If no valid tool calls were made in this turn, we are done
      if (validToolCalls.length === 0) {
        break;
      }

      turnCount++;
    }

    onComplete(streamAccumulator.buildResult());
  } catch (error) {
    // Cleanup on error
    if (currentReader) {
      currentReader = null;
    }
    if (currentStream) {
      currentStream = null;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      onComplete(streamAccumulator.buildResult());
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
    providerId,
    providerType,
    baseUrl,
    apiKey,
    modelId,
    reasoningEffort,
    messages,
    onComplete,
    onError,
  } = options;

  if (providerType === 'chatgpt' || providerType === 'copilot') {
    try {
      const turn = await streamNativeTurnViaTauri({
        providerId,
        providerType,
        modelId,
        reasoningEffort: options.reasoningEffort,
        messages,
        tools: [],
        allowedToolIds: options.allowedToolIds,
        workspacePath: options.workspacePath,
        defaultWorkspacePath: options.defaultWorkspacePath,
        projectMounts: options.projectMounts,
        virtualRootEnabled: options.virtualRootEnabled,
        focusedProjectId: options.focusedProjectId,
        signal: options.signal,
        onDelta: () => {
          // No-op for metadata generation.
        },
      });
      onComplete({
        visibleContent: turn.content,
        toolTraces: turn.toolTraces ?? [],
        hiddenContext: turn.hiddenContext,
      });
      return turn.content;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError(err);
      throw err;
    }
  }

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
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    };
    applyReasoningToChatCompletionsRequest(requestBody, providerType, reasoningEffort);

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

      if (reasoningEffort && isReasoningUnsupportedError(errorMessage)) {
        disableReasoningForSession(providerId, modelId);
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
    onComplete(emptyStreamCompletionResult(content));
    return content;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
    throw err;
  }
}
