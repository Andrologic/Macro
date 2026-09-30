import type { ChatAssistantStreamPorts } from "../services/chatAssistantStreamRuntime";
import type { AssistantStreamLaunch } from "../services/chatStreamContracts";
import { createChatStreamCompaction, type ChatStreamCompactionPorts } from "../services/chatStreamCompaction";

/** Stable application adapters, specialized below for the captured turn. */
export interface ChatStreamCompactionCompositionPorts {
  policy: {
    loadBudget: ChatStreamCompactionPorts["policy"]["loadContextBudgetPolicy"];
    summarize(turn: AssistantStreamLaunch, input: Parameters<ChatStreamCompactionPorts["policy"]["generateSummary"]>[0]): ReturnType<ChatStreamCompactionPorts["policy"]["generateSummary"]>;
    estimate(turn: AssistantStreamLaunch, messages: Parameters<ChatStreamCompactionPorts["policy"]["estimateSerializedPayloadTokens"]>[0]): number;
    footprint(turn: AssistantStreamLaunch): ReturnType<ChatStreamCompactionPorts["read"]["getFootprintFields"]>;
    tools(turn: AssistantStreamLaunch): ReturnType<ChatStreamCompactionPorts["read"]["getToolDefinitions"]>;
  };
  read: {
    status(conversationId: string): ReturnType<ChatStreamCompactionPorts["read"]["getCompactionStatus"]>;
    request(turn: AssistantStreamLaunch): ReturnType<ChatStreamCompactionPorts["read"]["prepareMessagesForRequest"]>;
  };
  projection: ChatStreamCompactionPorts["projection"];
  persistence: ChatStreamCompactionPorts["persistence"];
}

export function composeChatStreamCompaction(ports: ChatStreamCompactionCompositionPorts): ChatAssistantStreamPorts["compaction"]["create"] {
  return (turn, baseline, accepts, ownsCompletion) => createChatStreamCompaction({
    conversationId: turn.conversationId,
    resolvedTaskId: turn.resolvedTaskId,
    selectedProviderId: turn.selectedProviderId,
    selectedModelId: turn.selectedModelId,
    assistantMessageId: turn.assistantMessage.id,
    providerConfig: turn.providerConfig,
    projectIdentity: turn.executionContext.focusedProjectId
      ? `project:${turn.executionContext.focusedProjectId}`
      : turn.executionContext.groupId
        ? `group:${turn.executionContext.groupId}` : `conversation:${turn.conversationId}`,
    citations: baseline.citations,
  }, {
    policy: {
      shouldAcceptStreamUpdate: accepts,
      stillOwnsCompletionConsolidation: ownsCompletion,
      isAbortSignalAborted: () => turn.abortController?.signal.aborted ?? false,
      loadContextBudgetPolicy: ports.policy.loadBudget,
      generateSummary: input => ports.policy.summarize(turn, input),
      estimateSerializedPayloadTokens: messages => ports.policy.estimate(turn, messages),
    },
    read: {
      getFootprintFields: () => ports.policy.footprint(turn),
      getToolDefinitions: () => ports.policy.tools(turn),
      getCompactionStatus: () => ports.read.status(turn.conversationId),
      prepareMessagesForRequest: () => ports.read.request(turn),
    },
    projection: ports.projection,
    persistence: ports.persistence,
  });
}
