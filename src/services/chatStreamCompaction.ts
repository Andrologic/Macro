import type { AssistantStreamLaunch, StreamContextDiagnosticsBaseline } from "./chatStreamContracts";
import type { ConversationCompactionState } from "../types";
import type { StreamMessage } from "./streamingChat";
import type { ContextLimitFootprintFields } from "./modelContextLimits";
import {
  buildContextTooLargeErrorMessage,
  estimateBlockableTokensForStreamMessages,
  estimateConversationFootprint,
  isBlockableContextOverUsableBudget,
  type ContextBudgetPolicy,
  type MaybeCompactConversationResult,
  type SummaryGenerationInput,
} from "./contextCompaction";
import {
  buildAppliedCompactionAuditDetails,
  buildCompactionDecisionAuditMetadata,
  consolidateCompletedAssistantTurnCompaction,
  isSyntheticCompactionBoundaryState,
  runContextCompactionOrchestration,
  type CompactionRuntimeAdapters,
  type PendingToolBoundaryCompaction,
} from "./contextCompactionOrchestrator";
import {
  resolveCompactionStatusFromState,
  type ConversationCompactionStatus,
} from "./contextCompactionSession";
import type { ChatCompactionRuntime } from "./chatCompactionRuntime";
import { isContextOverflowErrorLike } from "./contextOverflow";
import { toServiceError } from "./contracts/errors";
import {
  buildSyntheticOrderedMessagesForStreamRequest,
  cloneStreamMessage,
  normalizeMessagesForProviderContext,
  shouldCountProviderInputItemsForContext,
  splitSystemAndPreparedStreamMessages,
} from "./chatStreamCompactionMessages";

type CompactionInput = Parameters<typeof runContextCompactionOrchestration>[0];

export type ChatStreamCompactionParams = Pick<AssistantStreamLaunch,
  "conversationId" | "resolvedTaskId" | "selectedProviderId" | "selectedModelId"
> & {
  assistantMessageId: StreamContextDiagnosticsBaseline["assistantMessageId"];
  providerConfig: Pick<AssistantStreamLaunch["providerConfig"], "providerType" | "baseUrl">;
  projectIdentity: string;
  citations: StreamContextDiagnosticsBaseline["citations"];
};

export interface ChatStreamCompactionPorts {
  policy: {
    /** Canonical session/turn/assistant ownership checks supplied by the caller. */
    shouldAcceptStreamUpdate: () => boolean;
    stillOwnsCompletionConsolidation: () => boolean;
    isAbortSignalAborted: () => boolean;
    loadContextBudgetPolicy: () => Promise<ContextBudgetPolicy>;
    generateSummary: (input: SummaryGenerationInput) => Promise<string | null>;
    estimateSerializedPayloadTokens: (messages: StreamMessage[]) => number;
  };
  read: {
    getFootprintFields: () => ContextLimitFootprintFields;
    getToolDefinitions: () => CompactionInput["toolDefinitions"];
    getCompactionStatus: () => ConversationCompactionStatus | null;
    prepareMessagesForRequest: () => Promise<Pick<CompactionInput,
      "systemMessage" | "preparedMessages" | "orderedMessages" | "citations"
    >>;
  };
  projection: Pick<ChatCompactionRuntime,
    "markConversationCompactionStarted" |
    "clearLatestRunningSessionCompactionEvent" |
    "setConversationCompactionStatus" |
    "completeLatestSessionCompactionEvent"
  > & { info: (message: string) => void };
  persistence: {
    persistConversationCompactionState: (state: ConversationCompactionState) => Promise<void>;
    recordConversationCompactionEvent: CompactionRuntimeAdapters["recordCompactionAuditEvent"];
  };
}

/** One instance per assistant stream; the transient checkpoint never enters durable state. */
export const createChatStreamCompaction = (
  params: ChatStreamCompactionParams,
  ports: ChatStreamCompactionPorts,
) => {
  let pendingToolBoundaryCompaction: PendingToolBoundaryCompaction | null = null;
  const acceptsStreamUpdate = () =>
    !ports.policy.isAbortSignalAborted() && ports.policy.shouldAcceptStreamUpdate();
  const acceptsConsolidation = () =>
    !ports.policy.isAbortSignalAborted() && ports.policy.stillOwnsCompletionConsolidation();
  const generateSummaryIfCurrent = async (
    input: SummaryGenerationInput,
    isCurrent: () => boolean,
  ): Promise<string | null> => {
    if (!isCurrent()) return null;
    const summary = await ports.policy.generateSummary(input);
    return isCurrent() ? summary : null;
  };

  const compactFollowUpMessagesBeforeProviderRequest = async (request: {
    messages: StreamMessage[];
    turnCount: number;
    toolResultCount: number;
  }): Promise<{ messages: StreamMessage[]; compacted?: boolean } | void> => {
    if (
      !acceptsStreamUpdate() ||
      request.toolResultCount <= 0
    ) {
      return;
    }

    const { systemMessage, preparedMessages } =
      splitSystemAndPreparedStreamMessages(request.messages);
    if (preparedMessages.length < 3) {
      return;
    }

    const orderedMessages = buildSyntheticOrderedMessagesForStreamRequest({
      conversationId: params.conversationId,
      taskId: params.resolvedTaskId,
      messages: preparedMessages,
    });
    const footprintFields = ports.read.getFootprintFields();
    const budgetPolicy = await ports.policy.loadContextBudgetPolicy();
    if (!acceptsStreamUpdate()) return;
    const toolDefinitions = ports.read.getToolDefinitions();
    const preparedMessagesForContext = normalizeMessagesForProviderContext(
      params.providerConfig.providerType,
      preparedMessages,
    );
    const countProviderInputItems = shouldCountProviderInputItemsForContext(
      params.providerConfig.providerType,
    );
    const estimateSerializedPayloadTokens = ports.policy.estimateSerializedPayloadTokens;
    const footprint = estimateConversationFootprint({
      systemMessage,
      preparedMessages: preparedMessagesForContext,
      orderedMessages,
      citations: params.citations,
      toolDefinitions,
      ...footprintFields,
      providerType: params.providerConfig.providerType,
      providerId: params.selectedProviderId,
      baseUrl: params.providerConfig.baseUrl,
      modelId: params.selectedModelId,
      estimateSerializedPayloadTokens,
      countProviderInputItems,
      mode: "safety_prestream",
      budgetPolicy,
    });
    const latestToolBatchMessages =
      request.toolResultCount > 0
        ? preparedMessagesForContext.slice(-request.toolResultCount)
        : [];
    const latestToolBatchTokens = estimateBlockableTokensForStreamMessages(
      latestToolBatchMessages,
      {
        countProviderInputItems,
        context: {
          providerType: params.providerConfig.providerType,
          providerId: params.selectedProviderId,
          baseUrl: params.providerConfig.baseUrl,
          modelId: params.selectedModelId,
        },
      },
    );
    const previousStatus =
      ports.read.getCompactionStatus();

    let result: MaybeCompactConversationResult;
    let orchestration: Awaited<
      ReturnType<typeof runContextCompactionOrchestration>
    >;
    try {
      orchestration = await runContextCompactionOrchestration({
        boundary: "post_tool_batch",
        mode: "safety_prestream",
        systemMessage,
        preparedMessages: preparedMessagesForContext,
        orderedMessages,
        citations: params.citations,
        toolDefinitions,
        footprintFields,
        providerId: params.selectedProviderId,
        providerType: params.providerConfig.providerType,
        baseUrl: params.providerConfig.baseUrl,
        modelId: params.selectedModelId,
        projectIdentity: params.projectIdentity,
        estimateSerializedPayloadTokens,
        countProviderInputItems,
        budgetPolicy,
        latestBoundaryPayloadTokens: latestToolBatchTokens,
        buildForceCompaction: true,
        forcePrune: true,
        syntheticBoundary: true,
        onCompactionStarted: () => {
          if (!acceptsStreamUpdate()) return;
          ports.projection.markConversationCompactionStarted(
            params.conversationId,
            "safety_prestream",
            previousStatus,
            params.assistantMessageId,
          );
        },
        generateSummary: (input) => generateSummaryIfCurrent(input, acceptsStreamUpdate),
      });
    } catch (error) {
      if (!acceptsStreamUpdate()) {
        return;
      }
      ports.projection.clearLatestRunningSessionCompactionEvent(
        params.conversationId,
        "safety_prestream",
      );
      ports.projection.setConversationCompactionStatus(params.conversationId, previousStatus);
      await ports.persistence.recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: "safety_prestream",
        providerId: params.selectedProviderId,
        modelId: params.selectedModelId,
        modelContextWindowTokens: footprint.modelContextWindowTokens,
        tokensBefore: footprint.totalEstimatedTokens,
        tokensAfter: footprint.totalEstimatedTokens,
        status: "failed",
        errorCode: isContextOverflowErrorLike(error)
          ? "context_overflow"
          : "tool_boundary_compaction_error",
        reason: toServiceError(error).message,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          trigger: "safety_prestream",
          status: "failed",
          footprint,
          footprintFields,
          budgetPolicy,
          reason: toServiceError(error).message,
          result: "tool_boundary_compaction_error",
        }),
      });
      if (!acceptsStreamUpdate()) return;
      throw error;
    }
    if (!acceptsStreamUpdate()) {
      return;
    }
    if (orchestration.outcome === "blocked") {
      throw new Error(orchestration.errorMessage);
    }
    if (orchestration.outcome === "manual_required") {
      throw new Error(orchestration.errorMessage);
    }
    if (orchestration.evaluation.decision !== "compact") {
      return;
    }
    result = orchestration.result;

    if (
      result.decision === "hard_stop" ||
      isBlockableContextOverUsableBudget(result.footprintAfter)
    ) {
      ports.projection.clearLatestRunningSessionCompactionEvent(
        params.conversationId,
        "safety_prestream",
      );
      ports.projection.setConversationCompactionStatus(params.conversationId, {
        phase: "too_large",
        updatedAt: new Date().toISOString(),
        reason: result.footprintAfter.reason,
        kind: "safety_prestream",
        footprintAfter: result.footprintAfter,
      });
      await ports.persistence.recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: "safety_prestream",
        providerId: params.selectedProviderId,
        modelId: params.selectedModelId,
        modelContextWindowTokens: result.footprintAfter.modelContextWindowTokens,
        tokensBefore: result.footprintBefore.totalEstimatedTokens,
        tokensAfter: result.footprintAfter.totalEstimatedTokens,
        status: "blocked",
        reason: result.footprintAfter.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          trigger: "safety_prestream",
          status: "blocked",
          footprintBefore: result.footprintBefore,
          footprintAfter: result.footprintAfter,
          footprintFields,
          budgetPolicy,
          reason: result.footprintAfter.reason,
          result: "tool_boundary_context_too_large",
          ...buildAppliedCompactionAuditDetails({
            result,
            syntheticBoundary: true,
          }),
        }),
      });
      if (!acceptsStreamUpdate()) return;
      throw new Error(buildContextTooLargeErrorMessage(result.footprintAfter));
    }

    if (result.compactionState) {
      if (isSyntheticCompactionBoundaryState(result.compactionState)) {
        pendingToolBoundaryCompaction = {
          conversationId: params.conversationId,
          assistantMessageId: params.assistantMessageId,
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          createdAt: new Date().toISOString(),
          compactionState: result.compactionState,
          footprintBefore: result.footprintBefore,
          footprintAfter: result.footprintAfter,
          messages: result.messages.map(cloneStreamMessage),
          pruning: result.pruning,
        };
      }
      ports.projection.completeLatestSessionCompactionEvent(
        params.conversationId,
        result.compactionState,
        "safety_prestream",
      );
      ports.projection.setConversationCompactionStatus(
        params.conversationId,
        resolveCompactionStatusFromState(result.compactionState),
      );
    } else {
      ports.projection.clearLatestRunningSessionCompactionEvent(
        params.conversationId,
        "safety_prestream",
      );
      ports.projection.setConversationCompactionStatus(params.conversationId, previousStatus);
    }

    await ports.persistence.recordConversationCompactionEvent({
      conversationId: params.conversationId,
      trigger: "safety_prestream",
      providerId: params.selectedProviderId,
      modelId: params.selectedModelId,
      modelContextWindowTokens: result.footprintAfter.modelContextWindowTokens,
      tokensBefore: result.footprintBefore.totalEstimatedTokens,
      tokensAfter: result.footprintAfter.totalEstimatedTokens,
      status: result.degraded ? "degraded" : "success",
      reason: result.footprintAfter.reason,
      metadata: buildCompactionDecisionAuditMetadata({
        providerId: params.selectedProviderId,
        providerType: params.providerConfig.providerType,
        modelId: params.selectedModelId,
        trigger: "safety_prestream",
        status: result.degraded ? "degraded" : "success",
        footprintBefore: result.footprintBefore,
        footprintAfter: result.footprintAfter,
        footprintFields,
        budgetPolicy,
        reason: result.footprintAfter.reason,
        result: "tool_boundary_compaction",
        ...buildAppliedCompactionAuditDetails({
          result,
          syntheticBoundary: true,
        }),
      }),
    });

    if (!acceptsStreamUpdate()) return;
    return {
      messages: result.messages,
      compacted: Boolean(result.compactionState),
    };
  };

  const consolidatePendingToolBoundaryCompactionAfterPersistence = async () => {
    const pending = pendingToolBoundaryCompaction;
    pendingToolBoundaryCompaction = null;
    if (!pending) {
      return;
    }
    if (!acceptsConsolidation()) {
      return;
    }

    const footprintFields = ports.read.getFootprintFields();
    const budgetPolicy = await ports.policy.loadContextBudgetPolicy();
    if (!acceptsConsolidation()) {
      return;
    }
    const preparedRequest = await ports.read.prepareMessagesForRequest();
    if (!acceptsConsolidation()) {
      return;
    }
    const toolDefinitions = ports.read.getToolDefinitions();
    const preparedMessagesForContext = normalizeMessagesForProviderContext(
      params.providerConfig.providerType,
      preparedRequest.preparedMessages,
    );
    const countProviderInputItems = shouldCountProviderInputItemsForContext(
      params.providerConfig.providerType,
    );
    const estimateSerializedPayloadTokens = ports.policy.estimateSerializedPayloadTokens;
    const consolidation = await consolidateCompletedAssistantTurnCompaction({
      pending,
      systemMessage: preparedRequest.systemMessage,
      preparedMessages: preparedMessagesForContext,
      orderedMessages: preparedRequest.orderedMessages,
      citations: preparedRequest.citations,
      toolDefinitions,
      footprintFields,
      providerId: params.selectedProviderId,
      providerType: params.providerConfig.providerType,
      baseUrl: params.providerConfig.baseUrl,
      modelId: params.selectedModelId,
      projectIdentity: params.projectIdentity,
      budgetPolicy,
      estimateSerializedPayloadTokens,
      countProviderInputItems,
      generateSummary: (input) => generateSummaryIfCurrent(input, acceptsConsolidation),
    });
    if (!acceptsConsolidation()) {
      return;
    }

    if (consolidation.outcome === "consolidated") {
      if (
        consolidation.shouldPersistCompaction &&
        consolidation.result.compactionState
      ) {
        await ports.persistence.persistConversationCompactionState(
          consolidation.result.compactionState,
        );
        if (!acceptsConsolidation()) return;
      }
      await ports.persistence.recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger:
          consolidation.result.compactionState?.lastTrigger ??
          "safety_prestream",
        providerId: params.selectedProviderId,
        modelId: params.selectedModelId,
        modelContextWindowTokens:
          consolidation.result.footprintAfter.modelContextWindowTokens,
        tokensBefore: consolidation.result.footprintBefore.totalEstimatedTokens,
        tokensAfter: consolidation.result.footprintAfter.totalEstimatedTokens,
        status: consolidation.result.degraded ? "degraded" : "success",
        reason: consolidation.result.footprintAfter.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          trigger:
            consolidation.result.compactionState?.lastTrigger ??
            "safety_prestream",
          status: consolidation.result.degraded ? "degraded" : "success",
          footprintBefore: consolidation.result.footprintBefore,
          footprintAfter: consolidation.result.footprintAfter,
          footprintFields,
          budgetPolicy,
          reason: consolidation.result.footprintAfter.reason,
          result: "tool_boundary_consolidation",
          completionReason:
            [...preparedRequest.orderedMessages]
              .reverse()
              .find((message) => message.role === "assistant")
              ?.completion_reason ?? null,
          ...buildAppliedCompactionAuditDetails({
            result: {
              ...consolidation.result,
              pruning:
                consolidation.result.pruning.elements.length > 0
                  ? consolidation.result.pruning
                  : pending.pruning,
            },
            previousCheckpoint: pending.compactionState,
          }),
        }),
      });
      return;
    }

    if (consolidation.outcome === "failed") {
      const footprint =
        consolidation.preflightFootprint ?? pending.footprintAfter;
      await ports.persistence.recordConversationCompactionEvent({
        conversationId: params.conversationId,
        trigger: "safety_prestream",
        providerId: params.selectedProviderId,
        modelId: params.selectedModelId,
        modelContextWindowTokens: footprint.modelContextWindowTokens,
        tokensBefore: pending.footprintBefore.totalEstimatedTokens,
        tokensAfter: footprint.totalEstimatedTokens,
        status: "failed",
        errorCode: "tool_boundary_consolidation_failed",
        reason: consolidation.reason,
        metadata: buildCompactionDecisionAuditMetadata({
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          modelId: params.selectedModelId,
          trigger: "safety_prestream",
          status: "failed",
          footprintBefore: pending.footprintBefore,
          footprintAfter: footprint,
          footprintFields,
          budgetPolicy,
          reason: consolidation.reason,
          result: "tool_boundary_consolidation_failed",
        }),
      });
    }

    if (!acceptsConsolidation()) return;
    ports.projection.info(
      `Tool-boundary compaction consolidation ${consolidation.outcome} conversation=${params.conversationId} reason=${consolidation.reason}`,
    );
  };


  return {
    compactFollowUpMessagesBeforeProviderRequest: async (
      request: Parameters<typeof compactFollowUpMessagesBeforeProviderRequest>[0],
    ) => {
      try {
        const result = await compactFollowUpMessagesBeforeProviderRequest(request);
        return acceptsStreamUpdate() ? result : undefined;
      } catch (error) {
        if (acceptsStreamUpdate()) throw error;
      }
    },
    consolidatePendingToolBoundaryCompactionAfterPersistence: async () => {
      try {
        await consolidatePendingToolBoundaryCompactionAfterPersistence();
      } catch (error) {
        if (acceptsConsolidation()) throw error;
      }
    },
  };
};
