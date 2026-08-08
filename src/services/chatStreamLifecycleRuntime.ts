import type { AppMode, ChatMessage } from "../types";
import { toServiceError } from "./contracts/errors";
import {
  buildProviderErrorTranscriptMarkdown,
  resolveChatErrorPresentation,
  type ChatErrorPresentation,
} from "./chatErrorPresentation";
import type { ChatStreamTokenControls } from "./chatStreamOrchestrator";
import type { StreamCompletionResult } from "./streamingChat";
import { mergeToolTracesPreservingDeniedStatus } from "./toolTraceState";

export interface ChatStreamLifecycleProviderContext {
  providerId: string;
  providerType: string;
  modelId: string;
  baseUrl?: string | null;
}

export interface ChatStreamLifecycleRuntimeParams {
  conversationId: string;
  sessionId: string;
  turnId: string | null;
  assistantMessageId: string;
  modeAtSend: AppMode;
  resolvedTaskId?: string | null;
  providerContext: ChatStreamLifecycleProviderContext;
}

export interface ChatStreamLifecycleRuntimeAdapters {
  shouldAcceptStreamUpdate: () => boolean;
  isAbortSignalAborted: () => boolean;
  appendTokenChunk: (messageId: string, chunk: string) => void;
  getAssistantMessage: (messageId: string) => ChatMessage | undefined;
  updateMessageFields: (
    messageId: string,
    fields: Partial<ChatMessage>,
  ) => void;
  updateMessageContent: (messageId: string, content: string) => void;
  markProviderReachable: (providerId: string, modelId: string) => void;
  getTaskStatus: (taskId: string) => string | null | undefined;
  markTaskAwaitingResponse: (taskId: string) => Promise<void> | void;
  assistantTurnRequiresUserReply: (
    visibleContent: string,
    hiddenContext?: string,
  ) => boolean;
  updateConversationAfterCompletion: (
    conversationId: string,
    visibleContent: string,
  ) => void;
  clearLiveStreamContextEstimate: (conversationId: string) => void;
  refreshConversationContextDiagnostics: (
    conversationId: string,
    providerContext: ChatStreamLifecycleProviderContext,
  ) => Promise<void> | void;
  persistAssistantStreamResult: (
    conversationId: string,
    assistantMessageId: string,
    result: StreamCompletionResult,
  ) => Promise<void>;
  persistAssistantPartialStreamResult: (
    assistantMessage: ChatMessage,
  ) => Promise<void>;
  consolidatePendingToolBoundaryCompactionAfterPersistence: () => Promise<void>;
  syncMacroMetadataAfterStream: (
    mode: AppMode,
    conversationId: string,
  ) => Promise<void> | void;
  setCompletionPersistenceError: (params: {
    conversationId: string;
    sessionId: string;
    turnId: string | null;
    assistantMessageId: string;
    message: string;
  }) => void;
  maybeMarkImplementTaskFailedAfterStreamError: () => Promise<void>;
  tryRecoverFromOverflow: (
    error: Error,
    tokenControls: ChatStreamTokenControls,
  ) => Promise<boolean>;
  removeEmptyAssistantPlaceholder: (assistantMessageId: string) => void;
  deleteEmptyAssistantMessageFromDb: () => Promise<void>;
  setStreamErrorState: (params: {
    presentation: ChatErrorPresentation;
    assistantMessageId: string | null;
  }) => void;
  warn: (message: string, error: unknown) => void;
  info: (message: string) => void;
}

const isTaskStatusAwaitingResponseEligible = (
  status: string | null | undefined,
): boolean => status !== null && status !== undefined && status !== "Completed" && status !== "Failed";

const hasAssistantProgress = (message: ChatMessage | undefined): boolean =>
  Boolean(
    message &&
      (message.content.trim().length > 0 ||
        (message.tool_traces?.length ?? 0) > 0),
  );

const resolveErrorAssistantMessageId = (params: {
  presentation: ChatErrorPresentation;
  assistantMessageId: string;
  hasPartialAssistantProgress: boolean;
}): string | null =>
  params.presentation.displayTarget === "composer" &&
  !params.hasPartialAssistantProgress
    ? null
    : params.assistantMessageId;

const buildAssistantContentWithProviderError = (
  message: ChatMessage | undefined,
  presentation: ChatErrorPresentation,
): string => {
  const providerErrorMarkdown = buildProviderErrorTranscriptMarkdown(presentation);
  return hasAssistantProgress(message) && message
    ? `${message.content.trimEnd()}\n\n---\n\n${providerErrorMarkdown}`
    : providerErrorMarkdown;
};

export const applyAssistantStreamCompletion = (params: {
  assistantMessageId: string;
  result: StreamCompletionResult;
  adapters: Pick<
    ChatStreamLifecycleRuntimeAdapters,
    "getAssistantMessage" | "updateMessageFields" | "updateMessageContent"
  >;
}) => {
  const existingToolTraces =
    params.adapters.getAssistantMessage(params.assistantMessageId)?.tool_traces ??
    [];
  const mergedToolTraces = mergeToolTracesPreservingDeniedStatus(
    params.result.toolTraces,
    existingToolTraces,
  );

  params.adapters.updateMessageFields(params.assistantMessageId, {
    tool_traces: mergedToolTraces,
    hidden_context: params.result.hiddenContext,
    provider_input_items: params.result.providerInputItems,
    provider_turn_state: params.result.providerTurnState,
    ...(params.result.completionReason
      ? { completion_reason: params.result.completionReason }
      : {}),
  });
  params.adapters.updateMessageContent(
    params.assistantMessageId,
    params.result.visibleContent,
  );
};

export const createChatStreamLifecycleRuntime = (params: {
  stream: ChatStreamLifecycleRuntimeParams;
  adapters: ChatStreamLifecycleRuntimeAdapters;
}) => {
  const { stream, adapters } = params;

  const handleCompletionPersistenceFailure = (error: unknown): void => {
    const normalized = toServiceError(error);
    adapters.setCompletionPersistenceError({
      conversationId: stream.conversationId,
      sessionId: stream.sessionId,
      turnId: stream.turnId,
      assistantMessageId: stream.assistantMessageId,
      message: normalized.message,
    });
  };

  const persistAssistantStreamResultAndConsolidate = async (
    result: StreamCompletionResult,
  ): Promise<void> => {
    try {
      await adapters.persistAssistantStreamResult(
        stream.conversationId,
        stream.assistantMessageId,
        result,
      );
    } catch (error) {
      handleCompletionPersistenceFailure(error);
      return;
    }

    try {
      await adapters.consolidatePendingToolBoundaryCompactionAfterPersistence();
    } catch (error) {
      adapters.info(
        `Tool-boundary compaction consolidation failed after stream persistence: ${toServiceError(error).message}`,
      );
    }
  };

  const maybeMarkTaskAwaitingResponse = (
    result: StreamCompletionResult,
  ): void => {
    const taskStatus = stream.resolvedTaskId
      ? adapters.getTaskStatus(stream.resolvedTaskId)
      : null;
    const shouldMarkTaskAwaitingResponse =
      stream.modeAtSend === "Implement" &&
      Boolean(stream.resolvedTaskId) &&
      isTaskStatusAwaitingResponseEligible(taskStatus) &&
      adapters.assistantTurnRequiresUserReply(
        result.visibleContent,
        result.hiddenContext,
      );

    if (shouldMarkTaskAwaitingResponse && stream.resolvedTaskId) {
      void adapters.markTaskAwaitingResponse(stream.resolvedTaskId);
    }
  };

  const persistPartialAssistantSafely = async (
    message: ChatMessage,
    warning: string,
  ): Promise<void> => {
    try {
      await adapters.persistAssistantPartialStreamResult(message);
    } catch (persistError) {
      adapters.warn(warning, persistError);
    }
  };

  const applyStreamErrorPresentation = async (
    errorPresentation: ChatErrorPresentation,
    assistantMessage: ChatMessage | undefined,
  ): Promise<boolean> => {
    if (errorPresentation.displayTarget === "transcript") {
      adapters.updateMessageContent(
        stream.assistantMessageId,
        buildAssistantContentWithProviderError(
          assistantMessage,
          errorPresentation,
        ),
      );
      const updatedAssistantMessage = adapters.getAssistantMessage(
        stream.assistantMessageId,
      );
      if (updatedAssistantMessage) {
        await persistPartialAssistantSafely(
          updatedAssistantMessage,
          "Failed to persist provider error after stream error:",
        );
      }
      return hasAssistantProgress(updatedAssistantMessage);
    }

    if (hasAssistantProgress(assistantMessage) && assistantMessage) {
      await persistPartialAssistantSafely(
        assistantMessage,
        "Failed to persist partial assistant response after stream error:",
      );
      return true;
    }

    adapters.removeEmptyAssistantPlaceholder(stream.assistantMessageId);
    await adapters.deleteEmptyAssistantMessageFromDb();
    return false;
  };

  return {
    appendTokenChunk: (tokenChunk: string) => {
      if (!adapters.shouldAcceptStreamUpdate()) {
        return;
      }
      adapters.appendTokenChunk(stream.assistantMessageId, tokenChunk);
    },

    onComplete: async (
      result: StreamCompletionResult,
      tokenControls: ChatStreamTokenControls,
    ) => {
      if (!adapters.shouldAcceptStreamUpdate()) {
        tokenControls.dispose();
        return;
      }

      tokenControls.flushNow();
      applyAssistantStreamCompletion({
        assistantMessageId: stream.assistantMessageId,
        result,
        adapters,
      });
      adapters.markProviderReachable(
        stream.providerContext.providerId,
        stream.providerContext.modelId,
      );

      maybeMarkTaskAwaitingResponse(result);
      adapters.updateConversationAfterCompletion(
        stream.conversationId,
        result.visibleContent,
      );
      adapters.clearLiveStreamContextEstimate(stream.conversationId);
      void adapters.refreshConversationContextDiagnostics(
        stream.conversationId,
        stream.providerContext,
      );

      void persistAssistantStreamResultAndConsolidate(result);
      void adapters.syncMacroMetadataAfterStream(
        stream.modeAtSend,
        stream.conversationId,
      );
      tokenControls.dispose();
    },

    onError: async (error: Error, tokenControls: ChatStreamTokenControls) => {
      if (
        adapters.isAbortSignalAborted() ||
        !adapters.shouldAcceptStreamUpdate()
      ) {
        tokenControls.dispose();
        return;
      }

      if (await adapters.tryRecoverFromOverflow(error, tokenControls)) {
        return;
      }

      tokenControls.flushNow();
      tokenControls.dispose();
      adapters.clearLiveStreamContextEstimate(stream.conversationId);
      await adapters.maybeMarkImplementTaskFailedAfterStreamError();

      const assistantMessage = adapters.getAssistantMessage(
        stream.assistantMessageId,
      );
      const errorPresentation = resolveChatErrorPresentation(error, {
        providerId: stream.providerContext.providerId,
        providerType: stream.providerContext.providerType,
        modelId: stream.providerContext.modelId,
      });
      const hasPartialAssistantProgress = await applyStreamErrorPresentation(
        errorPresentation,
        assistantMessage,
      );

      adapters.setStreamErrorState({
        presentation: errorPresentation,
        assistantMessageId: resolveErrorAssistantMessageId({
          presentation: errorPresentation,
          assistantMessageId: stream.assistantMessageId,
          hasPartialAssistantProgress,
        }),
      });
    },
  };
};
