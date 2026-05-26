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
import { ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT } from './architectChat';
import { normalizeChatMaxTurns } from './chatTurnLimits';
import { isContextOverflowMessage } from './contextOverflow';
import type { InternalAgentProfile } from './internalAgentProfile';
import {
  applyReasoningToChatCompletionsRequest,
  resolveChatCompletionProviderProtocolProfile,
  shouldRequestProviderReasoning,
  type ChatCompletionProviderProtocolProfile,
} from './providerProtocolProfiles';
import {
  isMacroToolCopilotBuiltInOverride,
  requireMacroToolRegistryEntry,
  toFunctionToolShape,
} from '../shared/macroToolRegistry';
import { toMCPFunctionToolShape } from './mcp';
import type {
  AppMode,
  ChatCompletionReason,
  MCPTool,
  ProjectMount,
  ProviderTurnState,
  ReasoningEffort,
  ToolTrace,
} from '../types';
import { devLogger } from '../utils/devLogger';
import { useProviderStore } from '../stores/useProviderStore';

interface ActiveStreamResources {
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  stream: ReadableStream<Uint8Array> | null;
  tauriRequestId: string | null;
  tauriUnlisteners: UnlistenFn[];
}

const CHAT_COMPLETION_PROVIDER_ITEM_TYPE = 'chat_completion_message';
const GENERIC_REQUEST_TIMEOUT_MS = 120_000;
const GENERIC_STREAM_IDLE_TIMEOUT_MS = 45_000;
const GENERIC_RETRY_BASE_DELAY_MS = 250;
const GENERIC_RETRY_MAX_DELAY_MS = 5_000;
const GENERIC_RETRY_MAX_ATTEMPTS = 2;
const TOOL_DOOM_LOOP_THRESHOLD = 3;
const TOOL_EXECUTION_ABORTED_RESULT = 'Tool execution aborted';
const REPEATED_TOOL_CALL_ABORT_RESULT =
  'Tool execution aborted: repeated identical tool call.';
const HISTORICAL_TOOL_RESULT_MAX_CHARS = 1600;

const DEFAULT_STREAM_SESSION_ID = '__default__';
const activeStreamResourcesBySessionId = new Map<string, ActiveStreamResources>();

const getStreamSessionId = (sessionId?: string): string =>
  sessionId && sessionId.trim().length > 0 ? sessionId : DEFAULT_STREAM_SESSION_ID;

const getOrCreateActiveStreamResources = (sessionId?: string): ActiveStreamResources => {
  const resolvedSessionId = getStreamSessionId(sessionId);
  const existing = activeStreamResourcesBySessionId.get(resolvedSessionId);
  if (existing) {
    return existing;
  }

  const created: ActiveStreamResources = {
    reader: null,
    stream: null,
    tauriRequestId: null,
    tauriUnlisteners: [],
  };
  activeStreamResourcesBySessionId.set(resolvedSessionId, created);
  return created;
};

const cleanupStreamListeners = (resources: ActiveStreamResources) => {
  if (resources.tauriUnlisteners.length === 0) {
    return;
  }

  resources.tauriUnlisteners.forEach((unlisten) => {
    try {
      unlisten();
    } catch {
      // Ignore listener cleanup errors
    }
  });
  resources.tauriUnlisteners = [];
};

const pruneActiveStreamResources = (sessionId?: string) => {
  const resolvedSessionId = getStreamSessionId(sessionId);
  const resources = activeStreamResourcesBySessionId.get(resolvedSessionId);
  if (!resources) {
    return;
  }

  if (
    resources.reader === null &&
    resources.stream === null &&
    resources.tauriRequestId === null &&
    resources.tauriUnlisteners.length === 0
  ) {
    activeStreamResourcesBySessionId.delete(resolvedSessionId);
  }
};

/**
 * Cancel the currently active stream
 */
export function cancelStream(sessionId?: string): void {
  const sessionIds = sessionId
    ? [getStreamSessionId(sessionId)]
    : Array.from(activeStreamResourcesBySessionId.keys());

  sessionIds.forEach((activeSessionId) => {
    const resources = activeStreamResourcesBySessionId.get(activeSessionId);
    if (!resources) {
      return;
    }

    if (resources.reader) {
      resources.reader.cancel().catch(() => {
        // Ignore errors during cancel
      });
      resources.reader = null;
    }
    if (resources.stream) {
      resources.stream.cancel().catch(() => {
        // Ignore errors during cancel
      });
      resources.stream = null;
    }
    if (resources.tauriRequestId && tauriIpc.isTauriAvailable()) {
      void tauriIpc.aiCancelStream(resources.tauriRequestId).catch(() => {
        // Ignore backend cancel failures
      });
    }
    resources.tauriRequestId = null;
    cleanupStreamListeners(resources);
    pruneActiveStreamResources(activeSessionId);
  });
}

const clearTauriListeners = (sessionId?: string) => {
  const resources = activeStreamResourcesBySessionId.get(getStreamSessionId(sessionId));
  if (!resources) {
    return;
  }

  cleanupStreamListeners(resources);
  pruneActiveStreamResources(sessionId);
};

const getActiveStreamingSessionIds = (): string[] =>
  Array.from(activeStreamResourcesBySessionId.keys());

export interface StreamMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: StreamMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  provider_input_items?: unknown[];
  provider_turn_state?: ProviderTurnState;
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
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  completionReason?: StreamCompletionReason;
}

export interface LiveStreamContextSnapshot {
  version: number;
  visibleContent: string;
  visibleContentLength: number;
  toolTraces: ToolTrace[];
  hiddenContext?: string;
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
}

export type StreamCompletionReason = ChatCompletionReason;

export type StreamTimelinePhase =
  | 'send_requested'
  | 'messages_ready'
  | 'compaction_done'
  | 'provider_stream_start_requested'
  | 'backend_task_started'
  | 'provider_request_sent'
  | 'auth_ready'
  | 'auth_refreshed'
  | 'first_provider_event'
  | 'first_token'
  | 'done'
  | 'error';

export interface StreamTimelineEvent {
  request_id: string;
  provider_id: string;
  provider_type: string;
  phase: StreamTimelinePhase | string;
  elapsed_ms: number;
}

type ProviderRuntimeErrorKind =
  | 'reasoning_replay_required'
  | 'unsupported_reasoning'
  | 'rate_limited'
  | 'provider_overloaded'
  | 'network'
  | 'stream_idle_timeout'
  | 'context_overflow'
  | 'auth'
  | 'invalid_tool_protocol'
  | 'unknown';

class ProviderRuntimeError extends Error {
  readonly kind: ProviderRuntimeErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly providerError = true;
  readonly providerMessage?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly providerRawBodyExcerpt?: string;

  constructor(
    message: string,
    options: {
      kind?: ProviderRuntimeErrorKind;
      status?: number;
      retryAfterMs?: number;
      retryable?: boolean;
      providerMessage?: string;
      providerCode?: string;
      providerType?: string;
      providerRawBodyExcerpt?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'ProviderRuntimeError';
    this.kind = options.kind ?? 'unknown';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.providerMessage = options.providerMessage;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.providerRawBodyExcerpt = options.providerRawBodyExcerpt;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

interface ChatCompletionProviderMessageItem {
  type: typeof CHAT_COMPLETION_PROVIDER_ITEM_TYPE;
  role: 'assistant' | 'tool';
  content: StreamMessageContent;
  visible_content?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

export interface ToolResultResolution {
  kind: 'result';
  result: string;
}

export interface ToolInterruptResolution {
  kind: 'interrupt';
  result: string;
  visibleContent: string;
  hiddenContext?: string;
}

export type ToolCallResolution = ToolResultResolution | ToolInterruptResolution;

export type StreamingFollowUpCompactionReason = 'tool_results';

export interface StreamingFollowUpCompactionRequest {
  reason: StreamingFollowUpCompactionReason;
  messages: StreamMessage[];
  turnCount: number;
  toolResultCount: number;
}

export interface StreamingFollowUpCompactionResult {
  messages: StreamMessage[];
  compacted?: boolean;
}

export interface StreamingChatOptions {
  sessionId?: string;
  conversationId?: string;
  mode?: AppMode;
  internalAgentProfile?: InternalAgentProfile | null;
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
  onTimeline?: (event: StreamTimelineEvent) => void;
  onToolTracesUpdate?: (toolTraces: ToolTrace[]) => void;
  onLiveContextUpdate?: (snapshot: LiveStreamContextSnapshot) => void;
  signal?: AbortSignal;
  // Tool calling options
  enableWebSearch?: boolean;
  enableWebFetch?: boolean;
  webSearchOptions?: WebSearchOptions;
  mcpTools?: MCPTool[];
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ) =>
    | Promise<ToolCallResolution | string | void>
    | ToolCallResolution
    | string
    | void;
  onToolResult?: (toolName: string, result: string) => void;
  onBeforeFollowUpRequest?: (
    request: StreamingFollowUpCompactionRequest,
  ) =>
    | Promise<StreamingFollowUpCompactionResult | StreamMessage[] | void>
    | StreamingFollowUpCompactionResult
    | StreamMessage[]
    | void;
  fileToolContext?: Array<{
    title: string;
    source: string;
    path?: string;
    snippet?: string;
    content?: string;
  }>;
  allowedToolIds?: string[];
  copilotSendTimeoutMs?: number | null;
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
  maxTurns?: number | null;
}

const emptyStreamCompletionResult = (visibleContent = ''): StreamCompletionResult => ({
  visibleContent,
  toolTraces: [],
});

const cloneStreamMessage = (message: StreamMessage): StreamMessage =>
  JSON.parse(JSON.stringify(message)) as StreamMessage;

const maybeCompactFollowUpMessages = async (
  options: StreamingChatOptions,
  params: {
    reason: StreamingFollowUpCompactionReason;
    messages: StreamMessage[];
    turnCount: number;
    toolResultCount: number;
  },
): Promise<StreamMessage[]> => {
  if (!options.onBeforeFollowUpRequest) {
    return params.messages;
  }
  const result = await options.onBeforeFollowUpRequest({
    reason: params.reason,
    messages: params.messages.map(cloneStreamMessage),
    turnCount: params.turnCount,
    toolResultCount: params.toolResultCount,
  });
  if (!result) {
    return params.messages;
  }
  if (Array.isArray(result)) {
    return result.map(cloneStreamMessage);
  }
  if (Array.isArray(result.messages)) {
    return result.messages.map(cloneStreamMessage);
  }
  return params.messages;
};

const isReasoningUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('reasoning_effort') ||
    normalized.includes('reasoning.effort') ||
    normalized.includes('unsupported value for reasoning') ||
    normalized.includes('unsupported parameter: reasoning') ||
    normalized.includes('unknown parameter: reasoning') ||
    normalized.includes('unknown parameter: reasoning_effort') ||
    normalized.includes('unsupported parameter: thinking') ||
    normalized.includes('unknown parameter: thinking') ||
    normalized.includes('does not support thinking') ||
    normalized.includes('does not support reasoning')
  );
};

const isReasoningReplayRequiredError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('reasoning_content') &&
    (normalized.includes('must be passed back') ||
      normalized.includes('must be passed') ||
      normalized.includes('thinking mode'))
  );
};

const isContextOverflowError = (message: string, status?: number): boolean => {
  return isContextOverflowMessage(message, status);
};

const disableReasoningForSession = (providerId: string, modelId: string) => {
  try {
    useProviderStore.getState().markReasoningUnsupportedForModel(providerId, modelId);
  } catch {
    // Ignore runtime fallback bookkeeping outside app contexts.
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const deepCloneJsonValue = <T,>(value: T): T => {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
};

const stripThinkingBlocksForModel = (content: string): string =>
  content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();

const resolveChatCompletionProviderProfile = (params: {
  providerType: string;
  providerId?: string;
  baseUrl?: string;
  modelId: string;
  forceReasoningContentReplay?: boolean;
}): ChatCompletionProviderProtocolProfile =>
  resolveChatCompletionProviderProtocolProfile(params);

const isChatCompletionProviderMessageItem = (
  item: unknown
): item is ChatCompletionProviderMessageItem => {
  if (!isRecord(item) || item.type !== CHAT_COMPLETION_PROVIDER_ITEM_TYPE) {
    return false;
  }

  return item.role === 'assistant' || item.role === 'tool';
};

const getChatCompletionProviderItems = (
  items?: unknown[] | null
): ChatCompletionProviderMessageItem[] => {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter(isChatCompletionProviderMessageItem);
};

const normalizeToolCallIdForProvider = (
  id: string,
  policy: ChatCompletionProviderProtocolProfile['toolCallIdPolicy'] = 'none'
): string => {
  if (policy === 'claude') {
    const normalized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return normalized || 'tool_call';
  }

  if (policy === 'mistral') {
    return id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 9).padEnd(9, '0');
  }

  return id;
};

const cloneToolCalls = (
  toolCalls?: ToolCall[] | null,
  toolCallIdPolicy: ChatCompletionProviderProtocolProfile['toolCallIdPolicy'] = 'none'
): ToolCall[] | undefined => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((toolCall) => ({
    id: normalizeToolCallIdForProvider(toolCall.id, toolCallIdPolicy),
    type: 'function' as const,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  }));
};

const normalizeMessageContentForChatCompletions = (
  role: StreamMessage['role'],
  content: StreamMessageContent
): StreamMessageContent => {
  if (role !== 'assistant' || typeof content !== 'string') {
    return content;
  }

  return stripThinkingBlocksForModel(content);
};

const providerItemHasToolHistory = (item: ChatCompletionProviderMessageItem): boolean =>
  item.role === 'tool' || (Array.isArray(item.tool_calls) && item.tool_calls.length > 0);

const streamMessageHasToolHistory = (message: StreamMessage): boolean => {
  if (
    message.role === 'tool' ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  ) {
    return true;
  }

  return getChatCompletionProviderItems(message.provider_input_items).some(
    providerItemHasToolHistory
  );
};

const shouldReplayProviderReasoningContent = (
  profile: ChatCompletionProviderProtocolProfile,
  hasToolHistory: boolean
): boolean =>
  profile.reasoningReplay === 'reasoning_content_all' ||
  (profile.reasoningReplay === 'reasoning_content_tool_chain' && hasToolHistory);

const applyProviderReasoningReplayToMessage = (
  message: Record<string, unknown>,
  item: ChatCompletionProviderMessageItem,
  profile: ChatCompletionProviderProtocolProfile,
  hasToolHistory: boolean
) => {
  const reasoningContent = item.reasoning_content?.trim();
  if (shouldReplayProviderReasoningContent(profile, hasToolHistory) && reasoningContent) {
    message.reasoning_content = item.reasoning_content;
    return;
  }

  if (profile.reasoningReplay !== 'reasoning_details') {
    return;
  }

  if (Array.isArray(item.reasoning_details) && item.reasoning_details.length > 0) {
    message.reasoning_details = deepCloneJsonValue(item.reasoning_details);
  } else if (reasoningContent) {
    message.reasoning = item.reasoning_content;
  }
};

const serializeProviderItemForChatCompletions = (
  item: ChatCompletionProviderMessageItem,
  profile: ChatCompletionProviderProtocolProfile,
  hasToolHistory: boolean
): Record<string, unknown> | null => {
  if (item.role === 'tool') {
    if (!item.tool_call_id) {
      return null;
    }

    const message: Record<string, unknown> = {
      role: 'tool',
      content: item.content,
      tool_call_id: normalizeToolCallIdForProvider(
        item.tool_call_id,
        profile.toolCallIdPolicy
      ),
    };
    if (profile.toolMessageName && item.tool_name?.trim()) {
      message.name = item.tool_name;
    }
    return message;
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: normalizeMessageContentForChatCompletions('assistant', item.content),
  };
  const toolCalls = cloneToolCalls(item.tool_calls, profile.toolCallIdPolicy);
  if (toolCalls) {
    message.tool_calls = toolCalls;
  }
  applyProviderReasoningReplayToMessage(message, item, profile, hasToolHistory);
  return message;
};

const getChatCompletionMessageToolCallIds = (message: Record<string, unknown>): string[] => {
  if (!Array.isArray(message.tool_calls)) {
    return [];
  }

  return message.tool_calls.flatMap((toolCall) => {
    if (!isRecord(toolCall) || typeof toolCall.id !== 'string' || !toolCall.id.trim()) {
      return [];
    }
    return [toolCall.id];
  });
};

const chatCompletionMessageContentToText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) => {
        if (!isRecord(part)) return [];
        const text = part.text;
        return typeof text === 'string' ? [text] : [];
      })
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? '');
  }
};

const buildHistoricalToolResultMessage = (
  message: Record<string, unknown>
): Record<string, unknown> => {
  const toolName =
    typeof message.name === 'string' && message.name.trim()
      ? message.name.trim()
      : typeof message.tool_call_id === 'string' && message.tool_call_id.trim()
        ? message.tool_call_id.trim()
        : 'tool';
  const content = truncateMiddle(
    chatCompletionMessageContentToText(message.content).trim(),
    HISTORICAL_TOOL_RESULT_MAX_CHARS
  );
  return {
    role: 'assistant',
    content: [
      `Historical tool result preserved as context. Tool: ${toolName}.`,
      content,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
};

const finalizeDanglingToolCallsForChatCompletions = (
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> => {
  const normalized: Array<Record<string, unknown>> = [];
  const pendingToolCallIds: string[] = [];
  const deferredHistoricalToolResults: Array<Record<string, unknown>> = [];

  const flushPendingToolCalls = () => {
    while (pendingToolCallIds.length > 0) {
      const toolCallId = pendingToolCallIds.shift();
      if (!toolCallId) continue;
      normalized.push({
        role: 'tool',
        content: TOOL_EXECUTION_ABORTED_RESULT,
        tool_call_id: toolCallId,
      });
    }
  };

  const flushDeferredHistoricalToolResults = () => {
    while (deferredHistoricalToolResults.length > 0) {
      const historicalMessage = deferredHistoricalToolResults.shift();
      if (!historicalMessage) continue;
      normalized.push(historicalMessage);
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId =
        typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      const matchIndex = toolCallId
        ? pendingToolCallIds.indexOf(toolCallId)
        : -1;
      if (matchIndex >= 0) {
        normalized.push(message);
        pendingToolCallIds.splice(matchIndex, 1);
        if (pendingToolCallIds.length === 0) {
          flushDeferredHistoricalToolResults();
        }
        continue;
      }

      const historicalMessage = buildHistoricalToolResultMessage(message);
      if (pendingToolCallIds.length > 0) {
        deferredHistoricalToolResults.push(historicalMessage);
      } else {
        normalized.push(historicalMessage);
      }
      continue;
    }

    flushPendingToolCalls();
    flushDeferredHistoricalToolResults();
    normalized.push(message);

    if (message.role === 'assistant') {
      pendingToolCallIds.push(...getChatCompletionMessageToolCallIds(message));
    }
  }

  flushPendingToolCalls();
  flushDeferredHistoricalToolResults();
  return normalized;
};

const insertAssistantAfterToolBeforeUserForChatCompletions = (
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> => {
  const normalized: Array<Record<string, unknown>> = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    normalized.push(message);

    const nextMessage = messages[index + 1];
    if (message.role === 'tool' && nextMessage?.role === 'user') {
      normalized.push({
        role: 'assistant',
        content: 'Done.',
      });
    }
  }

  return normalized;
};

const normalizeChatCompletionMessageSequence = (
  messages: Array<Record<string, unknown>>,
  profile: ChatCompletionProviderProtocolProfile
): Array<Record<string, unknown>> => {
  const withToolResults = finalizeDanglingToolCallsForChatCompletions(messages);
  return profile.insertAssistantAfterToolBeforeUser
    ? insertAssistantAfterToolBeforeUserForChatCompletions(withToolResults)
    : withToolResults;
};

const buildChatCompletionMessages = (
  messages: StreamMessage[],
  profile: ChatCompletionProviderProtocolProfile
): Array<Record<string, unknown>> => {
  const hasToolHistory = messages.some(streamMessageHasToolHistory);
  const serializedMessages = messages.flatMap((message) => {
    const providerItems = getChatCompletionProviderItems(message.provider_input_items);
    if (providerItems.length > 0) {
      return providerItems
        .map((item) =>
          serializeProviderItemForChatCompletions(
            item,
            profile,
            hasToolHistory
          )
        )
        .filter((item): item is Record<string, unknown> => Boolean(item));
    }

    const serialized: Record<string, unknown> = {
      role: message.role,
      content: normalizeMessageContentForChatCompletions(message.role, message.content),
    };
    const toolCalls = cloneToolCalls(message.tool_calls, profile.toolCallIdPolicy);
    if (toolCalls) {
      serialized.tool_calls = toolCalls;
    }
    if (message.tool_call_id) {
      serialized.tool_call_id = normalizeToolCallIdForProvider(
        message.tool_call_id,
        profile.toolCallIdPolicy
      );
    }
    return [serialized];
  });
  return normalizeChatCompletionMessageSequence(serializedMessages, profile);
};

export const estimateChatCompletionSerializedPayloadTokens = (params: {
  messages: StreamMessage[];
  providerType?: string;
  providerId?: string;
  baseUrl?: string;
  modelId: string;
}): number => {
  const profile = resolveChatCompletionProviderProfile({
    providerType: params.providerType ?? '',
    providerId: params.providerId,
    baseUrl: params.baseUrl,
    modelId: params.modelId,
  });
  const serializedMessages = buildChatCompletionMessages(params.messages, profile);
  return Math.max(1, Math.ceil(JSON.stringify(serializedMessages).length / 4));
};

const buildAssistantChatCompletionProviderItem = (params: {
  visibleContent: string;
  apiContent: string;
  reasoningContent: string;
  reasoningDetails: unknown[];
  toolCalls: ToolCall[];
}): ChatCompletionProviderMessageItem | null => {
  if (
    !params.visibleContent.trim() &&
    !params.apiContent.trim() &&
    !params.reasoningContent.trim() &&
    params.reasoningDetails.length === 0 &&
    params.toolCalls.length === 0
  ) {
    return null;
  }

  return {
    type: CHAT_COMPLETION_PROVIDER_ITEM_TYPE,
    role: 'assistant',
    content: params.apiContent,
    visible_content: params.visibleContent,
    ...(params.reasoningContent.trim()
      ? { reasoning_content: params.reasoningContent }
      : {}),
    ...(params.reasoningDetails.length > 0
      ? { reasoning_details: deepCloneJsonValue(params.reasoningDetails) }
      : {}),
    ...(params.toolCalls.length > 0 ? { tool_calls: cloneToolCalls(params.toolCalls) ?? [] } : {}),
  };
};

const buildToolChatCompletionProviderItem = (
  toolCallId: string,
  content: string,
  toolName?: string
): ChatCompletionProviderMessageItem => ({
  type: CHAT_COMPLETION_PROVIDER_ITEM_TYPE,
  role: 'tool',
  content,
  tool_call_id: toolCallId,
  ...(toolName?.trim() ? { tool_name: toolName } : {}),
});

const hasReplayableReasoningContent = (messages: StreamMessage[]): boolean =>
  messages.some((message) =>
    getChatCompletionProviderItems(message.provider_input_items).some(
      (item) => item.role === 'assistant' && Boolean(item.reasoning_content?.trim())
    )
  );

const appendReasoningDetails = (target: unknown[], value: unknown) => {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    target.push(...deepCloneJsonValue(value));
    return;
  }

  target.push(deepCloneJsonValue(value));
};

const getHeaderValue = (headers: Headers | undefined, name: string): string | null => {
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }

  return headers.get(name);
};

const parseRetryAfterMs = (headers: Headers | undefined): number | undefined => {
  const retryAfterMs = getHeaderValue(headers, 'retry-after-ms');
  if (retryAfterMs) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const retryAfter = getHeaderValue(headers, 'retry-after');
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
};

const classifyProviderError = (
  message: string,
  status?: number,
  retryAfterMs?: number,
  details?: {
    providerMessage?: string;
    providerCode?: string;
    providerType?: string;
    providerRawBodyExcerpt?: string;
  }
): ProviderRuntimeError => {
  const normalized = message.toLowerCase();
  let kind: ProviderRuntimeErrorKind = 'unknown';
  if (isReasoningReplayRequiredError(message)) {
    kind = 'reasoning_replay_required';
  } else if (isReasoningUnsupportedError(message)) {
    kind = 'unsupported_reasoning';
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (isContextOverflowError(message, status)) {
    kind = 'context_overflow';
  } else if (status === 429) {
    kind = 'rate_limited';
  } else if (status === 408 || status === 502 || status === 503 || status === 504) {
    kind = 'provider_overloaded';
  } else if (
    normalized.includes('tool_call') ||
    normalized.includes('tool call') ||
    normalized.includes('tool_calls')
  ) {
    kind = 'invalid_tool_protocol';
  }

  const retryable =
    kind !== 'context_overflow' &&
    (status === 408 ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504);

  return new ProviderRuntimeError(message, {
    kind,
    status,
    retryAfterMs,
    retryable,
    ...details,
  });
};

const extractProviderErrorMessage = async (response: Response): Promise<ProviderRuntimeError> => {
  const errorText = await response.text().catch(() => 'Unknown error');
  let errorMessage = `Request failed: ${response.status}`;
  let providerMessage: string | undefined;
  let providerCode: string | undefined;
  let providerType: string | undefined;

  try {
    const errorJson = JSON.parse(errorText) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
      code?: unknown;
      type?: unknown;
    };
    const parsedMessage = errorJson.error?.message ?? errorJson.message;
    providerMessage = typeof parsedMessage === 'string' ? parsedMessage : undefined;
    providerCode =
      typeof errorJson.error?.code === 'string'
        ? errorJson.error.code
        : typeof errorJson.code === 'string'
          ? errorJson.code
          : undefined;
    providerType =
      typeof errorJson.error?.type === 'string'
        ? errorJson.error.type
        : typeof errorJson.type === 'string'
          ? errorJson.type
          : undefined;
    const contextParts = [
      providerMessage,
      providerCode,
      providerType,
    ].filter((part): part is string => Boolean(part));
    errorMessage = contextParts.length > 0 ? contextParts.join(' ') : errorMessage;
  } catch {
    if (errorText) {
      errorMessage = errorText;
      providerMessage = errorText;
    }
  }

  return classifyProviderError(
    errorMessage,
    response.status,
    parseRetryAfterMs(response.headers),
    {
      providerMessage,
      providerCode,
      providerType,
      providerRawBodyExcerpt: errorText.slice(0, 1200),
    }
  );
};

const getRetryDelayMs = (attempt: number, retryAfterMs?: number): number => {
  const exponential = GENERIC_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const delay = retryAfterMs ?? exponential;
  return Math.min(GENERIC_RETRY_MAX_DELAY_MS, Math.max(0, delay));
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abortHandler = () => {
      globalThis.clearTimeout(timeoutId);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', abortHandler);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<Response> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  try {
    if (outerSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    abortHandler = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', abortHandler, { once: true });
    timeoutId = globalThis.setTimeout(() => {
      controller.abort(new Error('Provider request timed out'));
    }, timeoutMs);

    return await tauriFetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (outerSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (controller.signal.aborted) {
      throw new ProviderRuntimeError('Provider request timed out', {
        kind: 'network',
        retryable: true,
        cause: error,
      });
    }
    throw new ProviderRuntimeError(error instanceof Error ? error.message : String(error), {
      kind: 'network',
      retryable: true,
      cause: error,
    });
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
    if (abortHandler) {
      outerSignal?.removeEventListener('abort', abortHandler);
    }
  }
};

const readStreamChunkWithIdleTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> => {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    const idleTimeout = new Promise<never>((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        reject(
          new ProviderRuntimeError('Provider stream stalled before sending more data', {
            kind: 'stream_idle_timeout',
            retryable: true,
          })
        );
      }, timeoutMs);
    });
    return await Promise.race([reader.read(), idleTimeout]);
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
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
    toolName === 'edit' ||
    toolName === 'delete'
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

  if (toolName === 'question') {
    const questions = Array.isArray(args.questions) ? args.questions.length : 0;
    return questions > 0 ? `${questions} question${questions > 1 ? 's' : ''}` : undefined;
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

const createStreamAccumulator = (
  options: Pick<StreamingChatOptions, 'onToken' | 'onToolTracesUpdate' | 'onLiveContextUpdate'>
) => {
  let visibleContent = '';
  const toolTraces = new Map<string, ToolTrace>();
  const toolTraceOrder: string[] = [];
  const hiddenContextBlocks: string[] = [];
  const liveOnlyHiddenContextBlocks: string[] = [];
  let providerInputItems: unknown[] | undefined;
  let providerTurnState: ProviderTurnState | undefined;
  let liveContextVersion = 0;

  const snapshotToolTraces = (): ToolTrace[] =>
    // Preserve first-seen insertion order; the UI treats the serialized tool_traces
    // array as the canonical display order for grouped tool rendering.
    toolTraceOrder
      .map((toolCallId) => toolTraces.get(toolCallId))
      .filter((trace): trace is ToolTrace => Boolean(trace))
      .map((trace) => ({ ...trace }));

  const buildHiddenContext = (includeLiveOnly: boolean): string | undefined => {
    const blocks = includeLiveOnly
      ? [...hiddenContextBlocks, ...liveOnlyHiddenContextBlocks]
      : hiddenContextBlocks;
    const hiddenContext = blocks.join('\n\n').trim();
    return hiddenContext || undefined;
  };

  const snapshotLiveContext = (): LiveStreamContextSnapshot => ({
    version: liveContextVersion,
    visibleContent,
    visibleContentLength: visibleContent.length,
    toolTraces: snapshotToolTraces(),
    hiddenContext: buildHiddenContext(true),
    providerInputItems: cloneProviderInputItems(providerInputItems),
    providerTurnState,
  });

  const publishLiveContext = () => {
    if (!options.onLiveContextUpdate) return;
    liveContextVersion += 1;
    options.onLiveContextUpdate(snapshotLiveContext());
  };

  const publishToolTraces = () => {
    options.onToolTracesUpdate?.(snapshotToolTraces());
    publishLiveContext();
  };

  const isProtectedToolTraceStatus = (status: ToolTrace['status']): boolean =>
    status === 'pending_approval' || status === 'denied';

  const mergeToolTraceStatus = (
    existingTrace: ToolTrace | undefined,
    incomingStatus: ToolTrace['status']
  ): ToolTrace['status'] => {
    if (!existingTrace) return incomingStatus;
    if (isProtectedToolTraceStatus(existingTrace.status)) return existingTrace.status;
    if (existingTrace.status === 'done' && incomingStatus === 'running') return 'done';
    return incomingStatus;
  };

  const upsertToolTrace = (trace: ToolTrace) => {
    const existingTrace = toolTraces.get(trace.tool_call_id);
    const status = mergeToolTraceStatus(existingTrace, trace.status);
    const completedAtMs =
      status === 'done'
        ? trace.completed_at_ms ?? existingTrace?.completed_at_ms ?? Date.now()
        : trace.completed_at_ms ?? existingTrace?.completed_at_ms;
    const nextTrace: ToolTrace = {
      tool_call_id: trace.tool_call_id,
      tool_name: trace.tool_name || existingTrace?.tool_name || trace.tool_call_id,
      detail: trace.detail ?? existingTrace?.detail,
      status,
      visible_offset:
        existingTrace?.visible_offset ?? trace.visible_offset ?? visibleContent.length,
      execution_mode: trace.execution_mode ?? existingTrace?.execution_mode,
      batch_id: trace.batch_id ?? existingTrace?.batch_id,
      order: trace.order ?? existingTrace?.order,
      started_at_ms: existingTrace?.started_at_ms ?? trace.started_at_ms,
      completed_at_ms: completedAtMs,
    };
    if (!toolTraces.has(trace.tool_call_id)) {
      toolTraceOrder.push(trace.tool_call_id);
    }
    toolTraces.set(trace.tool_call_id, nextTrace);
    publishToolTraces();
  };

  const markRunningToolTracesDone = () => {
    let changed = false;
    for (const toolCallId of toolTraceOrder) {
      const trace = toolTraces.get(toolCallId);
      if (!trace || trace.status !== 'running') continue;
      toolTraces.set(toolCallId, {
        ...trace,
        status: 'done',
        completed_at_ms: trace.completed_at_ms ?? Date.now(),
      });
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
    publishLiveContext();
  };

  return {
    appendProviderDelta(chunk: string) {
      appendVisibleChunk(chunk, false);
    },
    flushProviderDelta() {
      // Provider deltas are appended directly.
    },
    appendSystemChunk(chunk: string, markToolsDone = false) {
      appendVisibleChunk(chunk, markToolsDone);
    },
    markRunningToolTracesDone,
    upsertToolTrace,
    upsertToolTraceFromProvider(trace: ToolTrace) {
      upsertToolTrace(trace);
    },
    beginToolTrace(
      toolCallId: string,
      toolName: string,
      detail?: string,
      metadata?: Pick<ToolTrace, 'execution_mode' | 'batch_id' | 'order'>
    ) {
      const existingTrace = toolTraces.get(toolCallId);
      upsertToolTrace({
        tool_call_id: toolCallId,
        tool_name: toolName,
        detail: detail ?? existingTrace?.detail,
        status: 'running',
        visible_offset: existingTrace?.visible_offset ?? visibleContent.length,
        execution_mode: metadata?.execution_mode ?? existingTrace?.execution_mode,
        batch_id: metadata?.batch_id ?? existingTrace?.batch_id,
        order: metadata?.order ?? existingTrace?.order,
        started_at_ms: existingTrace?.started_at_ms ?? Date.now(),
      });
    },
    completeToolTrace(toolCallId: string) {
      const existingTrace = toolTraces.get(toolCallId);
      if (!existingTrace || isProtectedToolTraceStatus(existingTrace.status)) return;
      upsertToolTrace({
        ...existingTrace,
        status: 'done',
        completed_at_ms: Date.now(),
      });
    },
    upsertRunningToolTrace(toolCallId: string, toolName: string, detail?: string) {
      const existingTrace = toolTraces.get(toolCallId);
      upsertToolTrace({
        tool_call_id: toolCallId,
        tool_name: toolName,
        detail: detail ?? existingTrace?.detail,
        status: 'running',
        visible_offset: existingTrace?.visible_offset ?? visibleContent.length,
        execution_mode: existingTrace?.execution_mode,
        batch_id: existingTrace?.batch_id,
        order: existingTrace?.order,
        started_at_ms: existingTrace?.started_at_ms ?? Date.now(),
      });
    },
    addHiddenToolContext(toolCallId: string, toolName: string, detail: string | undefined, result: string) {
      const block = buildToolContextBlock(toolCallId, toolName, detail, result);
      if (block) {
        hiddenContextBlocks.push(block);
        publishLiveContext();
      }
    },
    addLiveOnlyHiddenToolContext(toolCallId: string, toolName: string, detail: string | undefined, result: string) {
      const block = buildToolContextBlock(toolCallId, toolName, detail, result);
      if (block) {
        liveOnlyHiddenContextBlocks.push(block);
        publishLiveContext();
      }
    },
    addHiddenContextBlock(block: string | undefined) {
      const normalized = block?.trim();
      if (normalized) {
        hiddenContextBlocks.push(normalized);
        publishLiveContext();
      }
    },
    setProviderContext(context: {
      providerInputItems?: unknown[] | null;
      providerTurnState?: ProviderTurnState;
    }) {
      providerInputItems = cloneProviderInputItems(context.providerInputItems);
      providerTurnState = context.providerTurnState;
      publishLiveContext();
    },
    replaceVisibleContent(content: string) {
      visibleContent = content;
      publishLiveContext();
    },
    publishLiveContext,
    snapshotLiveContext,
    getFinalHiddenContext() {
      return buildHiddenContext(false);
    },
    buildResult(): StreamCompletionResult {
      markRunningToolTracesDone();
      return {
        visibleContent,
        toolTraces: snapshotToolTraces(),
        hiddenContext: buildHiddenContext(false),
      };
    },
  };
};

// Tool definitions for the LLM
const WEB_SEARCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('web_search'));
const WEB_FETCH_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('web_fetch'));
const QUESTION_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('question'));
const SKILL_ACTIVATE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('skill_activate'));
const SKILL_READ_RESOURCE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('skill_read_resource'));
const SKILL_RUN_SCRIPT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('skill_run_script'));
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
const DELETE_WORKSPACE_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('delete'));
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
const LIST_NEEDS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('need_list'));
const GET_NEED_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('need_get'));
const UPDATE_NEED_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('need_update'));
const DELETE_NEED_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('need_delete'));
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
const GET_TASK_TODOS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_todo_get'));
const UPDATE_TASK_TODOS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_todo_update'));
const LIST_TASK_ARTIFACTS_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_artifact_list'));
const GET_TASK_ARTIFACT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_artifact_get'));
const PUT_TASK_ARTIFACT_TOOL = toFunctionToolShape(requireMacroToolRegistryEntry('task_artifact_put'));
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

const emitStreamTimeline = (
  options: Pick<
    StreamingChatOptions,
    'providerId' | 'providerType' | 'onTimeline'
  >,
  event: StreamTimelineEvent
) => {
  if (options.onTimeline) {
    try {
      options.onTimeline(event);
    } catch (error) {
      devLogger.warn('Provider stream timeline callback failed', {
        error,
        providerId: options.providerId,
        providerType: options.providerType,
        requestId: event.request_id,
        phase: event.phase,
      });
    }
    return;
  }

  devLogger.info('Provider stream timeline', {
    providerId: options.providerId,
    providerType: options.providerType,
    requestId: event.request_id,
    phase: event.phase,
    elapsedMs: event.elapsed_ms,
  });
};

interface StreamingTurnResult {
  content: string;
  toolCalls: ToolCall[];
  providerInputItems?: unknown[];
  providerTurnState?: ProviderTurnState;
  reasoningSummary?: string;
  toolTraces?: ToolTrace[];
  hiddenContext?: string;
}

const getValidToolCalls = (toolCalls: ToolCall[]): ToolCall[] =>
  toolCalls.filter((toolCall) => toolCall.id && toolCall.function.name);

const normalizeToolArgumentsForLoopKey = (argumentsJson: string): string => {
  try {
    return JSON.stringify(JSON.parse(argumentsJson));
  } catch {
    return argumentsJson.trim();
  }
};

const getToolCallLoopKey = (toolCall: ToolCall): string =>
  `${toolCall.function.name}\u0000${normalizeToolArgumentsForLoopKey(toolCall.function.arguments)}`;

const getAssistantToolCallLoopKeys = (messages: StreamMessage[]): string[] =>
  messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? getValidToolCalls(message.tool_calls).map(getToolCallLoopKey)
      : []
  );

const isRepeatedToolCallLoop = (
  messages: StreamMessage[],
  toolCall: ToolCall
): boolean => {
  const recentKeys = getAssistantToolCallLoopKeys(messages).slice(-TOOL_DOOM_LOOP_THRESHOLD);
  if (recentKeys.length < TOOL_DOOM_LOOP_THRESHOLD) {
    return false;
  }
  const targetKey = getToolCallLoopKey(toolCall);
  return recentKeys.every((key) => key === targetKey);
};

const buildChatGptProviderTurnState = (
  responseId?: string | null,
  outputItems?: unknown[] | null
): ProviderTurnState | undefined => {
  const normalizedOutputItems = Array.isArray(outputItems) ? outputItems : [];
  const normalizedResponseId = typeof responseId === 'string' ? responseId.trim() : '';

  if (!normalizedResponseId && normalizedOutputItems.length === 0) {
    return undefined;
  }

  return {
    provider: 'chatgpt',
    ...(normalizedResponseId ? { response_id: normalizedResponseId } : {}),
    output_items: normalizedOutputItems,
  };
};

const cloneProviderInputItems = (items?: unknown[] | null): unknown[] | undefined => {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }

  return items.map((item) =>
    item && typeof item === 'object'
      ? JSON.parse(JSON.stringify(item))
      : item
  );
};

const buildFunctionCallOutputProviderInputItem = (
  toolCallId: string,
  output: string
): unknown => ({
  type: 'function_call_output',
  call_id: toolCallId,
  output,
});

const extractTextValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === 'string' ? nested : '';
  }

  return '';
};

const extractVisibleTextFromProviderInputItems = (items?: unknown[] | null): string => {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }

  return items
    .flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const typedItem = item as {
        type?: unknown;
        role?: unknown;
        text?: unknown;
        content?: unknown;
      };

      if (typedItem.type === 'output_text') {
        const text = extractTextValue(typedItem.text);
        return text ? [text] : [];
      }

      if (typedItem.type !== 'message' || typedItem.role !== 'assistant') {
        return [];
      }

      if (!Array.isArray(typedItem.content)) {
        return [];
      }

      return typedItem.content.flatMap((part) => {
        if (!part || typeof part !== 'object') {
          return [];
        }

        const typedPart = part as { type?: unknown; text?: unknown; value?: unknown };
        if (typedPart.type !== 'output_text' && typedPart.type !== 'text') {
          return [];
        }

        const text = extractTextValue(
          typedPart.text !== undefined ? typedPart.text : typedPart.value
        );
        return text ? [text] : [];
      });
    })
    .join('');
};

const buildAssistantProviderInputItemsFromTurn = (
  content: string,
  toolCalls: ToolCall[]
): unknown[] => {
  const items: unknown[] = [];
  if (content.trim()) {
    items.push({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: content,
        },
      ],
    });
  }

  for (const toolCall of toolCalls) {
    items.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  return items;
};

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

const buildNativeReasoningVisibleTurnContent = (
  content: string,
  reasoningSummary?: string | null
): string => {
  if (content.trim().startsWith('<think>')) {
    return content;
  }
  return buildChatGptVisibleTurnContent(content, reasoningSummary);
};

const getMissingChatGptVisibleTurnSuffix = (
  streamedTurnContent: string,
  turnContent: string
): string | null => {
  const trimmedTurnContent = turnContent.trim();
  if (!trimmedTurnContent) {
    return null;
  }

  const trimmedStreamedContent = streamedTurnContent.trim();
  if (!trimmedStreamedContent) {
    return turnContent;
  }

  if (turnContent === streamedTurnContent) {
    return null;
  }

  if (turnContent.startsWith(streamedTurnContent)) {
    const suffix = turnContent.slice(streamedTurnContent.length);
    return suffix.length > 0 ? suffix : null;
  }

  return null;
};

const isEmptyTerminalChatGptTurn = (content: string, toolCalls: ToolCall[]): boolean =>
  toolCalls.length === 0 && content.trim().length === 0;

const stripThinkingBlocks = (content: string): string =>
  content.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/\s+/g, ' ').trim();

const hasMeaningfulVisibleAssistantText = (content: string): boolean =>
  stripThinkingBlocks(content).length > 0;

const summarizeProviderTextPresence = (
  items?: unknown[]
): {
  hasMessageItem: boolean;
  hasOutputTextItem: boolean;
  hasTextContentPart: boolean;
} => {
  const summary = {
    hasMessageItem: false,
    hasOutputTextItem: false,
    hasTextContentPart: false,
  };

  if (!Array.isArray(items)) {
    return summary;
  }

  for (const item of items) {
    const typedItem = item as { type?: unknown; content?: unknown };
    if (typedItem?.type === 'message') {
      summary.hasMessageItem = true;
    }
    if (typedItem?.type === 'output_text') {
      summary.hasOutputTextItem = true;
    }

    if (!Array.isArray(typedItem?.content)) {
      continue;
    }

    for (const part of typedItem.content as Array<{ type?: unknown }>) {
      if (part?.type === 'output_text' || part?.type === 'text') {
        summary.hasTextContentPart = true;
      }
    }
  }

  return summary;
};

const shouldRetryArchitectPostToolResponse = (params: {
  mode?: AppMode;
  usedToolNames: Set<string>;
  visibleContent: string;
  retryCount: number;
}): boolean =>
  params.mode === 'Architect' &&
  params.usedToolNames.size > 0 &&
  params.retryCount < 1 &&
  !hasMeaningfulVisibleAssistantText(params.visibleContent);

const logArchitectToolOnlyOutcome = (params: {
  mode?: AppMode;
  usedToolNames: Set<string>;
  visibleContent: string;
  retryCount: number;
  providerItems?: unknown[];
  stage: 'retry' | 'final-empty';
}): void => {
  if (params.mode !== 'Architect' || params.usedToolNames.size === 0) {
    return;
  }

  const providerPresence = summarizeProviderTextPresence(params.providerItems);
  devLogger.info('Architect turn finished after tools without visible text', {
    mode: params.mode,
    stage: params.stage,
    toolNames: Array.from(params.usedToolNames),
    visibleTextLength: stripThinkingBlocks(params.visibleContent).length,
    retryCount: params.retryCount,
    hasMessageItem: providerPresence.hasMessageItem,
    hasOutputTextItem: providerPresence.hasOutputTextItem,
    hasTextContentPart: providerPresence.hasTextContentPart,
  });
};

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
  const normalizedMaxChars = Math.max(400, maxChars);
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

const isToolInterruptResolution = (
  value: ToolCallResolution | undefined,
): value is ToolInterruptResolution => value?.kind === 'interrupt';

const normalizeToolCallResolution = (
  value: ToolCallResolution | string | void,
): ToolCallResolution | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return {
      kind: 'result',
      result: value,
    };
  }
  return value;
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
  mcpTools?: MCPTool[];
}): unknown[] => {
  const { allowedTools, enableWebSearch, enableWebFetch, webSearchOptions, mcpTools } = params;
  const tools: unknown[] = [];

  if (allowedTools.has('list')) tools.push(LIST_TOOL);
  if (allowedTools.has('read')) tools.push(READ_WORKSPACE_TOOL);
  if (allowedTools.has('write')) tools.push(WRITE_WORKSPACE_TOOL);
  if (allowedTools.has('edit')) tools.push(EDIT_WORKSPACE_TOOL);
  if (allowedTools.has('delete')) tools.push(DELETE_WORKSPACE_TOOL);
  if (allowedTools.has('glob')) tools.push(GLOB_WORKSPACE_TOOL);
  if (allowedTools.has('grep')) tools.push(GREP_WORKSPACE_TOOL);
  if (allowedTools.has('question')) tools.push(QUESTION_TOOL);
  if (allowedTools.has('skill_activate')) tools.push(SKILL_ACTIVATE_TOOL);
  if (allowedTools.has('skill_read_resource')) tools.push(SKILL_READ_RESOURCE_TOOL);
  if (allowedTools.has('skill_run_script')) tools.push(SKILL_RUN_SCRIPT_TOOL);
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
  if (allowedTools.has('need_list')) tools.push(LIST_NEEDS_TOOL);
  if (allowedTools.has('need_get')) tools.push(GET_NEED_TOOL);
  if (allowedTools.has('need_update')) tools.push(UPDATE_NEED_TOOL);
  if (allowedTools.has('need_delete')) tools.push(DELETE_NEED_TOOL);
  if (allowedTools.has('strategy_generate')) tools.push(GENERATE_PLAN_TOOL);
  if (allowedTools.has('plan_create')) tools.push(CREATE_PLAN_TOOL);
  if (allowedTools.has('plan_list')) tools.push(LIST_PLANS_TOOL);
  if (allowedTools.has('plan_get')) tools.push(GET_PLAN_TOOL);
  if (allowedTools.has('plan_update')) tools.push(UPDATE_PLAN_TOOL);
  if (allowedTools.has('plan_delete')) tools.push(DELETE_PLAN_TOOL);
  if (allowedTools.has('plan_restore')) tools.push(RESTORE_PLAN_TOOL);
  if (allowedTools.has('plan_set_active')) tools.push(SET_ACTIVE_PLAN_TOOL);
  if (allowedTools.has('strategy_get')) tools.push(GET_STRATEGY_TOOL);
  if (allowedTools.has('task_todo_get')) tools.push(GET_TASK_TODOS_TOOL);
  if (allowedTools.has('task_todo_update')) tools.push(UPDATE_TASK_TODOS_TOOL);
  if (allowedTools.has('task_artifact_list')) tools.push(LIST_TASK_ARTIFACTS_TOOL);
  if (allowedTools.has('task_artifact_get')) tools.push(GET_TASK_ARTIFACT_TOOL);
  if (allowedTools.has('task_artifact_put')) tools.push(PUT_TASK_ARTIFACT_TOOL);
  if (allowedTools.has('strategy_update')) tools.push(UPDATE_STRATEGY_TOOL);
  if (allowedTools.has('strategy_delete')) tools.push(DELETE_STRATEGY_TOOL);
  (mcpTools ?? []).forEach((tool) => {
    if (allowedTools.has(tool.id)) {
      tools.push(toMCPFunctionToolShape(tool));
    }
  });

  return tools;
};

const NOOP_COMPAT_TOOL = {
  type: 'function',
  function: {
    name: '_noop',
    description:
      'Do not call this tool. It exists only for API compatibility and must never be invoked.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Unused.',
        },
      },
      required: [],
    },
  },
};

const chatCompletionMessagesHaveToolHistory = (
  messages: Array<Record<string, unknown>>
): boolean =>
  messages.some(
    (message) =>
      message.role === 'tool' ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  );

const applyToolsToChatCompletionsRequest = (
  requestBody: Record<string, unknown>,
  tools: unknown[],
  profile: ChatCompletionProviderProtocolProfile,
  messages: Array<Record<string, unknown>>
) => {
  delete requestBody.tools;
  delete requestBody.tool_choice;
  delete requestBody.parallel_tool_calls;

  if (tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
    requestBody.parallel_tool_calls = false;
    return;
  }

  if (
    profile.injectNoopToolWhenHistoryHasTools &&
    chatCompletionMessagesHaveToolHistory(messages)
  ) {
    requestBody.tools = [NOOP_COMPAT_TOOL];
    requestBody.tool_choice = 'auto';
    requestBody.parallel_tool_calls = false;
  }
};

export const __testables = {
  applyReasoningToChatCompletionsRequest,
  applyToolsToChatCompletionsRequest,
  buildAssistantChatCompletionProviderItem,
  buildChatCompletionMessages,
  buildChatGptProviderTurnState,
  buildChatGptVisibleTurnContent,
  buildFunctionCallOutputProviderInputItem,
  buildToolChatCompletionProviderItem,
  buildToolContextBlock,
  chatCompletionMessagesHaveToolHistory,
  classifyProviderError,
  collectAllowedTools,
  compactToolResultForChatGptModelContext,
  createStreamAccumulator,
  extractVisibleTextFromProviderInputItems,
  finalizeDanglingToolCallsForChatCompletions,
  formatToolTraceDetail,
  getActiveStreamingSessionIds,
  getMissingChatGptVisibleTurnSuffix,
  getToolCallLoopKey,
  hasMeaningfulVisibleAssistantText,
  isContextOverflowError,
  isEmptyTerminalChatGptTurn,
  isReasoningReplayRequiredError,
  isReasoningUnsupportedError,
  isRepeatedToolCallLoop,
  isToolInterruptResolution,
  normalizeChatCompletionMessageSequence,
  normalizeToolCallIdForProvider,
  normalizeToolCallResolution,
  resolveChatCompletionProviderCapabilities: resolveChatCompletionProviderProfile,
  resolveChatCompletionProviderProfile,
  shouldRetryArchitectPostToolResponse,
  shouldRetryMissingRequiredTool,
  shouldRequestProviderReasoning,
  stripThinkingBlocksForModel,
  summarizeProviderTextPresence,
};

const getFunctionToolName = (tool: unknown): string | null => {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  const functionValue = (tool as { function?: { name?: unknown } }).function;
  return typeof functionValue?.name === 'string' ? functionValue.name : null;
};

const withCopilotBuiltInToolOverrides = (tools: unknown[]): unknown[] =>
  tools.map((tool) => {
    const toolName = getFunctionToolName(tool);
    if (
      !toolName ||
      !isMacroToolCopilotBuiltInOverride(toolName) ||
      !tool ||
      typeof tool !== 'object'
    ) {
      return tool;
    }

    return {
      ...(tool as Record<string, unknown>),
      overridesBuiltInTool: true,
    };
  });

const normalizeNativeProviderTools = (
  tools: unknown[],
  providerType: string,
): unknown[] =>
  providerType.trim().toLowerCase() === 'copilot'
    ? withCopilotBuiltInToolOverrides(tools)
    : tools;

const NATIVE_STREAMING_PROVIDER_TYPES = new Set([
  'chatgpt',
  'copilot',
  'openai',
  'openrouter',
  'ollama',
  'lmstudio',
]);

const shouldUseNativeStreamingProvider = (providerType: string): boolean =>
  NATIVE_STREAMING_PROVIDER_TYPES.has(providerType.trim().toLowerCase());

const streamNativeTurnViaTauri = async (params: {
  sessionId?: string;
  providerId: string;
  providerType: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
  conversationId?: string | null;
  messages: StreamMessage[];
  tools: unknown[];
  allowedToolIds?: string[];
  copilotSendTimeoutMs?: number | null;
  workspacePath?: string | null;
  defaultWorkspacePath?: string | null;
  projectMounts?: ProjectMount[];
  virtualRootEnabled?: boolean;
  focusedProjectId?: string | null;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onTimeline?: StreamingChatOptions['onTimeline'];
  onToolTrace?: (toolTrace: ToolTrace) => void;
  onToolCall?: StreamingChatOptions['onToolCall'];
  onToolResult?: StreamingChatOptions['onToolResult'];
  onLiveToolResult?: (toolResult: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
    result: string;
    hiddenContext?: string;
  }) => void;
}): Promise<StreamingTurnResult> => {
  if (!tauriIpc.isTauriAvailable()) {
    throw new Error(`${params.providerType} provider requires the desktop backend.`);
  }

  const sessionId = getStreamSessionId(params.sessionId);
  const resources = getOrCreateActiveStreamResources(sessionId);
  const requestId = createStreamingRequestId();
  resources.tauriRequestId = requestId;

  let fullContent = '';

  return new Promise<StreamingTurnResult>((resolve, reject) => {
    let settled = false;
    let questionToolRequestCount = 0;
    let nativeToolRequestOrder = 0;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTauriListeners(sessionId);
      const activeResources = activeStreamResourcesBySessionId.get(sessionId);
      if (activeResources && activeResources.tauriRequestId === requestId) {
        activeResources.tauriRequestId = null;
        pruneActiveStreamResources(sessionId);
      }
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
          listen<tauriIpc.AiStreamTimelineEvent>('ai:timeline', (event) => {
            if (event.payload.request_id !== requestId) return;
            params.onTimeline?.({
              request_id: event.payload.request_id,
              provider_id: event.payload.provider_id,
              provider_type: event.payload.provider_type,
              phase: event.payload.phase,
              elapsed_ms: event.payload.elapsed_ms,
            });
          }),
          listen<tauriIpc.AiStreamChunkEvent>('ai:stream', (event) => {
            if (event.payload.request_id !== requestId) return;
            fullContent += event.payload.delta;
            params.onDelta(event.payload.delta);
          }),
          listen<tauriIpc.AiStreamToolTraceEvent>('ai:tool-trace', (event) => {
            if (event.payload.request_id !== requestId) return;
            params.onToolTrace?.(event.payload.tool_trace);
          }),
          listen<tauriIpc.AiToolRequestEvent>('ai:tool-request', (event) => {
            if (event.payload.request_id !== requestId) return;

            void (async () => {
              const toolName = event.payload.tool_name;
              const toolCallId = event.payload.tool_call_id;
              const args =
                event.payload.args && typeof event.payload.args === 'object'
                  ? event.payload.args
                  : {};
              const detail = formatToolTraceDetail(toolName, args);
              const order = nativeToolRequestOrder;
              nativeToolRequestOrder += 1;

              params.onToolTrace?.({
                tool_call_id: toolCallId,
                tool_name: toolName,
                detail,
                status: 'running',
                execution_mode: 'parallel',
                batch_id: requestId,
                order,
                started_at_ms: Date.now(),
              });

              try {
                let toolResult = '';
                let hiddenContext: string | undefined;
                let visibleContent: string | undefined;
                let interrupt = false;

                if (toolName === 'question') {
                  questionToolRequestCount += 1;
                }

                if (toolName === 'question' && questionToolRequestCount > 1) {
                  toolResult =
                    'Error executing tool question: only one question tool call is allowed per assistant turn.';
                } else if (!params.onToolCall) {
                  toolResult = `Tool ${toolName} is unavailable in this provider context.`;
                } else {
                  const resolution = normalizeToolCallResolution(
                    await params.onToolCall(toolName, args, toolCallId)
                  );

                  if (isToolInterruptResolution(resolution)) {
                    toolResult = resolution.result;
                    hiddenContext = resolution.hiddenContext;
                    visibleContent = resolution.visibleContent;
                    interrupt = true;
                  } else if (resolution?.kind === 'result') {
                    toolResult = resolution.result;
                  }
                }

                await tauriIpc.aiSubmitToolResult({
                  requestId,
                  toolCallId,
                  result: toolResult,
                  hiddenContext,
                  visibleContent,
                  interrupt,
                });
                params.onLiveToolResult?.({
                  toolName,
                  args,
                  toolCallId,
                  result: toolResult,
                  hiddenContext,
                });
                params.onToolResult?.(toolName, toolResult);
              } catch (error) {
                const toolResult = `Error executing tool ${toolName}: ${
                  error instanceof Error ? error.message : String(error)
                }`;
                await tauriIpc.aiSubmitToolResult({
                  requestId,
                  toolCallId,
                  result: toolResult,
                }).catch(() => undefined);
                params.onLiveToolResult?.({
                  toolName,
                  args,
                  toolCallId,
                  result: toolResult,
                });
                params.onToolResult?.(toolName, toolResult);
              } finally {
                params.onToolTrace?.({
                  tool_call_id: toolCallId,
                  tool_name: toolName,
                  detail,
                  status: 'done',
                  execution_mode: 'parallel',
                  batch_id: requestId,
                  order,
                  completed_at_ms: Date.now(),
                });
              }
            })();
          }),
          listen<tauriIpc.AiStreamDoneEvent>('ai:done', (event) => {
            if (event.payload.request_id !== requestId) return;
            if (params.signal) {
              params.signal.removeEventListener('abort', signalHandler);
            }
            const providerInputItems = event.payload.provider_input_items ?? undefined;
            const providerTurnState =
              event.payload.provider_turn_state ??
              (params.providerType === 'chatgpt'
                ? buildChatGptProviderTurnState(
                  event.payload.response_id,
                  event.payload.output_items,
                )
                : undefined);
            const derivedOutputText =
              extractVisibleTextFromProviderInputItems(providerInputItems) ||
              extractVisibleTextFromProviderInputItems(event.payload.output_items ?? undefined);
            finish(() =>
              resolve({
                content: event.payload.output_text || fullContent || derivedOutputText,
                toolCalls: event.payload.tool_calls || [],
                providerInputItems,
                providerTurnState,
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
            finish(() => reject(classifyProviderError(event.payload.message)));
          }),
        ]);

        resources.tauriUnlisteners = unlisteners;
        const tools = normalizeNativeProviderTools(params.tools, params.providerType);

        await tauriIpc.aiStreamChat({
          requestId,
          providerId: params.providerId,
          modelId: params.modelId,
          reasoningEffort: params.reasoningEffort ?? null,
          conversationId: params.conversationId ?? null,
          messages: params.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.provider_input_items
              ? { provider_input_items: message.provider_input_items }
              : {}),
            ...(params.providerType === 'chatgpt' && message.provider_turn_state
              ? { provider_turn_state: message.provider_turn_state }
              : {}),
          })),
          tools,
          toolChoice: 'auto',
          parallelToolCalls: false,
          workspacePath: params.workspacePath,
          defaultWorkspacePath: params.defaultWorkspacePath,
          projectMounts: params.projectMounts,
          virtualRootEnabled: params.virtualRootEnabled,
          focusedProjectId: params.focusedProjectId,
          allowedToolIds: params.allowedToolIds,
          copilotSendTimeoutMs: params.copilotSendTimeoutMs,
        });
      } catch (error) {
        if (params.signal) {
          params.signal.removeEventListener('abort', signalHandler);
        }
        const activeResources = activeStreamResourcesBySessionId.get(sessionId);
        if (activeResources && activeResources.tauriRequestId === requestId) {
          activeResources.tauriRequestId = null;
          clearTauriListeners(sessionId);
        }
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
};

const buildNativeProviderTurnContent = (
  providerType: string,
  turnResult: StreamingTurnResult,
  streamedTurnContent: string
): string =>
  providerType === 'chatgpt' || providerType === 'copilot'
    ? buildNativeReasoningVisibleTurnContent(
      turnResult.content || streamedTurnContent,
      turnResult.reasoningSummary
    )
    : turnResult.content || streamedTurnContent;

const streamChatViaNativeToolCallingProvider = async (
  options: StreamingChatOptions
): Promise<void> => {
  const {
    providerId,
    providerType,
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
    mcpTools: options.mcpTools,
  });
  const streamAccumulator = createStreamAccumulator({
    onToken,
    onToolTracesUpdate,
    onLiveContextUpdate: options.onLiveContextUpdate,
  });
  let currentMessages: StreamMessage[] = [...messages];
  const assistantTranscriptItems: unknown[] = [];
  let latestProviderTurnState: ProviderTurnState | undefined;
  const readEvidenceBySource = new Map<string, string>();
  const maxTurns = normalizeChatMaxTurns(options.maxTurns);
  let turnCount = 0;
  let guidedRetryCount = 0;
  let architectPostToolRetryCount = 0;
  let enforceGuidedToolRetry = Boolean(options.guidedToolRetry);
  const architectToolNamesUsed = new Set<string>();

  const completeNativeStream = (completionReason?: StreamCompletionReason) => {
    onComplete({
      ...streamAccumulator.buildResult(),
      providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
      providerTurnState: latestProviderTurnState,
      ...(completionReason ? { completionReason } : {}),
    });
  };

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
    while (maxTurns === null || turnCount < maxTurns) {
      if (options.signal?.aborted) {
        completeNativeStream();
        return;
      }

      const shouldBufferTurnOutput = enforceGuidedToolRetry;
      let streamedTurnContent = '';
      const turnResult = await streamNativeTurnViaTauri({
        sessionId: options.sessionId,
        providerId,
        providerType,
        modelId,
        reasoningEffort: options.reasoningEffort,
        conversationId: options.conversationId,
        messages: currentMessages,
        tools,
        allowedToolIds: options.allowedToolIds,
        workspacePath: options.workspacePath,
        defaultWorkspacePath: options.defaultWorkspacePath,
        projectMounts: options.projectMounts,
        virtualRootEnabled: options.virtualRootEnabled,
        focusedProjectId: options.focusedProjectId,
        copilotSendTimeoutMs: options.copilotSendTimeoutMs,
        signal: options.signal,
        onTimeline: (event) => emitStreamTimeline(options, event),
        onDelta: (delta) => {
          streamedTurnContent += delta;
          if (!shouldBufferTurnOutput) {
            streamAccumulator.appendProviderDelta(delta);
          }
        },
        onToolTrace: (toolTrace) => {
          streamAccumulator.upsertToolTraceFromProvider(toolTrace);
        },
        onToolCall,
        onToolResult,
        onLiveToolResult: ({ toolName, args, toolCallId, result, hiddenContext }) => {
          const detail = formatToolTraceDetail(toolName, args);
          streamAccumulator.addLiveOnlyHiddenToolContext(toolCallId, toolName, detail, result);
          streamAccumulator.addHiddenContextBlock(hiddenContext);
        },
      });
      turnResult.toolTraces?.forEach((toolTrace) => {
        streamAccumulator.upsertToolTraceFromProvider(toolTrace);
      });
      if (turnResult.hiddenContext) {
        streamAccumulator.addHiddenContextBlock(turnResult.hiddenContext);
      }

      const turnContent = buildNativeProviderTurnContent(
        providerType,
        turnResult,
        streamedTurnContent
      );
      const validToolCalls = getValidToolCalls(turnResult.toolCalls);
      latestProviderTurnState = turnResult.providerTurnState ?? latestProviderTurnState;
      const turnProviderInputItems =
        cloneProviderInputItems(turnResult.providerInputItems) ??
        buildAssistantProviderInputItemsFromTurn(turnContent, validToolCalls);

      if (
        shouldRetryMissingRequiredTool(options.guidedToolRetry, validToolCalls, guidedRetryCount)
      ) {
        guidedRetryCount += 1;
        const retryMessage: StreamMessage = {
          role: 'system',
          content: options.guidedToolRetry?.retrySystemPrompt || '',
        };
        currentMessages.push(retryMessage);
        turnCount += 1;
        continue;
      }

      enforceGuidedToolRetry = false;
      if (shouldBufferTurnOutput && turnContent) {
        streamAccumulator.appendProviderDelta(turnContent);
      } else {
        const missingTurnSuffix = getMissingChatGptVisibleTurnSuffix(
          streamedTurnContent,
          turnContent
        );
        if (missingTurnSuffix) {
          streamAccumulator.appendProviderDelta(missingTurnSuffix);
        }
      }
      streamAccumulator.flushProviderDelta();

      if (turnContent.trim().length > 0 || validToolCalls.length > 0) {
        if (turnProviderInputItems.length > 0) {
          assistantTranscriptItems.push(...turnProviderInputItems);
          streamAccumulator.setProviderContext({
            providerInputItems: assistantTranscriptItems,
            providerTurnState: latestProviderTurnState,
          });
        }
        currentMessages.push({
          role: 'assistant',
          content: turnContent,
          ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
          ...(turnProviderInputItems.length > 0
            ? { provider_input_items: turnProviderInputItems }
            : {}),
          ...(turnResult.providerTurnState
            ? { provider_turn_state: turnResult.providerTurnState }
            : {}),
        });
      }

      if (validToolCalls.length === 0) {
        if (
          shouldRetryArchitectPostToolResponse({
            mode: options.mode,
            usedToolNames: architectToolNamesUsed,
            visibleContent: turnContent,
            retryCount: architectPostToolRetryCount,
          })
        ) {
          logArchitectToolOnlyOutcome({
            mode: options.mode,
            usedToolNames: architectToolNamesUsed,
            visibleContent: turnContent,
            retryCount: architectPostToolRetryCount,
            providerItems: turnProviderInputItems,
            stage: 'retry',
          });
          architectPostToolRetryCount += 1;
          currentMessages.push({
            role: 'system',
            content: ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT,
          });
          turnCount += 1;
          continue;
        }
        if (
          options.mode === 'Architect' &&
          architectToolNamesUsed.size > 0 &&
          !hasMeaningfulVisibleAssistantText(turnContent)
        ) {
          logArchitectToolOnlyOutcome({
            mode: options.mode,
            usedToolNames: architectToolNamesUsed,
            visibleContent: turnContent,
            retryCount: architectPostToolRetryCount,
            providerItems: turnProviderInputItems,
            stage: 'final-empty',
          });
        }
        if (
          providerType === 'chatgpt' &&
          isEmptyTerminalChatGptTurn(turnContent, validToolCalls)
        ) {
          throw new Error('Reponse ChatGPT vide apres execution des outils.');
        }
        break;
      }

      const toolResults: ToolResult[] = [];
      let interruptResolution: ToolInterruptResolution | null = null;
      const questionToolCallCount = validToolCalls.filter(
        (toolCall) => toolCall.function.name === 'question'
      ).length;

      const toolBatchId = `native-turn-${turnCount}`;
      for (const [toolIndex, toolCall] of validToolCalls.entries()) {
        const toolName = toolCall.function.name;
        architectToolNamesUsed.add(toolName);
        let toolResult = '';
        let customToolResult: string | undefined;
        let detail: string | undefined;
        streamAccumulator.beginToolTrace(toolCall.id, toolName, detail, {
          execution_mode: 'sequential',
          batch_id: toolBatchId,
          order: toolIndex,
        });

        if (isRepeatedToolCallLoop(currentMessages, toolCall)) {
          toolResult = REPEATED_TOOL_CALL_ABORT_RESULT;
          onToolResult?.(toolName, toolResult);
          toolResults.push({
            tool_call_id: toolCall.id,
            content: toolResult,
            tool_name: toolName,
          });
          streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
          streamAccumulator.completeToolTrace(toolCall.id);
          continue;
        }

        try {
          const args = JSON.parse(toolCall.function.arguments);
          detail = formatToolTraceDetail(toolName, args);
          streamAccumulator.beginToolTrace(toolCall.id, toolName, detail, {
            execution_mode: 'sequential',
            batch_id: toolBatchId,
            order: toolIndex,
          });

          if (!allowedTools.has(toolName)) {
            toolResult = `Tool ${toolName} is disabled for the current mode.`;
            toolResults.push({ tool_call_id: toolCall.id, content: toolResult, tool_name: toolName });
            streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
            continue;
          }

          if (toolName === 'question' && questionToolCallCount > 1) {
            toolResult =
              'Error executing tool question: only one question tool call is allowed per assistant turn.';
            onToolResult?.(toolName, toolResult);
            toolResults.push({
              tool_call_id: toolCall.id,
              content: toolResult,
              tool_name: toolName,
            });
            streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
            continue;
          }

          const customResult = normalizeToolCallResolution(
            await onToolCall?.(toolName, args, toolCall.id)
          );
          if (isToolInterruptResolution(customResult)) {
            interruptResolution = customResult;
            customToolResult = customResult.result;
            streamAccumulator.addHiddenContextBlock(customResult.hiddenContext);
          } else if (customResult?.kind === 'result') {
            customToolResult = customResult.result;
          }
          if (customToolResult && toolName === 'read_file') {
            rememberReadEvidenceFromWorkspaceResult(customToolResult);
          }

          if (showToolTraces) {
            streamAccumulator.appendSystemChunk(formatToolUsageLabel(toolName, args), false);
          }

          if (!customToolResult && toolName === 'web_search') {
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

          if (!customToolResult && toolName === 'web_fetch') {
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

          if (!customToolResult && toolName === 'read_file') {
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
                  const content = (contextMatch.content || contextMatch.snippet || '').trim();
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

          if (customToolResult && toolName === 'mark_source_passage') {
            toolResult = customToolResult;
          } else if (toolName === 'mark_source_passage') {
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
        } finally {
          streamAccumulator.completeToolTrace(toolCall.id);
        }

        toolResults.push({
          tool_call_id: toolCall.id,
          content: toolResult,
          tool_name: toolName,
        });

        if (interruptResolution) {
          break;
        }
      }

      if (interruptResolution) {
        streamAccumulator.replaceVisibleContent(interruptResolution.visibleContent);
        onComplete({
          ...streamAccumulator.buildResult(),
          providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
          providerTurnState: latestProviderTurnState,
        });
        return;
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
        const toolMessages = toolResults.map((result) => {
          const providerInputItem = buildFunctionCallOutputProviderInputItem(
            result.tool_call_id,
            result.content
          );
          assistantTranscriptItems.push(
            cloneProviderInputItems([providerInputItem])?.[0] ?? providerInputItem
          );
          streamAccumulator.setProviderContext({
            providerInputItems: assistantTranscriptItems,
            providerTurnState: latestProviderTurnState,
          });
          return {
            role: 'tool' as const,
            content: result.content,
            tool_call_id: result.tool_call_id,
            provider_input_items: [providerInputItem],
          };
        });

        currentMessages.push(...toolMessages);

        if (hasToolErrors || hasFileReadResults) {
          devLogger.info('ChatGPT follow-up turn proceeding with full transcript after guarded tool results', {
            hasToolErrors,
            hasFileReadResults,
            toolResultCount: toolResults.length,
          });
        }
        currentMessages = await maybeCompactFollowUpMessages(options, {
          reason: 'tool_results',
          messages: currentMessages,
          turnCount,
          toolResultCount: toolResults.length,
        });
      }

      turnCount++;
      if (maxTurns !== null && toolResults.length > 0 && turnCount >= maxTurns) {
        streamAccumulator.markRunningToolTracesDone();
        completeNativeStream('tool_turn_limit');
        return;
      }
    }

    completeNativeStream();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      completeNativeStream();
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
  } finally {
    clearTauriListeners(options.sessionId);
    const activeResources = activeStreamResourcesBySessionId.get(
      getStreamSessionId(options.sessionId)
    );
    if (activeResources) {
      activeResources.tauriRequestId = null;
      pruneActiveStreamResources(options.sessionId);
    }
  }
};

const streamChatViaChatGptProvider = async (options: StreamingChatOptions): Promise<void> =>
  streamChatViaNativeToolCallingProvider({
    ...options,
    providerType: 'chatgpt',
  });

const streamChatViaCopilotProvider = async (options: StreamingChatOptions): Promise<void> => {
  return streamChatViaNativeToolCallingProvider({
    ...options,
    providerType: 'copilot',
  });
};

export async function streamChat(options: StreamingChatOptions): Promise<void> {
  if (options.providerType === 'chatgpt') {
    return streamChatViaChatGptProvider(options);
  }

  if (options.providerType === 'copilot') {
    return streamChatViaCopilotProvider(options);
  }

  const protocolProfile = resolveChatCompletionProviderProfile({
    providerType: options.providerType,
    providerId: options.providerId,
    baseUrl: options.baseUrl,
    modelId: options.modelId,
  });

  if (
    shouldUseNativeStreamingProvider(options.providerType) &&
    !protocolProfile.requiresGenericStreaming &&
    tauriIpc.isTauriAvailable() &&
    (!options.apiKey?.trim() ||
      options.providerType === 'ollama' ||
      options.providerType === 'lmstudio')
  ) {
    try {
      return await streamChatViaNativeToolCallingProvider(options);
    } catch (error) {
      if (options.providerType === 'ollama' || options.providerType === 'lmstudio') {
        throw error;
      }
      // Generic native streaming reads keys from Macro's local secret store. If
      // the current provider relies on an in-memory key, keep the legacy TS path.
    }
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
  } = options;
  const sessionId = getStreamSessionId(options.sessionId);
  const activeResources = getOrCreateActiveStreamResources(sessionId);
  const genericRequestId = createStreamingRequestId();
  const genericTimelineStartedAt = Date.now();
  const emitGenericTimeline = (phase: StreamTimelinePhase | string) =>
    emitStreamTimeline(options, {
      request_id: genericRequestId,
      provider_id: providerId,
      provider_type: providerType,
      phase,
      elapsed_ms: Date.now() - genericTimelineStartedAt,
    });

  const allowedTools = new Set(allowedToolIds ?? []);
  const streamAccumulator = createStreamAccumulator({
    onToken,
    onToolTracesUpdate,
    onLiveContextUpdate: options.onLiveContextUpdate,
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

  // Storage for the entire conversation (mutated across loop turns)
  let currentMessages: StreamMessage[] = [...messages];
  const assistantTranscriptItems: unknown[] = [];
  let forceReasoningContentReplay = false;
  const getChatCompletionProfile = () =>
    resolveChatCompletionProviderProfile({
      providerType,
      providerId,
      baseUrl,
      modelId,
      forceReasoningContentReplay,
    });
  const initialProfile = getChatCompletionProfile();

  // Build request body with optional tools
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages: buildChatCompletionMessages(currentMessages, initialProfile),
    stream: true,
  };
  let currentReasoningEffort = reasoningEffort;
  let providerReasoningEnabled = true;
  let didRetryWithoutReasoning = false;
  applyReasoningToChatCompletionsRequest(
    requestBody,
    initialProfile,
    currentReasoningEffort,
    { enabled: providerReasoningEnabled }
  );

  const tools = collectAllowedTools({
    allowedTools,
    enableWebSearch,
    enableWebFetch,
    webSearchOptions,
    mcpTools: options.mcpTools,
  });

  const readEvidenceBySource = new Map<string, string>();
  const maxTurns = normalizeChatMaxTurns(options.maxTurns);
  let turnCount = 0;
  let guidedRetryCount = 0;
  let architectPostToolRetryCount = 0;
  let enforceGuidedToolRetry = Boolean(options.guidedToolRetry);
  const architectToolNamesUsed = new Set<string>();
  let consecutiveStreamRetryCount = 0;
  let emittedFirstProviderEvent = false;
  let emittedFirstToken = false;

  const completeGenericStream = (completionReason?: StreamCompletionReason) => {
    onComplete({
      ...streamAccumulator.buildResult(),
      providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
      ...(completionReason ? { completionReason } : {}),
    });
  };

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
    while (maxTurns === null || turnCount < maxTurns) {
      if (options.signal?.aborted) {
        emitGenericTimeline('done');
        completeGenericStream();
        return;
      }

      let response: Response | null = null;
      let requestAttempt = 0;
      while (!response) {
        const profile = getChatCompletionProfile();
        const requestMessages = buildChatCompletionMessages(currentMessages, profile);
        requestBody.messages = requestMessages;
        applyReasoningToChatCompletionsRequest(
          requestBody,
          profile,
          currentReasoningEffort,
          { enabled: providerReasoningEnabled }
        );
        applyToolsToChatCompletionsRequest(requestBody, tools, profile, requestMessages);

        try {
          emitGenericTimeline('provider_request_sent');
          const candidateResponse = await fetchWithTimeout(
            `${baseUrl}/chat/completions`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody),
            },
            GENERIC_REQUEST_TIMEOUT_MS,
            options.signal
          );

          if (!candidateResponse.ok) {
            throw await extractProviderErrorMessage(candidateResponse);
          }

          response = candidateResponse;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            emitGenericTimeline('done');
            onComplete({
              ...streamAccumulator.buildResult(),
              providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
            });
            return;
          }

          const runtimeError =
            error instanceof ProviderRuntimeError
              ? error
              : new ProviderRuntimeError(error instanceof Error ? error.message : String(error), {
                kind: 'network',
                retryable: true,
                cause: error,
              });

          if (
            shouldRequestProviderReasoning(profile, currentReasoningEffort, {
              enabled: providerReasoningEnabled,
            }) &&
            !didRetryWithoutReasoning &&
            runtimeError.kind === 'unsupported_reasoning'
          ) {
            didRetryWithoutReasoning = true;
            providerReasoningEnabled = false;
            currentReasoningEffort = null;
            disableReasoningForSession(providerId, modelId);
            continue;
          }

          if (
            runtimeError.kind === 'reasoning_replay_required' &&
            !forceReasoningContentReplay &&
            hasReplayableReasoningContent(currentMessages)
          ) {
            forceReasoningContentReplay = true;
            continue;
          }

          if (runtimeError.retryable && requestAttempt < GENERIC_RETRY_MAX_ATTEMPTS) {
            requestAttempt += 1;
            await sleep(getRetryDelayMs(requestAttempt, runtimeError.retryAfterMs), options.signal);
            continue;
          }

          if (turnCount === 0) {
            throw runtimeError;
          }

          const loopError = `\n\n[System: The agent loop stopped due to an API error: ${runtimeError.message}]`;
          streamAccumulator.appendSystemChunk(loopError, true);
          break;
        }
      }

      if (!response) {
        break;
      }

      if (!response.body) {
        throw new Error('No response body');
      }
      if (!emittedFirstProviderEvent) {
        emittedFirstProviderEvent = true;
        emitGenericTimeline('first_provider_event');
      }

      // Store references for cancellation
      activeResources.stream = response.body;
      const reader = activeResources.stream.getReader();
      activeResources.reader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let isThinking = false;
      let toolCalls: ToolCall[] = [];
      let turnContent = ''; // The text generated *in this specific turn*
      let turnApiContent = '';
      let turnReasoningContent = '';
      const turnReasoningDetails: unknown[] = [];
      const shouldBufferTurnOutput = enforceGuidedToolRetry;
      const appendTurnChunk = (chunk: string) => {
        if (!chunk) return;
        turnContent += chunk;
        if (!emittedFirstToken) {
          emittedFirstToken = true;
          emitGenericTimeline('first_token');
        }
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

      try {
        while (true) {
          // Check if the stream was cancelled
          if (options.signal?.aborted) {
            try {
              await reader.cancel();
            } catch (e) {
              // Ignore cancel errors
            }
            onComplete({
              ...streamAccumulator.buildResult(),
              providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
            });
            return;
          }

          const { done, value } = await readStreamChunkWithIdleTimeout(
            reader,
            GENERIC_STREAM_IDLE_TIMEOUT_MS,
            options.signal
          );

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
                const choice = parsed.choices?.[0] ?? {};
                const delta = choice.delta ?? {};
                const message = choice.message ?? {};
                const reasoning = delta?.reasoning ?? delta?.reasoning_content;
                appendReasoningDetails(turnReasoningDetails, delta?.reasoning_details);
                appendReasoningDetails(turnReasoningDetails, message?.reasoning_details);

                if (typeof reasoning === 'string' && reasoning.length > 0) {
                  turnReasoningContent += reasoning;
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
                  turnApiContent += delta.content;
                  appendTurnChunk(delta.content);
                }
              } catch (e) {
                // Skip malformed JSON - some providers send non-JSON lines
                devLogger.debug('Failed to parse SSE data:', data);
              }
            }
          }
        }
        consecutiveStreamRetryCount = 0;
      } catch (error) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel errors during stream retry cleanup.
        }
        activeResources.reader = null;
        activeResources.stream = null;

        if (error instanceof Error && error.name === 'AbortError') {
          onComplete({
            ...streamAccumulator.buildResult(),
            providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
          });
          emitGenericTimeline('done');
          return;
        }

        const runtimeError =
          error instanceof ProviderRuntimeError
            ? error
            : new ProviderRuntimeError(error instanceof Error ? error.message : String(error), {
              kind: 'network',
              retryable: true,
              cause: error,
            });

        if (
          runtimeError.retryable &&
          turnContent.length === 0 &&
          getValidToolCalls(toolCalls).length === 0 &&
          consecutiveStreamRetryCount < GENERIC_RETRY_MAX_ATTEMPTS
        ) {
          consecutiveStreamRetryCount += 1;
          await sleep(
            getRetryDelayMs(consecutiveStreamRetryCount, runtimeError.retryAfterMs),
            options.signal
          );
          continue;
        }

        throw runtimeError;
      }

      activeResources.reader = null;
      activeResources.stream = null;
      endThinking();

      // Handle tool calls if any
      const validToolCalls = getValidToolCalls(toolCalls);

      if (
        shouldRetryMissingRequiredTool(options.guidedToolRetry, validToolCalls, guidedRetryCount)
      ) {
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

      const assistantProviderItem = buildAssistantChatCompletionProviderItem({
        visibleContent: turnContent,
        apiContent: turnApiContent,
        reasoningContent: turnReasoningContent,
        reasoningDetails: turnReasoningDetails,
        toolCalls: validToolCalls,
      });
      const turnProviderInputItems = assistantProviderItem ? [assistantProviderItem] : undefined;

      if (turnContent.trim().length > 0 || validToolCalls.length > 0) {
        if (turnProviderInputItems) {
          assistantTranscriptItems.push(...deepCloneJsonValue(turnProviderInputItems));
          streamAccumulator.setProviderContext({
            providerInputItems: assistantTranscriptItems,
          });
        }
        currentMessages.push({
          role: 'assistant',
          content: turnContent,
          ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
          ...(turnProviderInputItems ? { provider_input_items: turnProviderInputItems } : {}),
        });
      }

      if (validToolCalls.length === 0) {
        if (
          shouldRetryArchitectPostToolResponse({
            mode: options.mode,
            usedToolNames: architectToolNamesUsed,
            visibleContent: turnContent,
            retryCount: architectPostToolRetryCount,
          })
        ) {
          logArchitectToolOnlyOutcome({
            mode: options.mode,
            usedToolNames: architectToolNamesUsed,
            visibleContent: turnContent,
            retryCount: architectPostToolRetryCount,
            stage: 'retry',
          });
          architectPostToolRetryCount += 1;
          currentMessages.push({
            role: 'system',
            content: ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT,
          });
          turnCount += 1;
          continue;
        }

        if (
          options.mode === 'Architect' &&
          architectToolNamesUsed.size > 0 &&
          !hasMeaningfulVisibleAssistantText(turnContent)
        ) {
          logArchitectToolOnlyOutcome({
            mode: options.mode,
            usedToolNames: architectToolNamesUsed,
            visibleContent: turnContent,
            retryCount: architectPostToolRetryCount,
            stage: 'final-empty',
          });
        }
      }

      if (validToolCalls.length > 0) {
        const toolResults: ToolResult[] = [];
        let interruptResolution: ToolInterruptResolution | null = null;
        const questionToolCallCount = validToolCalls.filter(
          (toolCall) => toolCall.function.name === 'question'
        ).length;

        const toolBatchId = `generic-turn-${turnCount}`;
        for (const [toolIndex, toolCall] of validToolCalls.entries()) {
          const toolName = toolCall.function.name;
          architectToolNamesUsed.add(toolName);
          let toolResult = '';
          let customToolResult: string | undefined;
          let detail: string | undefined;
          streamAccumulator.beginToolTrace(toolCall.id, toolName, detail, {
            execution_mode: 'sequential',
            batch_id: toolBatchId,
            order: toolIndex,
          });

          if (isRepeatedToolCallLoop(currentMessages, toolCall)) {
            toolResult = REPEATED_TOOL_CALL_ABORT_RESULT;
            onToolResult?.(toolName, toolResult);
            toolResults.push({
              tool_call_id: toolCall.id,
              content: toolResult,
            });
            streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
            streamAccumulator.completeToolTrace(toolCall.id);
            continue;
          }

          try {
            const args = JSON.parse(toolCall.function.arguments);
            detail = formatToolTraceDetail(toolName, args);
            streamAccumulator.beginToolTrace(toolCall.id, toolName, detail, {
              execution_mode: 'sequential',
              batch_id: toolBatchId,
              order: toolIndex,
            });

            if (!allowedTools.has(toolName)) {
              toolResult = `Tool ${toolName} is disabled for the current mode.`;
              toolResults.push({
                tool_call_id: toolCall.id,
                content: toolResult,
              });
              streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
              continue;
            }

            if (toolName === 'question' && questionToolCallCount > 1) {
              toolResult =
                'Error executing tool question: only one question tool call is allowed per assistant turn.';
              onToolResult?.(toolName, toolResult);
              toolResults.push({
                tool_call_id: toolCall.id,
                content: toolResult,
              });
              streamAccumulator.addHiddenToolContext(toolCall.id, toolName, detail, toolResult);
              continue;
            }

            const customResult = normalizeToolCallResolution(
              await onToolCall?.(toolName, args, toolCall.id)
            );
            if (isToolInterruptResolution(customResult)) {
              interruptResolution = customResult;
              customToolResult = customResult.result;
              streamAccumulator.addHiddenContextBlock(customResult.hiddenContext);
            } else if (customResult?.kind === 'result') {
              customToolResult = customResult.result;
            }
            if (customToolResult && toolName === 'read_file') {
              rememberReadEvidenceFromWorkspaceResult(customToolResult);
            }

            if (showToolTraces) {
              streamAccumulator.appendSystemChunk(formatToolUsageLabel(toolName, args), false);
            }

            if (!customToolResult && toolName === 'web_search') {
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

            if (!customToolResult && toolName === 'web_fetch') {
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

            if (!customToolResult && toolName === 'read_file') {
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
                  const content = (match.content || match.snippet || '').trim();
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

            if (customToolResult && toolName === 'mark_source_passage') {
              toolResult = customToolResult;
            } else if (toolName === 'mark_source_passage') {
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
          } finally {
            streamAccumulator.completeToolTrace(toolCall.id);
          }

          toolResults.push({
            tool_call_id: toolCall.id,
            content: toolResult,
          });

          if (interruptResolution) {
            break;
          }
        }

        if (interruptResolution) {
          streamAccumulator.replaceVisibleContent(interruptResolution.visibleContent);
          onComplete(streamAccumulator.buildResult());
          emitGenericTimeline('done');
          return;
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
              'Relance avec un chemin explicite (ex: README.md) ou vérifie le projet cible.',
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
            ...toolResults.map((result) => {
              const toolName =
                result.tool_name ??
                validToolCalls.find((toolCall) => toolCall.id === result.tool_call_id)?.function
                  .name;
              const providerInputItem = buildToolChatCompletionProviderItem(
                result.tool_call_id,
                result.content,
                toolName
              );
              assistantTranscriptItems.push(deepCloneJsonValue(providerInputItem));
              streamAccumulator.setProviderContext({
                providerInputItems: assistantTranscriptItems,
              });
              return {
                role: 'tool' as const,
                content: result.content,
                tool_call_id: result.tool_call_id,
                provider_input_items: [providerInputItem],
              };
            })
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
          currentMessages = await maybeCompactFollowUpMessages(options, {
            reason: 'tool_results',
            messages: currentMessages,
            turnCount,
            toolResultCount: toolResults.length,
          });
        }
      }

      // If no valid tool calls were made in this turn, we are done
      if (validToolCalls.length === 0) {
        break;
      }

      turnCount++;
      if (maxTurns !== null && validToolCalls.length > 0 && turnCount >= maxTurns) {
        streamAccumulator.markRunningToolTracesDone();
        completeGenericStream('tool_turn_limit');
        emitGenericTimeline('done');
        return;
      }
    }

    completeGenericStream();
    emitGenericTimeline('done');
  } catch (error) {
    // Cleanup on error
    activeResources.reader = null;
    activeResources.stream = null;
    if (error instanceof Error && error.name === 'AbortError') {
      pruneActiveStreamResources(sessionId);
      completeGenericStream();
      return;
    }

    // Better error messages for local providers
    const err = error instanceof Error ? error : new Error(String(error));
    const isLocalProvider = options.providerType === 'lmstudio' || options.providerType === 'ollama';

    if (isLocalProvider && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('connection'))) {
      const providerName = options.providerType === 'lmstudio' ? 'LM Studio' : 'Ollama';
      emitGenericTimeline('error');
      onError(new ProviderRuntimeError(
        `Cannot connect to ${providerName}. Make sure the server is running and accessible at ${options.baseUrl}`,
        {
          kind: 'network',
          retryable: true,
          providerMessage: err.message,
          cause: error,
        }
      ));
      return;
    }

    emitGenericTimeline('error');
    onError(err);
  } finally {
    // Always cleanup references to prevent memory leaks
    activeResources.reader = null;
    activeResources.stream = null;
    pruneActiveStreamResources(sessionId);
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
        sessionId: options.sessionId,
        conversationId: options.conversationId,
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
        visibleContent:
          providerType === 'chatgpt' || providerType === 'copilot'
            ? buildNativeReasoningVisibleTurnContent(turn.content, turn.reasoningSummary)
            : turn.content,
        toolTraces: turn.toolTraces ?? [],
        hiddenContext: turn.hiddenContext,
        providerInputItems: turn.providerInputItems,
        providerTurnState: turn.providerTurnState,
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
    let currentReasoningEffort = reasoningEffort;
    let providerReasoningEnabled = true;
    let didRetryWithoutReasoning = false;
    let requestAttempt = 0;
    let response: Response | null = null;

    while (!response) {
      const profile = resolveChatCompletionProviderProfile({
        providerType,
        providerId,
        baseUrl,
        modelId,
      });
      const requestMessages = buildChatCompletionMessages(messages, profile);
      const requestBody: Record<string, unknown> = {
        model: modelId,
        messages: requestMessages,
        stream: false,
      };
      applyReasoningToChatCompletionsRequest(
        requestBody,
        profile,
        currentReasoningEffort,
        { enabled: providerReasoningEnabled }
      );
      applyToolsToChatCompletionsRequest(requestBody, [], profile, requestMessages);

      const candidateResponse = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        },
        GENERIC_REQUEST_TIMEOUT_MS,
        options.signal
      );

      if (candidateResponse.ok) {
        response = candidateResponse;
        break;
      }

      const runtimeError = await extractProviderErrorMessage(candidateResponse);
      if (
        shouldRequestProviderReasoning(profile, currentReasoningEffort, {
          enabled: providerReasoningEnabled,
        }) &&
        !didRetryWithoutReasoning &&
        runtimeError.kind === 'unsupported_reasoning'
      ) {
        didRetryWithoutReasoning = true;
        providerReasoningEnabled = false;
        currentReasoningEffort = null;
        disableReasoningForSession(providerId, modelId);
        continue;
      }

      if (runtimeError.retryable && requestAttempt < GENERIC_RETRY_MAX_ATTEMPTS) {
        requestAttempt += 1;
        await sleep(getRetryDelayMs(requestAttempt, runtimeError.retryAfterMs), options.signal);
        continue;
      }

      throw runtimeError;
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    const messageContent = message.content || '';
    const reasoning = message.reasoning || message.reasoning_content || '';
    const reasoningDetails: unknown[] = [];
    appendReasoningDetails(reasoningDetails, message.reasoning_details);
    const content = reasoning
      ? `<think>${reasoning}</think>${messageContent ? `\n${messageContent}` : ''}`
      : messageContent;
    const providerItem = buildAssistantChatCompletionProviderItem({
      visibleContent: content,
      apiContent: typeof messageContent === 'string' ? messageContent : '',
      reasoningContent: typeof reasoning === 'string' ? reasoning : '',
      reasoningDetails,
      toolCalls: [],
    });
    onComplete({
      ...emptyStreamCompletionResult(content),
      providerInputItems: providerItem ? [providerItem] : undefined,
    });
    return content;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError(err);
    throw err;
  }
}
