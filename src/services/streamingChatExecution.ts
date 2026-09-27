import { runToolCallingLoop } from './ai/toolCallingLoop';
import { createNativeAdapter } from './ai/nativeAdapter';
import { createChatCompletionsAdapter } from './ai/chatCompletionsAdapter';
import type { ReasoningCompatibility } from './ai/reasoningCompatibility';
import { resolveChatCompletionProviderProfile, buildChatCompletionMessages, validateChatCompletionMessageSequence, buildAssistantChatCompletionProviderItem, appendReasoningDetails, applyToolsToChatCompletionsRequest } from './ai/chatCompletionsCodec';
import { buildNativeReasoningVisibleTurnContent } from './ai/responsesCodec';
import { emptyStreamCompletionResult, createStreamAccumulator } from './ai/streamAccumulator';
import { GENERIC_RETRY_MAX_ATTEMPTS, GENERIC_REQUEST_TIMEOUT_MS, getRetryDelayMs, sleep, fetchWithTimeout } from './ai/httpTransport';
import { streamNativeTurnViaTauri } from './ai/nativeTurnTransport';
import type { StreamingChatOptions, StreamingTurnResult } from './ai/contracts';
import type { ActiveStreamResources } from './ai/streamResources';
import { classifyReasoningRejection, extractProviderErrorMessage } from './ai/providerErrors';
import * as tauriIpc from './tauriIpc';
import { applyReasoningToChatCompletionsRequest, shouldRequestProviderReasoning } from './providerProtocolProfiles';
import type { ReasoningEffort, ReasoningTransportMode } from '../types';

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

const streamChatViaNativeToolCallingProvider = async (options: StreamingChatOptions, resources: ActiveStreamResources, compatibility: ReasoningCompatibility): Promise<void> => {
  const accumulator = createStreamAccumulator(options);
  try {
    options.onComplete(await runToolCallingLoop(options, createNativeAdapter(options, accumulator, compatibility, resources), accumulator));
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
  }
};

const streamChatViaChatGptProvider = async (options: StreamingChatOptions, resources: ActiveStreamResources, compatibility: ReasoningCompatibility): Promise<void> =>
  streamChatViaNativeToolCallingProvider({
    ...options,
    providerType: 'chatgpt',
  }, resources, compatibility);

const streamChatViaCopilotProvider = async (options: StreamingChatOptions, resources: ActiveStreamResources, compatibility: ReasoningCompatibility): Promise<void> => {
  return streamChatViaNativeToolCallingProvider({
    ...options,
    providerType: 'copilot',
  }, resources, compatibility);
};

export async function streamChat(options: StreamingChatOptions, resources: ActiveStreamResources, compatibility: ReasoningCompatibility): Promise<void> {
  const reasoningTransportMode =
    options.reasoningTransportMode;
  const effectiveOptions = { ...options, reasoningTransportMode };

  if (options.providerType === 'chatgpt') {
    return streamChatViaChatGptProvider(effectiveOptions, resources, compatibility);
  }

  if (options.providerType === 'copilot') {
    return streamChatViaCopilotProvider(effectiveOptions, resources, compatibility);
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
      return await streamChatViaNativeToolCallingProvider(effectiveOptions, resources, compatibility);
    } catch (error) {
      if (options.providerType === 'ollama' || options.providerType === 'lmstudio') {
        throw error;
      }
      // Generic native streaming reads keys from Macro's local secret store. If
      // the current provider relies on an in-memory key, keep the legacy TS path.
    }
  }

  const accumulator = createStreamAccumulator(effectiveOptions);
  const transport = createChatCompletionsAdapter(effectiveOptions, compatibility, resources);
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
export async function sendChatNonStreaming(options: Omit<StreamingChatOptions, 'onToken'>, resources: ActiveStreamResources, compatibility: ReasoningCompatibility): Promise<string> {
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
    options.reasoningTransportMode;

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
          }, resources);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const rejection = classifyReasoningRejection(message);
          const rejectedEffort = currentReasoningEffort;
          if (rejection === 'parameter' && rejectedEffort && !didRetryWithoutReasoning) {
            didRetryWithoutReasoning = true;
            currentReasoningEffort = null;
            compatibility.disableReasoning();
            continue;
          }
          if (
            rejection === 'value' &&
            rejectedEffort &&
            !rejectedReasoningEfforts.has(rejectedEffort)
          ) {
            rejectedReasoningEfforts.add(rejectedEffort);
            compatibility.disableEffort(rejectedEffort);
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
        compatibility.disableReasoning();
        continue;
      }

      if (
        reasoningRejection === 'value' &&
        currentReasoningEffort &&
        !rejectedReasoningEfforts.has(currentReasoningEffort)
      ) {
        const rejectedEffort = currentReasoningEffort;
        rejectedReasoningEfforts.add(rejectedEffort);
        compatibility.disableEffort(rejectedEffort);
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
