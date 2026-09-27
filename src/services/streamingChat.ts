import { useProviderStore } from '../stores/useProviderStore';
import type { ReasoningEffort, ReasoningTransportMode } from '../types';
import type { StreamingChatOptions } from './ai/contracts';
import { emptyStreamCompletionResult } from './ai/streamCompletionResult';
import { createActiveStreamResources, pruneActiveStreamResources } from './ai/streamResources';

export type * from './ai/contracts';
type StreamingChatExecution = Pick<typeof import('./streamingChatExecution'), 'streamChat' | 'sendChatNonStreaming'>;
type ChatOptions = Omit<StreamingChatOptions, 'onToken'>;

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

const reasoningCompatibility = (options: Pick<StreamingChatOptions, 'providerId' | 'modelId'>) => ({
  disableReasoning: () => disableReasoningForSession(options.providerId, options.modelId),
  disableEffort: (effort: ReasoningEffort) => disableReasoningEffortForSession(options.providerId, options.modelId, effort),
});

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

// Resolve provider state and reserve cancellation before the module load yields.
// Each invocation keeps its own resources even when a newer call takes its session key.
const captureInvocation = <T extends ChatOptions>(options: T) => {
  const inputSignal = options.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const captured = {
    ...options,
    reasoningTransportMode: options.reasoningTransportMode ??
      resolveModelReasoningTransportMode(options.providerId, options.modelId),
    signal: controller.signal,
  };
  const resources = createActiveStreamResources(captured.sessionId);
  resources.cancel = abort;
  if (inputSignal?.aborted) abort();
  else inputSignal?.addEventListener('abort', abort, { once: true });
  return {
    options: captured,
    resources,
    dispose: () => {
      inputSignal?.removeEventListener('abort', abort);
      pruneActiveStreamResources(captured.sessionId, resources);
    },
  };
};

const loadUntilAborted = (
  load: () => Promise<StreamingChatExecution>,
  signal: AbortSignal,
): Promise<StreamingChatExecution> => new Promise((resolve, reject) => {
  const abort = () => {
    signal.removeEventListener('abort', abort);
    reject(new DOMException('Aborted', 'AbortError'));
  };
  if (signal.aborted) { abort(); return; }
  signal.addEventListener('abort', abort, { once: true });
  // Always observe late module failures, even after cancellation has settled the caller.
  try {
    load().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  } catch (error) {
    signal.removeEventListener('abort', abort);
    reject(error);
  }
});

export const createStreamingChatService = (
  load: () => Promise<StreamingChatExecution> = () => import('./streamingChatExecution'),
) => {
  let executionPromise: Promise<StreamingChatExecution> | undefined;
  const loadExecution = () => {
    const pending = executionPromise ??= load();
    void pending.catch(() => {
      if (executionPromise === pending) executionPromise = undefined;
    });
    return pending;
  };
  return {
    async streamChat(options: StreamingChatOptions): Promise<void> {
      const invocation = captureInvocation(options);
      try {
        let runtime: StreamingChatExecution;
        try {
          runtime = await loadUntilAborted(loadExecution, invocation.options.signal);
          if (invocation.options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        } catch (error) {
          if (invocation.options.signal.aborted) {
            try { invocation.options.onComplete(emptyStreamCompletionResult()); }
            catch (callbackError) {
              invocation.options.onError(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
            }
          } else {
            invocation.options.onError(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        await runtime.streamChat(invocation.options, invocation.resources, reasoningCompatibility(invocation.options));
      } finally {
        invocation.dispose();
      }
    },
    async sendChatNonStreaming(options: ChatOptions): Promise<string> {
      const invocation = captureInvocation(options);
      try {
        let runtime: StreamingChatExecution;
        try {
          runtime = await loadUntilAborted(loadExecution, invocation.options.signal);
          if (invocation.options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          invocation.options.onError(err);
          throw err;
        }
        return await runtime.sendChatNonStreaming(invocation.options, invocation.resources, reasoningCompatibility(invocation.options));
      } finally {
        invocation.dispose();
      }
    },
  };
};

export const { streamChat, sendChatNonStreaming } = createStreamingChatService();

export { estimateChatCompletionSerializedPayloadTokens } from './ai/chatCompletionsCodec';

export { estimateCopilotSerializedPayloadTokens } from './ai/copilotPromptCodec';

export { GENERATE_PLAN_TOOL, CREATE_PLAN_TOOL, LIST_PLANS_TOOL, GET_PLAN_TOOL, UPDATE_PLAN_TOOL, DELETE_PLAN_TOOL, RESTORE_PLAN_TOOL, SET_ACTIVE_PLAN_TOOL } from './ai/toolDefinitions';

export { cancelStream } from './ai/streamResources';

export { extractSseData, createSseEventParser, type SseEventParser } from './ai/sse';
