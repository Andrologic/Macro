import {
  isRecord,
  deepCloneJsonValue,
} from './jsonValues';
import {
  streamContentToCopilotPromptText,
} from './copilotPromptCodec';
import {
  truncateMiddle,
} from './responsesCodec';
import {
  type StreamMessage,
  type StreamMessageContent,
  type ToolCall,
} from './contracts';
import {
  ProviderRuntimeError,
} from './providerErrors';
import { resolveChatCompletionProviderProtocolProfile, type ChatCompletionProviderProtocolProfile } from '../providerProtocolProfiles';
import type { ReasoningTransportMode } from '../../types';
import { estimateStructuredContext } from '../contextTokenEstimation';

export const TOOL_EXECUTION_ABORTED_RESULT = 'Tool execution aborted';
export const HISTORICAL_TOOL_RESULT_MAX_CHARS = 1600;
export const CHAT_COMPLETION_PROVIDER_ITEM_TYPE = 'chat_completion_message';
export interface ChatCompletionProviderMessageItem {
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

export const stripThinkingBlocksForModel = (content: string): string =>
  content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();

export const resolveChatCompletionProviderProfile = (params: {
  providerType: string;
  providerId?: string;
  baseUrl?: string;
  modelId: string;
  forceReasoningContentReplay?: boolean;
  reasoningTransportMode?: ReasoningTransportMode;
}): ChatCompletionProviderProtocolProfile =>
  resolveChatCompletionProviderProtocolProfile(params);

export const isChatCompletionProviderMessageItem = (
  item: unknown
): item is ChatCompletionProviderMessageItem => {
  if (!isRecord(item) || item.type !== CHAT_COMPLETION_PROVIDER_ITEM_TYPE) {
    return false;
  }

  return item.role === 'assistant' || item.role === 'tool';
};

export const getChatCompletionProviderItems = (
  items?: unknown[] | null
): ChatCompletionProviderMessageItem[] => {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter(isChatCompletionProviderMessageItem);
};

export const normalizeToolCallIdForProvider = (
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

export const cloneToolCalls = (
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

export const normalizeMessageContentForChatCompletions = (
  role: StreamMessage['role'],
  content: StreamMessageContent
): StreamMessageContent => {
  if (role !== 'assistant' || typeof content !== 'string') {
    return content;
  }

  return stripThinkingBlocksForModel(content);
};

export const providerItemHasToolHistory = (item: ChatCompletionProviderMessageItem): boolean =>
  item.role === 'tool' || (Array.isArray(item.tool_calls) && item.tool_calls.length > 0);

export const streamMessageHasToolHistory = (message: StreamMessage): boolean => {
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

export const shouldReplayProviderReasoningContent = (
  profile: ChatCompletionProviderProtocolProfile,
  hasToolHistory: boolean
): boolean =>
  profile.reasoningReplay === 'reasoning_content_all' ||
  (profile.reasoningReplay === 'reasoning_content_tool_chain' && hasToolHistory);

export const applyProviderReasoningReplayToMessage = (
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

export const serializeProviderItemForChatCompletions = (
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

export const getChatCompletionMessageToolCallIds = (message: Record<string, unknown>): string[] => {
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

export const chatCompletionMessageContentToText = (content: unknown): string => {
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

export const buildHistoricalToolResultMessage = (
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

export const finalizeDanglingToolCallsForChatCompletions = (
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

export const insertAssistantAfterToolBeforeUserForChatCompletions = (
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

export const normalizeChatCompletionMessageSequence = (
  messages: Array<Record<string, unknown>>,
  profile: ChatCompletionProviderProtocolProfile
): Array<Record<string, unknown>> => {
  const withToolResults = finalizeDanglingToolCallsForChatCompletions(messages);
  return profile.insertAssistantAfterToolBeforeUser
    ? insertAssistantAfterToolBeforeUserForChatCompletions(withToolResults)
    : withToolResults;
};

export const buildChatCompletionMessages = (
  messages: StreamMessage[],
  profile: ChatCompletionProviderProtocolProfile
): Array<Record<string, unknown>> => {
  const hasToolHistory = messages.some(streamMessageHasToolHistory);
  const systemContents = messages
    .filter((message) => message.role === 'system')
    .map((message) => streamContentToCopilotPromptText(message.content).trim())
    .filter(Boolean);
  const systemMessages =
    profile.systemMessagePolicy === 'single_leading' && systemContents.length > 0
      ? [{ role: 'system', content: systemContents.join('\n\n') }]
      : systemContents.map((content) => ({ role: 'system', content }));
  const serializedMessages = messages
    .filter((message) => message.role !== 'system')
    .flatMap((message) => {
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
  return normalizeChatCompletionMessageSequence(
    [...systemMessages, ...serializedMessages],
    profile,
  );
};

export const validateChatCompletionMessageSequence = (
  messages: Array<Record<string, unknown>>,
): void => {
  let sawNonSystem = false;
  const pendingToolCalls = new Set<string>();

  for (const [index, message] of messages.entries()) {
    const role = message.role;
    if (role === 'system') {
      if (sawNonSystem) {
        throw new ProviderRuntimeError(
          `Invalid message sequence: system message at index ${index} is not leading.`,
          { kind: 'invalid_tool_protocol', retryable: false },
        );
      }
      continue;
    }
    sawNonSystem = true;

    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = isRecord(call) && typeof call.id === 'string' ? call.id.trim() : '';
        const fn = isRecord(call) && isRecord(call.function) ? call.function : null;
        const name = fn && typeof fn.name === 'string' ? fn.name.trim() : '';
        if (!id || !name) {
          throw new ProviderRuntimeError(
            `Invalid tool call at message index ${index}: id and function name are required.`,
            { kind: 'invalid_tool_protocol', retryable: false },
          );
        }
        if (pendingToolCalls.has(id)) {
          throw new ProviderRuntimeError(
            `Invalid tool call at message index ${index}: duplicate id ${id}.`,
            { kind: 'invalid_tool_protocol', retryable: false },
          );
        }
        pendingToolCalls.add(id);
      }
    }

    if (role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id.trim() : '';
      if (!id || !pendingToolCalls.delete(id)) {
        throw new ProviderRuntimeError(
          `Invalid tool result at message index ${index}: no matching assistant tool call.`,
          { kind: 'invalid_tool_protocol', retryable: false },
        );
      }
    }
  }

  if (pendingToolCalls.size > 0) {
    throw new ProviderRuntimeError(
      `Invalid message sequence: ${pendingToolCalls.size} tool call(s) have no result.`,
      { kind: 'invalid_tool_protocol', retryable: false },
    );
  }
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
  const imageMetadata = params.messages.flatMap((message) => {
    const serializedMessage = buildChatCompletionMessages([message], profile);
    const serializedImageCount = estimateStructuredContext(serializedMessage).imageCount;
    const metadata = message.image_metadata ?? [];
    if (serializedImageCount === 0) return [];
    return metadata.some((item) => item.sourceFingerprint)
      ? metadata
      : metadata.slice(0, serializedImageCount);
  });
  return Math.max(
    1,
    estimateStructuredContext(serializedMessages, {
      imageMetadata,
      context: params,
    }).totalTokens
  );
};

export const buildAssistantChatCompletionProviderItem = (params: {
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

export const buildToolChatCompletionProviderItem = (
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

export const hasReplayableReasoningContent = (messages: StreamMessage[]): boolean =>
  messages.some((message) =>
    getChatCompletionProviderItems(message.provider_input_items).some(
      (item) => item.role === 'assistant' && Boolean(item.reasoning_content?.trim())
    )
  );

export const appendReasoningDetails = (target: unknown[], value: unknown) => {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    target.push(...deepCloneJsonValue(value));
    return;
  }

  target.push(deepCloneJsonValue(value));
};

export const NOOP_COMPAT_TOOL = {
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

export const chatCompletionMessagesHaveToolHistory = (
  messages: Array<Record<string, unknown>>
): boolean =>
  messages.some(
    (message) =>
      message.role === 'tool' ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  );

export const applyToolsToChatCompletionsRequest = (
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
