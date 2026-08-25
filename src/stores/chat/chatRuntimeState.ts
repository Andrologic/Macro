import type { ChatMessage, ConversationRuntimeState } from "../../types";

export type ChatSendState = "idle" | "preparing" | "streaming" | "error";

export interface ChatRuntimeStateShape {
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
  selectedConversationId: string | null;
}

export const EMPTY_CONVERSATION_RUNTIME: ConversationRuntimeState =
  Object.freeze({
    phase: "idle",
    sessionId: null,
    turnId: null,
    assistantMessageId: null,
    abortController: null,
    lastError: null,
    lastErrorOrigin: null,
    lastErrorDisplayTarget: null,
  });

export const createConversationSessionId = (): string =>
  `conversation-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const createConversationTurnId = (): string =>
  `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const getMessageTurnId = (
  message: Pick<ChatMessage, "id" | "turn_id">,
): string => message.turn_id || `legacy-turn-${message.id}`;

export const isConversationRuntimeActive = (
  runtime: ConversationRuntimeState | undefined,
): boolean =>
  runtime?.phase === "preparing" ||
  runtime?.phase === "overflow_recovery" ||
  runtime?.phase === "streaming";

export const getConversationRuntimeSnapshot = (
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>,
  conversationId: string | null | undefined,
): ConversationRuntimeState => {
  if (!conversationId) {
    return EMPTY_CONVERSATION_RUNTIME;
  }

  return conversationRuntimeById[conversationId] ?? EMPTY_CONVERSATION_RUNTIME;
};

export const buildLegacyStreamingFlags = (params: {
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
  selectedConversationId: string | null;
}): {
  isLoading: boolean;
  isStreaming: boolean;
  sendState: ChatSendState;
  abortController: AbortController | null;
} => {
  const runtimes = Object.values(params.conversationRuntimeById);
  const hasPreparingConversation = runtimes.some(
    (runtime) =>
      runtime?.phase === "preparing" ||
      runtime?.phase === "overflow_recovery",
  );
  const streamingRuntime =
    runtimes.find((runtime) => runtime?.phase === "streaming") ?? null;
  const errorRuntime =
    runtimes.find((runtime) => runtime?.phase === "error") ?? null;
  const selectedRuntime = getConversationRuntimeSnapshot(
    params.conversationRuntimeById,
    params.selectedConversationId,
  );

  return {
    isLoading: hasPreparingConversation || streamingRuntime !== null,
    isStreaming: streamingRuntime !== null,
    sendState: hasPreparingConversation
      ? "preparing"
      : streamingRuntime
        ? "streaming"
        : errorRuntime
          ? "error"
          : "idle",
    abortController:
      selectedRuntime.abortController ??
      streamingRuntime?.abortController ??
      null,
  };
};

export const buildConversationRuntimePatch = (
  state: ChatRuntimeStateShape,
  conversationId: string,
  runtime: ConversationRuntimeState | null,
): {
  conversationRuntimeById: Record<string, ConversationRuntimeState | undefined>;
  isLoading: boolean;
  isStreaming: boolean;
  sendState: ChatSendState;
  abortController: AbortController | null;
} => {
  const nextConversationRuntimeById = { ...state.conversationRuntimeById };
  if (runtime) {
    nextConversationRuntimeById[conversationId] = runtime;
  } else {
    delete nextConversationRuntimeById[conversationId];
  }

  return {
    conversationRuntimeById: nextConversationRuntimeById,
    ...buildLegacyStreamingFlags({
      conversationRuntimeById: nextConversationRuntimeById,
      selectedConversationId: state.selectedConversationId,
    }),
  };
};
