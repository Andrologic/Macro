import type { StreamingChatOptions, ToolCall, StreamCompletionReason } from './contracts';
import type { ReasoningEffort } from '../../types';
import type { ToolCallingAdapter } from './toolCallingLoop';
import { ProviderRuntimeError, classifyReasoningRejection, extractProviderErrorMessage, extractSseProviderError } from './providerErrors';
import { resolveChatCompletionProviderProfile, buildChatCompletionMessages, validateChatCompletionMessageSequence, applyToolsToChatCompletionsRequest, chatCompletionMessagesHaveToolHistory, hasReplayableReasoningContent, appendReasoningDetails, buildAssistantChatCompletionProviderItem, buildToolChatCompletionProviderItem } from './chatCompletionsCodec';
import { applyReasoningToChatCompletionsRequest, shouldRequestProviderReasoning } from '../providerProtocolProfiles';
import { GENERIC_RETRY_MAX_ATTEMPTS, GENERIC_STREAM_IDLE_TIMEOUT_MS, GENERIC_REQUEST_TIMEOUT_MS, getRetryDelayMs, sleep, fetchWithTimeout, readStreamChunkWithIdleTimeout } from './httpTransport';
import { createSseEventParser, extractSseData } from './sse';
import { getValidToolCalls, hasCompleteToolCallBatch } from './toolCallProtocol';
import { logStreamingDiagnostic, classifyProviderDiagnosticCategory, emitStreamTimeline } from './streamDiagnostics';
import { getStreamSessionId, createActiveStreamResources, createStreamingRequestId, pruneActiveStreamResources } from './streamResources';
import type { ReasoningCompatibility } from './reasoningCompatibility';
import { devLogger } from '../../utils/devLogger';

export function createChatCompletionsAdapter(sourceOptions: StreamingChatOptions, reasoning: ReasoningCompatibility) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (sourceOptions.signal?.aborted) abort();
  else sourceOptions.signal?.addEventListener('abort', abort, { once: true });
  const options = { ...sourceOptions, signal: controller.signal };
  const { providerId, providerType, baseUrl, apiKey, modelId, reasoningEffort, reasoningTransportMode } = options;
  const sessionId = getStreamSessionId(options.sessionId);
  const activeResources = createActiveStreamResources(sessionId);
  activeResources.cancel = abort;
  const genericRequestId = createStreamingRequestId();
  const genericTimelineStartedAt = Date.now();
  const emitGenericTimeline = (phase: string) => emitStreamTimeline(options, {
    request_id: genericRequestId, provider_id: providerId, provider_type: providerType,
    phase, elapsed_ms: Date.now() - genericTimelineStartedAt,
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
    messages: [],
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

  let emittedFirstProviderEvent = false;
  let emittedFirstToken = false;
  const streamTurn: ToolCallingAdapter['streamTurn'] = async ({ messages: currentMessages, tools, turnCount, onDelta }) => {
    let consecutiveStreamRetryCount = 0;
    while (true) {
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
          tools,
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
          if (error instanceof Error && error.name === 'AbortError') throw error;

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
            reasoning.disableReasoning();
            continue;
          }

          if (
            reasoningRejection === 'value' &&
            currentReasoningEffort &&
            !rejectedReasoningEfforts.has(currentReasoningEffort)
          ) {
            const rejectedEffort = currentReasoningEffort;
            rejectedReasoningEfforts.add(rejectedEffort);
            reasoning.disableEffort(rejectedEffort);
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
          return { stopped: loopError };
        }
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
      const toolCalls: ToolCall[] = [];
      let turnContent = ''; // The text generated *in this specific turn*
      let turnApiContent = '';
      let turnReasoningContent = '';
      const turnCompletion = {
        reason: undefined as StreamCompletionReason | undefined,
      };
      const turnReasoningDetails: unknown[] = [];
      const appendTurnChunk = (chunk: string) => {
        if (!chunk) return;
        turnContent += chunk;
        if (!emittedFirstToken) {
          emittedFirstToken = true;
          emitGenericTimeline('first_token');
        }
        onDelta(chunk);
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
            throw new DOMException('Aborted', 'AbortError');
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

        if (error instanceof Error && error.name === 'AbortError') throw error;

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

      return {
        result: { content: turnContent, toolCalls, completionReason: turnCompletion.reason },
        projectAssistant: (content, calls, recovering) => {
          const item = buildAssistantChatCompletionProviderItem({
            visibleContent: content, apiContent: recovering ? content : turnApiContent,
            reasoningContent: turnReasoningContent, reasoningDetails: turnReasoningDetails,
            toolCalls: calls,
          });
          return { items: item ? [item] : [] };
        },
      };
    }
  };
  const adapter: ToolCallingAdapter = {
    kind: 'generic', streamTurn,
    projectTool: (result, calls) => buildToolChatCompletionProviderItem(
      result.tool_call_id, result.content,
      result.tool_name ?? calls.find((call) => call.id === result.tool_call_id)?.function.name,
    ),
    afterToolResults: (messages, results) => {
      if (results.some((result) => result.is_error)) messages.push({ role: 'system', content:
        'One or more tool calls failed. Do not fabricate file contents or command outputs. ' +
        'State the exact failure and ask for corrected input when needed.' });
      if (results.some((result) => /^FILE:\s+/m.test(result.content))) messages.push({ role: 'system', content:
        'For file analysis tasks, use only the exact tool outputs provided in this conversation. ' +
        'Do not invent code symbols, handlers, routes, or data absent from those outputs.' });
    },
  };
  return {
    adapter,
    signal: controller.signal,
    done: () => emitGenericTimeline('done'),
    error: (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      emitGenericTimeline('error');
      if (isLocalProvider && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('connection'))) {
        const name = providerType === 'lmstudio' ? 'LM Studio' : 'Ollama';
        return new ProviderRuntimeError(`Cannot connect to ${name}. Make sure the server is running and accessible at ${baseUrl}`, {
          kind: 'network', retryable: true, providerMessage: err.message, cause: error,
        });
      }
      return err;
    },
    dispose: () => {
      sourceOptions.signal?.removeEventListener('abort', abort);
      void activeResources.reader?.cancel().catch(() => undefined);
      activeResources.reader = null;
      activeResources.stream = null;
      pruneActiveStreamResources(sessionId, activeResources);
    },
  };
}
