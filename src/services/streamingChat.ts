import {
  deepCloneJsonValue,
  cloneStreamMessage,
  cloneProviderInputItems,
} from './ai/jsonValues';
import {
  INCOMPLETE_RECOVERY_PROMPT,
  isIncompleteCompletionReason,
  stripContinuationOverlap,
  recoveredCompletionReason,
  shouldRetryMissingRequiredTool,
} from './ai/completionRecovery';
import {
  logStreamingDiagnostic,
  classifyProviderDiagnosticCategory,
  emitStreamTimeline,
  hasMeaningfulVisibleAssistantText,
  summarizeProviderTextPresence,
  shouldRetryArchitectPostToolResponse,
  logArchitectToolOnlyOutcome,
} from './ai/streamDiagnostics';
import {
  stripThinkingBlocksForModel,
  resolveChatCompletionProviderProfile,
  normalizeToolCallIdForProvider,
  finalizeDanglingToolCallsForChatCompletions,
  normalizeChatCompletionMessageSequence,
  buildChatCompletionMessages,
  validateChatCompletionMessageSequence,
  buildAssistantChatCompletionProviderItem,
  buildToolChatCompletionProviderItem,
  hasReplayableReasoningContent,
  appendReasoningDetails,
  chatCompletionMessagesHaveToolHistory,
  applyToolsToChatCompletionsRequest,
} from './ai/chatCompletionsCodec';
import {
  serializeCopilotConversationPrompt,
  estimateCopilotSerializedPayloadTokens,
} from './ai/copilotPromptCodec';
import {
  buildChatGptProviderTurnState,
  buildFunctionCallOutputProviderInputItem,
  extractVisibleTextFromProviderInputItems,
  buildAssistantProviderInputItemsFromTurn,
  buildChatGptVisibleTurnContent,
  buildNativeReasoningVisibleTurnContent,
  getMissingChatGptVisibleTurnSuffix,
  isEmptyTerminalChatGptTurn,
  compactToolResultForChatGptModelContext,
} from './ai/responsesCodec';
import {
  emptyStreamCompletionResult,
  createStreamAccumulator,
} from './ai/streamAccumulator';
import {
  collectAllowedTools,
} from './ai/toolDefinitions';
import {
  getStreamSessionId,
  getOrCreateActiveStreamResources,
  pruneActiveStreamResources,
  clearTauriListeners,
  getActiveStreamingSessionIds,
  createStreamingRequestId,
} from './ai/streamResources';
import {
  GENERIC_RETRY_MAX_ATTEMPTS,
  GENERIC_STREAM_IDLE_TIMEOUT_MS,
  GENERIC_REQUEST_TIMEOUT_MS,
  getRetryDelayMs,
  sleep,
  fetchWithTimeout,
  readStreamChunkWithIdleTimeout,
} from './ai/httpTransport';
import {
  extractSseData,
  createSseEventParser,
} from './ai/sse';
import {
  getValidToolCalls,
  hasCompleteToolCallBatch,
} from './ai/toolCallProtocol';
import {
  streamNativeTurnViaTauri,
} from './ai/nativeTurnTransport';
import {
  type StreamMessage,
  type ToolCall,
  type StreamCompletionReason,
  type StreamTimelinePhase,
  type StreamingFollowUpCompactionReason,
  type StreamingChatOptions,
  type StreamingTurnResult,
} from './ai/contracts';
import {
  ProviderRuntimeError,
  classifyReasoningRejection,
  isReasoningUnsupportedError,
  isReasoningReplayRequiredError,
  isContextOverflowError,
  classifyProviderError,
  extractProviderErrorMessage,
  extractSseProviderError,
} from './ai/providerErrors';
import {
  getToolCallLoopKey,
  isRepeatedToolCallLoop,
  runToolBatch,
} from './ai/toolCallRunner';
import {
  isToolInterruptResolution,
  normalizeToolCallResolution,
} from './ai/toolCallResolution';
import {
  formatToolTraceDetail,
  buildToolContextBlock,
} from './ai/toolPresentation';
import * as tauriIpc from './tauriIpc';
import { ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT } from '../domains/chat/prompts';
import { normalizeChatMaxTurns } from './chatTurnLimits';
import { applyReasoningToChatCompletionsRequest, shouldRequestProviderReasoning } from './providerProtocolProfiles';
import { getMacroToolRegistryEntry, type JsonSchema } from '../shared/macroToolRegistry';
import type { ProviderTurnState, ReasoningEffort, ReasoningTransportMode } from '../types';
import { devLogger } from '../utils/devLogger';
import { useProviderStore } from '../stores/useProviderStore';

export type * from './ai/contracts';
/**
 * Streaming Chat Service
 * Handles SSE streaming from OpenAI-compatible endpoints
 * Uses Tauri HTTP plugin for proper CORS handling
 * Supports tool calling for web search and file reading
 */

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
    allowedToolIds,
  } = options;

  const allowedTools = new Set(allowedToolIds ?? []);
  const tools = collectAllowedTools({
    allowedTools,
    enableWebSearch,
    enableWebFetch,
    webSearchOptions,
    mcpTools: options.mcpTools,
    skillToolIds: options.skillToolIds,
    runnableSkillToolIds: options.runnableSkillToolIds,
  });
  const toolSchemas = new Map<string, JsonSchema>();
  for (const toolName of allowedTools) {
    const entry = getMacroToolRegistryEntry(toolName);
    if (entry) toolSchemas.set(toolName, entry.parameters);
  }
  const streamAccumulator = createStreamAccumulator({
    onToken,
    onToolTracesUpdate,
    onLiveContextUpdate: options.onLiveContextUpdate,
  });
  let currentMessages: StreamMessage[] = [...messages];
  const assistantTranscriptItems: unknown[] = [];
  let latestProviderTurnState: ProviderTurnState | undefined;
  const maxTurns = normalizeChatMaxTurns(options.maxTurns);
  let turnCount = 0;
  let guidedRetryCount = 0;
  let architectPostToolRetryCount = 0;
  let enforceGuidedToolRetry = Boolean(options.guidedToolRetry);
  const architectToolNamesUsed = new Set<string>();
  let currentReasoningEffort =
    options.reasoningTransportMode === 'none' ? null : options.reasoningEffort;
  let didRetryWithoutReasoning = false;
  const rejectedReasoningEfforts = new Set<ReasoningEffort>();
  let incompleteRecoveryCause: 'length' | 'incomplete' | null = null;

  const completeNativeStream = (completionReason?: StreamCompletionReason) => {
    onComplete({
      ...streamAccumulator.buildResult(),
      providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
      providerTurnState: latestProviderTurnState,
      ...(completionReason ? { completionReason } : {}),
    });
  };

  try {
    while (maxTurns === null || turnCount < maxTurns) {
      if (options.signal?.aborted) {
        completeNativeStream();
        return;
      }

      const recoveryCause = incompleteRecoveryCause;
      const recoveringIncompleteThisTurn = recoveryCause !== null;
      const shouldBufferTurnOutput = enforceGuidedToolRetry || recoveringIncompleteThisTurn;
      let streamedTurnContent = '';
      let turnResult: StreamingTurnResult;
      while (true) {
        try {
          turnResult = await streamNativeTurnViaTauri({
            sessionId: options.sessionId,
            providerId,
            providerType,
            modelId,
            reasoningEffort: currentReasoningEffort,
            conversationId: options.conversationId,
            messages: currentMessages,
            tools: recoveringIncompleteThisTurn ? [] : tools,
            allowedToolIds: recoveringIncompleteThisTurn ? [] : options.allowedToolIds,
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
      const replayTurnContent = recoveringIncompleteThisTurn
        ? stripContinuationOverlap(
            streamAccumulator.buildResult().visibleContent,
            turnContent,
          )
        : turnContent;
      const rawToolCalls = getValidToolCalls(turnResult.toolCalls);
      const incompleteProviderTurn = isIncompleteCompletionReason(
        turnResult.completionReason,
      );
      const validToolCalls = incompleteProviderTurn
        ? []
        : rawToolCalls;
      const recoveryAttemptedToolCall =
        recoveringIncompleteThisTurn && rawToolCalls.length > 0;
      const turnProviderInputItems =
        recoveringIncompleteThisTurn || incompleteProviderTurn
          ? buildAssistantProviderInputItemsFromTurn(replayTurnContent, validToolCalls)
          : cloneProviderInputItems(turnResult.providerInputItems) ??
            buildAssistantProviderInputItemsFromTurn(replayTurnContent, validToolCalls);
      const replayProviderTurnState = turnResult.providerTurnState
        ? {
            ...turnResult.providerTurnState,
            output_items:
              recoveringIncompleteThisTurn || incompleteProviderTurn
                ? cloneProviderInputItems(turnProviderInputItems) ?? []
                : turnResult.providerTurnState.output_items,
          }
        : undefined;
      latestProviderTurnState = replayProviderTurnState ?? latestProviderTurnState;

      if (
        !incompleteProviderTurn &&
        !recoveringIncompleteThisTurn &&
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
      if (shouldBufferTurnOutput && replayTurnContent) {
        streamAccumulator.appendProviderDelta(replayTurnContent);
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

      if (replayTurnContent.trim().length > 0 || validToolCalls.length > 0) {
        if (turnProviderInputItems.length > 0) {
          assistantTranscriptItems.push(...turnProviderInputItems);
          streamAccumulator.setProviderContext({
            providerInputItems: assistantTranscriptItems,
            providerTurnState: latestProviderTurnState,
          });
        }
        currentMessages.push({
          role: 'assistant',
          content: replayTurnContent,
          ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
          ...(turnProviderInputItems.length > 0
            ? { provider_input_items: turnProviderInputItems }
            : {}),
          ...(replayProviderTurnState
            ? { provider_turn_state: replayProviderTurnState }
            : {}),
        });
      }

      if (validToolCalls.length === 0) {
        if (incompleteProviderTurn && !recoveringIncompleteThisTurn) {
          incompleteRecoveryCause =
            turnResult.completionReason === 'length' ? 'length' : 'incomplete';
          currentMessages.push({ role: 'system', content: INCOMPLETE_RECOVERY_PROMPT });
          continue;
        }
        if (isIncompleteCompletionReason(turnResult.completionReason)) {
          completeNativeStream(turnResult.completionReason);
          return;
        }
        if (recoveryAttemptedToolCall) {
          completeNativeStream('incomplete');
          return;
        }
        const pendingSteers = options.consumePendingSteers?.() ?? [];
        if (pendingSteers.length > 0) {
          currentMessages.push(...pendingSteers.map(cloneStreamMessage));
          turnCount += 1;
          continue;
        }
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
          throw new Error('Réponse ChatGPT vide après exécution des outils.');
        }
        completeNativeStream(
          recoveryCause && !isIncompleteCompletionReason(turnResult.completionReason)
            ? recoveredCompletionReason(recoveryCause)
            : (turnResult.completionReason ?? 'completed'),
        );
        return;
      }

      if (recoveringIncompleteThisTurn) {
        throw new Error('Incomplete response recovery attempted to call a tool.');
      }

      const { toolResults, interruptResolution } = await runToolBatch({
        calls: validToolCalls, messages: currentMessages, options, allowedTools,
        schemas: toolSchemas, accumulator: streamAccumulator,
        batchId: `native-turn-${turnCount}`, usedToolNames: architectToolNamesUsed,
      });

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
        const hasToolErrors = toolResults.some((result) => result.is_error);
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
    allowedToolIds,
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
    if (providerType === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
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
      reasoningTransportMode,
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
  const rejectedReasoningEfforts = new Set<ReasoningEffort>();
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
    skillToolIds: options.skillToolIds,
    runnableSkillToolIds: options.runnableSkillToolIds,
  });
  const toolSchemas = new Map<string, JsonSchema>();
  for (const toolName of allowedTools) {
    const entry = getMacroToolRegistryEntry(toolName);
    if (entry) toolSchemas.set(toolName, entry.parameters);
  }

  const maxTurns = normalizeChatMaxTurns(options.maxTurns);
  let turnCount = 0;
  let guidedRetryCount = 0;
  let architectPostToolRetryCount = 0;
  let enforceGuidedToolRetry = Boolean(options.guidedToolRetry);
  const architectToolNamesUsed = new Set<string>();
  let consecutiveStreamRetryCount = 0;
  let emittedFirstProviderEvent = false;
  let emittedFirstToken = false;
  let incompleteRecoveryCause: 'length' | 'incomplete' | null = null;
  let terminalCompletionReason: StreamCompletionReason | undefined;

  const completeGenericStream = (completionReason?: StreamCompletionReason) => {
    onComplete({
      ...streamAccumulator.buildResult(),
      providerInputItems: cloneProviderInputItems(assistantTranscriptItems),
      ...(completionReason ? { completionReason } : {}),
    });
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
        validateChatCompletionMessageSequence(requestMessages);
        requestBody.messages = requestMessages;
        applyReasoningToChatCompletionsRequest(
          requestBody,
          profile,
          currentReasoningEffort,
          { enabled: providerReasoningEnabled }
        );
        applyToolsToChatCompletionsRequest(
          requestBody,
          incompleteRecoveryCause ? [] : tools,
          profile,
          requestMessages,
        );

        try {
          logStreamingDiagnostic('debug', 'provider_request', {
            request_id: genericRequestId,
            provider_id: providerId,
            provider_type: providerType,
            model_id: modelId,
            turn: turnCount,
            message_count: requestMessages.length,
            tool_count: tools.length,
            has_tool_history: chatCompletionMessagesHaveToolHistory(requestMessages),
          });
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
          logStreamingDiagnostic('error', 'provider_request_failed', {
            request_id: genericRequestId,
            provider_id: providerId,
            provider_type: providerType,
            model_id: modelId,
            turn: turnCount,
            error_kind: classifyProviderDiagnosticCategory(error),
            status: error instanceof ProviderRuntimeError ? error.status : undefined,
            error_name: error instanceof Error ? error.name : 'UnknownError',
          });
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
      const sseParser = createSseEventParser();
      let isThinking = false;
      let toolCalls: ToolCall[] = [];
      let turnContent = ''; // The text generated *in this specific turn*
      let turnApiContent = '';
      let turnReasoningContent = '';
      const turnCompletion = {
        reason: undefined as StreamCompletionReason | undefined,
      };
      const turnReasoningDetails: unknown[] = [];
      const recoveryCause = incompleteRecoveryCause;
      const recoveringIncompleteThisTurn = recoveryCause !== null;
      const shouldBufferTurnOutput =
        enforceGuidedToolRetry || recoveringIncompleteThisTurn;
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

      const processSseEvent = (rawEvent: string): boolean => {
        const data = extractSseData(rawEvent);
        if (!data) {
          return false;
        }
        if (data === '[DONE]') {
          turnCompletion.reason ??= hasCompleteToolCallBatch(toolCalls)
            ? 'completed'
            : 'incomplete';
          return true;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Skip malformed JSON - some providers send non-JSON lines.
          devLogger.debug('Failed to parse SSE data:', data);
          return false;
        }

        const providerError = extractSseProviderError(parsed, data);
        if (providerError) {
          throw providerError;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          // Skip valid JSON values that are not Chat Completions event objects.
          devLogger.debug('Ignoring non-object SSE JSON data:', data);
          return false;
        }

        const payload = parsed as {
          error?: unknown;
          choices?: Array<{
            delta?: {
              reasoning?: unknown;
              reasoning_content?: unknown;
              reasoning_details?: unknown;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
              content?: string;
            };
            message?: { reasoning_details?: unknown };
            finish_reason?: unknown;
          }>;
        };

        const choice = payload.choices?.[0];
        const delta = choice?.delta ?? {};
        const message = choice?.message ?? {};
        if (typeof choice?.finish_reason === 'string') {
          const finishReason = choice.finish_reason.trim();
          turnCompletion.reason =
            finishReason === 'length' ||
            finishReason === 'max_tokens' ||
            finishReason === 'max_output_tokens'
              ? 'length'
              : finishReason === 'stop' ||
                  finishReason === 'tool_calls' ||
                  finishReason === 'function_call'
                ? 'completed'
                : finishReason || 'incomplete';
        }
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
                id: '',
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
        return false;
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
            let receivedDone = false;
            for (const event of sseParser.push(decoder.decode())) {
              if (processSseEvent(event)) {
                receivedDone = true;
                break;
              }
            }
            if (!receivedDone) {
              for (const event of sseParser.flush()) {
                if (processSseEvent(event)) {
                  break;
                }
              }
            }
            break;
          }

          let receivedDone = false;
          for (const event of sseParser.push(decoder.decode(value, { stream: true }))) {
            if (processSseEvent(event)) {
              receivedDone = true;
              break;
            }
          }
          if (receivedDone) {
            await reader.cancel().catch(() => {
              // Ignore cancellation errors after a terminal SSE marker.
            });
            break;
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
      turnCompletion.reason ??= 'incomplete';

      // Handle tool calls if any
      const validToolCalls = getValidToolCalls(toolCalls);
      const incompleteProviderTurn = isIncompleteCompletionReason(turnCompletion.reason);
      const recoveryAttemptedToolCall =
        recoveringIncompleteThisTurn && validToolCalls.length > 0;
      const replayableToolCalls =
        incompleteProviderTurn || recoveryAttemptedToolCall ? [] : validToolCalls;

      if (
        !incompleteProviderTurn &&
        !recoveringIncompleteThisTurn &&
        shouldRetryMissingRequiredTool(
          options.guidedToolRetry,
          replayableToolCalls,
          guidedRetryCount,
        )
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
      const replayTurnContent = recoveringIncompleteThisTurn
        ? stripContinuationOverlap(
            streamAccumulator.buildResult().visibleContent,
            turnContent,
          )
        : turnContent;
      if (shouldBufferTurnOutput && replayTurnContent) {
        streamAccumulator.appendProviderDelta(replayTurnContent);
      }
      streamAccumulator.flushProviderDelta();

      const assistantProviderItem = buildAssistantChatCompletionProviderItem({
        visibleContent: replayTurnContent,
        apiContent: recoveringIncompleteThisTurn ? replayTurnContent : turnApiContent,
        reasoningContent: turnReasoningContent,
        reasoningDetails: turnReasoningDetails,
        toolCalls: replayableToolCalls,
      });
      const turnProviderInputItems = assistantProviderItem ? [assistantProviderItem] : undefined;

      if (replayTurnContent.trim().length > 0 || replayableToolCalls.length > 0) {
        if (turnProviderInputItems) {
          assistantTranscriptItems.push(...deepCloneJsonValue(turnProviderInputItems));
          streamAccumulator.setProviderContext({
            providerInputItems: assistantTranscriptItems,
          });
        }
        currentMessages.push({
          role: 'assistant',
          content: replayTurnContent,
          ...(replayableToolCalls.length > 0 ? { tool_calls: replayableToolCalls } : {}),
          ...(turnProviderInputItems ? { provider_input_items: turnProviderInputItems } : {}),
        });
      }

      if (replayableToolCalls.length === 0) {
        if (incompleteProviderTurn && !recoveringIncompleteThisTurn) {
          incompleteRecoveryCause =
            turnCompletion.reason === 'length' ? 'length' : 'incomplete';
          currentMessages.push({ role: 'system', content: INCOMPLETE_RECOVERY_PROMPT });
          continue;
        }
        if (isIncompleteCompletionReason(turnCompletion.reason)) {
          terminalCompletionReason = turnCompletion.reason;
          break;
        }
        if (recoveryAttemptedToolCall) {
          terminalCompletionReason = 'incomplete';
          break;
        }
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

      if (replayableToolCalls.length > 0) {
        const { toolResults, interruptResolution } = await runToolBatch({
          calls: replayableToolCalls, messages: currentMessages, options, allowedTools,
          schemas: toolSchemas, accumulator: streamAccumulator,
          batchId: `generic-turn-${turnCount}`, usedToolNames: architectToolNamesUsed,
        });

        if (interruptResolution) {
          streamAccumulator.replaceVisibleContent(interruptResolution.visibleContent);
          onComplete(streamAccumulator.buildResult());
          emitGenericTimeline('done');
          return;
        }

        // If we have tool results, make a follow-up request to get the final response
        if (toolResults.length > 0) {
          const hasToolErrors = toolResults.some((result) => result.is_error);
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
                replayableToolCalls.find((toolCall) => toolCall.id === result.tool_call_id)?.function
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

          currentMessages = await maybeCompactFollowUpMessages(options, {
            reason: 'tool_results',
            messages: currentMessages,
            turnCount,
            toolResultCount: toolResults.length,
          });
          if (hasToolErrors) {
            currentMessages.push({
              role: 'system',
              content:
                'One or more tool calls failed. Do not fabricate file contents or command outputs. ' +
                'State the exact failure and ask for corrected input when needed.',
            });
          }
          if (hasFileReadResults) {
            currentMessages.push({
              role: 'system',
              content:
                'For file analysis tasks, use only the exact tool outputs provided in this conversation. ' +
                'Do not invent code symbols, handlers, routes, or data absent from those outputs.',
            });
          }
        }
      }

      // If no valid tool calls were made in this turn, we are done
      if (replayableToolCalls.length === 0) {
        const pendingSteers = options.consumePendingSteers?.() ?? [];
        if (pendingSteers.length > 0) {
          currentMessages.push(...pendingSteers.map(cloneStreamMessage));
          turnCount += 1;
          continue;
        }
        terminalCompletionReason =
          recoveryCause && !isIncompleteCompletionReason(turnCompletion.reason)
            ? recoveredCompletionReason(recoveryCause)
            : turnCompletion.reason;
        break;
      }

      if (recoveringIncompleteThisTurn) {
        throw new Error('Incomplete response recovery attempted to call a tool.');
      }

      turnCount++;
      if (maxTurns !== null && replayableToolCalls.length > 0 && turnCount >= maxTurns) {
        streamAccumulator.markRunningToolTracesDone();
        completeGenericStream('tool_turn_limit');
        emitGenericTimeline('done');
        return;
      }
    }

    completeGenericStream(terminalCompletionReason);
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
