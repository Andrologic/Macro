import { runToolCallingLoop } from './ai/toolCallingLoop';
import { createNativeAdapter } from './ai/nativeAdapter';
import { createChatCompletionsAdapter } from './ai/chatCompletionsAdapter';
import { useProviderStore } from '../stores/useProviderStore';

import { stripContinuationOverlap, shouldRetryMissingRequiredTool } from './ai/completionRecovery';
import { hasMeaningfulVisibleAssistantText, summarizeProviderTextPresence, shouldRetryArchitectPostToolResponse } from './ai/streamDiagnostics';
import { stripThinkingBlocksForModel, resolveChatCompletionProviderProfile, normalizeToolCallIdForProvider, finalizeDanglingToolCallsForChatCompletions, normalizeChatCompletionMessageSequence, buildChatCompletionMessages, validateChatCompletionMessageSequence, buildAssistantChatCompletionProviderItem, buildToolChatCompletionProviderItem, appendReasoningDetails, chatCompletionMessagesHaveToolHistory, applyToolsToChatCompletionsRequest } from './ai/chatCompletionsCodec';
import { serializeCopilotConversationPrompt, estimateCopilotSerializedPayloadTokens } from './ai/copilotPromptCodec';
import { buildChatGptProviderTurnState, buildFunctionCallOutputProviderInputItem, extractVisibleTextFromProviderInputItems, buildChatGptVisibleTurnContent, buildNativeReasoningVisibleTurnContent, getMissingChatGptVisibleTurnSuffix, isEmptyTerminalChatGptTurn, compactToolResultForChatGptModelContext } from './ai/responsesCodec';
import { emptyStreamCompletionResult, createStreamAccumulator } from './ai/streamAccumulator';
import { collectAllowedTools } from './ai/toolDefinitions';
import { getActiveStreamingSessionIds } from './ai/streamResources';
import { GENERIC_RETRY_MAX_ATTEMPTS, GENERIC_REQUEST_TIMEOUT_MS, getRetryDelayMs, sleep, fetchWithTimeout, readStreamChunkWithIdleTimeout } from './ai/httpTransport';
import { extractSseData, createSseEventParser } from './ai/sse';

import { streamNativeTurnViaTauri } from './ai/nativeTurnTransport';
import { type StreamingChatOptions, type StreamingTurnResult } from './ai/contracts';
import { classifyReasoningRejection, isReasoningUnsupportedError, isReasoningReplayRequiredError, isContextOverflowError, classifyProviderError, extractProviderErrorMessage } from './ai/providerErrors';
import { getToolCallLoopKey, isRepeatedToolCallLoop } from './ai/toolCallRunner';
import { isToolInterruptResolution, normalizeToolCallResolution } from './ai/toolCallResolution';
import { formatToolTraceDetail, buildToolContextBlock } from './ai/toolPresentation';
import * as tauriIpc from './tauriIpc';

import { applyReasoningToChatCompletionsRequest, shouldRequestProviderReasoning } from './providerProtocolProfiles';

import type { ReasoningEffort, ReasoningTransportMode } from '../types';

export type * from './ai/contracts';
/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool calling for web search and file reading
 */

const disableReasoningForSession = (providerId: string, modelId: string) => {
  try {
    useProviderStore.getState().markReasoningUnsupportedForModel(providerId, modelId);
  } catch {
    // Ignore runtime fallback bookkeeping outside app contexts.
  }
};

const disableReasoningEffortForSession = (
  providerId: string,
  modelId: string,
  effort: ReasoningEffort
) => {
  try {
    useProviderStore
      .getState()
      .markReasoningEffortUnsupportedForModel(providerId, modelId, effort);
  } catch {
    // Ignore runtime fallback bookkeeping outside app contexts.
  }
};

const resolveModelReasoningTransportMode = (
  providerId: string,
  modelId: string
): ReasoningTransportMode | undefined => {
  try {
    return useProviderStore
      .getState()
      .modelsByProvider[providerId]?.find((model) => model.id === modelId)
      ?.reasoningCapability?.transportMode;
  } catch {
    return undefined;
  }
};

const reasoningCompatibility = (options: Pick<StreamingChatOptions, 'providerId' | 'modelId'>) => ({
  disableReasoning: () => disableReasoningForSession(options.providerId, options.modelId),
  disableEffort: (effort: ReasoningEffort) => disableReasoningEffortForSession(options.providerId, options.modelId, effort),
});

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
  classifyReasoningRejection,
  collectAllowedTools,
  compactToolResultForChatGptModelContext,
  createStreamAccumulator,
  createSseEventParser,
  estimateCopilotSerializedPayloadTokens,
  extractVisibleTextFromProviderInputItems,
  extractSseData,
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
  readStreamChunkWithIdleTimeout,
  resolveChatCompletionProviderCapabilities: resolveChatCompletionProviderProfile,
  resolveChatCompletionProviderProfile,
  serializeCopilotConversationPrompt,
  shouldRetryArchitectPostToolResponse,
  shouldRetryMissingRequiredTool,
  shouldRequestProviderReasoning,
  stripThinkingBlocksForModel,
  stripContinuationOverlap,
  summarizeProviderTextPresence,
  validateChatCompletionMessageSequence,
};

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

const nativeProviderSupportsReasoningTransport = (
  providerType: string,
  transportMode?: ReasoningTransportMode
): boolean => {
  if (!transportMode || transportMode === 'none') return true;
  const normalizedProviderType = providerType.trim().toLowerCase();
  if (normalizedProviderType === 'openrouter') {
    return transportMode === 'openrouter_reasoning';
  }
  if (
    normalizedProviderType === 'openai' ||
    normalizedProviderType === 'ollama' ||
    normalizedProviderType === 'lmstudio'
  ) {
    return transportMode === 'openai_effort';
  }
  return true;
};

const streamChatViaNativeToolCallingProvider = async (options: StreamingChatOptions): Promise<void> => {
  const accumulator = createStreamAccumulator(options);
  try {
    options.onComplete(await runToolCallingLoop(options, createNativeAdapter(options, accumulator, reasoningCompatibility(options)), accumulator));
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
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
  const reasoningTransportMode =
    options.reasoningTransportMode ??
    resolveModelReasoningTransportMode(options.providerId, options.modelId);
  const effectiveOptions = { ...options, reasoningTransportMode };

  if (options.providerType === 'chatgpt') {
    return streamChatViaChatGptProvider(effectiveOptions);
  }

  if (options.providerType === 'copilot') {
    return streamChatViaCopilotProvider(effectiveOptions);
  }

  const protocolProfile = resolveChatCompletionProviderProfile({
    providerType: options.providerType,
    providerId: options.providerId,
    baseUrl: options.baseUrl,
    modelId: options.modelId,
    reasoningTransportMode,
  });

  if (
    shouldUseNativeStreamingProvider(options.providerType) &&
    nativeProviderSupportsReasoningTransport(options.providerType, reasoningTransportMode) &&
    !protocolProfile.requiresGenericStreaming &&
    tauriIpc.isTauriAvailable() &&
    (!options.apiKey?.trim() ||
      options.providerType === 'ollama' ||
      options.providerType === 'lmstudio')
  ) {
    try {
      return await streamChatViaNativeToolCallingProvider(effectiveOptions);
    } catch (error) {
      if (options.providerType === 'ollama' || options.providerType === 'lmstudio') {
        throw error;
      }
      // Generic native streaming reads keys from Macro's local secret store. If
      // the current provider relies on an in-memory key, keep the legacy TS path.
    }
  }

  const accumulator = createStreamAccumulator(effectiveOptions);
  const transport = createChatCompletionsAdapter(effectiveOptions, reasoningCompatibility(effectiveOptions));
  try {
    options.onComplete(await runToolCallingLoop({ ...effectiveOptions, signal: transport.signal }, transport.adapter, accumulator));
    transport.done();
  } catch (error) {
    options.onError(transport.error(error));
  } finally {
    transport.dispose();
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
  const reasoningTransportMode =
    options.reasoningTransportMode ?? resolveModelReasoningTransportMode(providerId, modelId);

  if (providerType === 'chatgpt' || providerType === 'copilot') {
    try {
      let currentReasoningEffort =
        reasoningTransportMode === 'none' ? null : options.reasoningEffort;
      let didRetryWithoutReasoning = false;
      const rejectedReasoningEfforts = new Set<ReasoningEffort>();
      let turn: StreamingTurnResult;
      while (true) {
        try {
          turn = await streamNativeTurnViaTauri({
            sessionId: options.sessionId,
            conversationId: options.conversationId,
            providerId,
            providerType,
            modelId,
            reasoningEffort: currentReasoningEffort,
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
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const rejection = classifyReasoningRejection(message);
          const rejectedEffort = currentReasoningEffort;
          if (rejection === 'parameter' && rejectedEffort && !didRetryWithoutReasoning) {
            didRetryWithoutReasoning = true;
            currentReasoningEffort = null;
            disableReasoningForSession(providerId, modelId);
            continue;
          }
          if (
            rejection === 'value' &&
            rejectedEffort &&
            !rejectedReasoningEfforts.has(rejectedEffort)
          ) {
            rejectedReasoningEfforts.add(rejectedEffort);
            disableReasoningEffortForSession(providerId, modelId, rejectedEffort);
            currentReasoningEffort = null;
            continue;
          }
          throw error;
        }
      }
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
    if (providerType === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
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
    const rejectedReasoningEfforts = new Set<ReasoningEffort>();
    let requestAttempt = 0;
    let response: Response | null = null;

    while (!response) {
      const profile = resolveChatCompletionProviderProfile({
        providerType,
        providerId,
        baseUrl,
        modelId,
        reasoningTransportMode,
      });
      const requestMessages = buildChatCompletionMessages(messages, profile);
      validateChatCompletionMessageSequence(requestMessages);
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
      const reasoningRejection = classifyReasoningRejection(runtimeError.message);
      if (
        shouldRequestProviderReasoning(profile, currentReasoningEffort, {
          enabled: providerReasoningEnabled,
        }) &&
        !didRetryWithoutReasoning &&
        reasoningRejection === 'parameter'
      ) {
        didRetryWithoutReasoning = true;
        providerReasoningEnabled = false;
        currentReasoningEffort = null;
        disableReasoningForSession(providerId, modelId);
        continue;
      }

      if (
        reasoningRejection === 'value' &&
        currentReasoningEffort &&
        !rejectedReasoningEfforts.has(currentReasoningEffort)
      ) {
        const rejectedEffort = currentReasoningEffort;
        rejectedReasoningEfforts.add(rejectedEffort);
        disableReasoningEffortForSession(providerId, modelId, rejectedEffort);
        currentReasoningEffort = null;
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

export { estimateChatCompletionSerializedPayloadTokens } from './ai/chatCompletionsCodec';

export { estimateCopilotSerializedPayloadTokens } from './ai/copilotPromptCodec';

export { GENERATE_PLAN_TOOL, CREATE_PLAN_TOOL, LIST_PLANS_TOOL, GET_PLAN_TOOL, UPDATE_PLAN_TOOL, DELETE_PLAN_TOOL, RESTORE_PLAN_TOOL, SET_ACTIVE_PLAN_TOOL } from './ai/toolDefinitions';

export { cancelStream } from './ai/streamResources';

export { extractSseData, createSseEventParser, type SseEventParser } from './ai/sse';
