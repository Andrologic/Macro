import type { ChatMessage } from "../types";
import { persistAssistantCompletionResult, type ChatPersistenceAdapters } from "./chatPersistenceService";
import { toServiceError } from "./contracts/errors";

export interface AssistantPersistenceRecoveryPorts {
  persistence: ChatPersistenceAdapters;
  messages: {
    read(id: string): ChatMessage | null | undefined;
    patch(id: string, fields: Pick<ChatMessage, "persistence_state" | "persistence_error">): void;
    failed(params: { assistantMessage: ChatMessage; message: string }): string;
  };
  recovery: {
    removeSavedCopy(id: string): void;
    clearError(conversationId: string, messageId: string): void;
    resumeQueue(conversationId: string): void;
  };
}

/** Retry the captured response, independently of whichever conversation the UI now selects. */
export async function retryAssistantPersistence(messageId: string, ports: AssistantPersistenceRecoveryPorts): Promise<void> {
  const assistantMessage = ports.messages.read(messageId);
  if (!assistantMessage || assistantMessage.role !== "assistant" || assistantMessage.persistence_state !== "failed") {
    throw new Error("This assistant response is not waiting to be saved.");
  }
  const stillOwnsRetry = () => {
    const current = ports.messages.read(messageId);
    return current?.conversation_id === assistantMessage.conversation_id &&
      current.turn_id === assistantMessage.turn_id && current.persistence_state === "retrying";
  };
  ports.messages.patch(messageId, { persistence_state: "retrying" });
  try {
    await persistAssistantCompletionResult(ports.persistence, {
      assistantMessageId: messageId, persistedAssistant: assistantMessage,
      result: {
        visibleContent: assistantMessage.content, hiddenContext: assistantMessage.hidden_context,
        providerInputItems: assistantMessage.provider_input_items, providerTurnState: assistantMessage.provider_turn_state,
        toolTraces: assistantMessage.tool_traces ?? [], completionReason: assistantMessage.completion_reason,
        generationAttempts: assistantMessage.generation_attempts,
      },
    });
  } catch (error) {
    const normalized = toServiceError(error);
    const message = normalized.message.startsWith("Failed to save assistant response:")
      ? normalized.message : `Failed to save assistant response: ${normalized.message}`;
    throw new Error(stillOwnsRetry() ? ports.messages.failed({ assistantMessage, message }) : message);
  }
  ports.recovery.removeSavedCopy(messageId);
  if (!stillOwnsRetry()) return;
  ports.messages.patch(messageId, { persistence_state: undefined, persistence_error: undefined });
  ports.recovery.clearError(assistantMessage.conversation_id, messageId);
  queueMicrotask(() => ports.recovery.resumeQueue(assistantMessage.conversation_id));
}
