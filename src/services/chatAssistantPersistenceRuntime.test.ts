import { expect, mock, test } from "bun:test";
import type { ChatMessage } from "../types";
import { retryAssistantPersistence, type AssistantPersistenceRecoveryPorts } from "./chatAssistantPersistenceRuntime";

function fixture() {
  let message: ChatMessage | undefined = {
    id: "assistant-a", conversation_id: "conversation-a", task_id: "task-a", turn_id: "turn-a",
    role: "assistant", content: "Recovered answer", timestamp: "2026-01-01", persistence_state: "failed",
    generation_attempts: [{ id: "attempt-a", status: "abandoned", rawText: "Draft", acceptedText: "", costUsd: null }],
  };
  const update = mock<AssistantPersistenceRecoveryPorts["persistence"]["ipc"]["updateMessage"]>(async () => {});
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected IPC"); };
  const failed = mock(({ message: error }: {assistantMessage: ChatMessage; message: string}) => {
    message = { ...message!, persistence_state: "failed", persistence_error: error }; return error;
  });
  const clearError = mock(() => {});
  const removeSavedCopy = mock(() => {});
  const resumeQueue = mock(() => {});
  const ports: AssistantPersistenceRecoveryPorts = {
    persistence: { isTauriAvailable: () => true, ipc: {
      getChatBootstrapSnapshot: unexpected, listConversations: unexpected, listMessages: unexpected,
      createMessage: unexpected, updateMessage: update, renameConversation: unexpected,
      deleteConversation: unexpected, deleteConversations: unexpected, deleteConversationTurn: unexpected, deleteMessagesAfter: unexpected,
    } },
    messages: {
      read: () => message,
      patch: (_id, fields) => { message = { ...message!, ...fields }; }, failed,
    },
    recovery: { clearError, removeSavedCopy, resumeQueue },
  };
  return { ports, update, failed, clearError, removeSavedCopy, resumeQueue, read: () => message, remove: () => { message = undefined; } };
}

test("retries a failed response through the persistence adapter and resumes its own queue", async () => {
  const f = fixture();
  await retryAssistantPersistence("assistant-a", f.ports);
  expect(f.update).toHaveBeenCalledTimes(1);
  expect(f.update.mock.calls[0]?.[0]).toBe("assistant-a");
  expect(f.update.mock.calls[0]?.[2]?.generationAttempts).toEqual(f.read()?.generation_attempts);
  expect(f.read()?.persistence_state).toBeUndefined();
  expect(f.clearError).toHaveBeenCalledWith("conversation-a", "assistant-a");
  expect(f.resumeQueue).toHaveBeenCalledWith("conversation-a");
});

test("keeps recovery on failure and permits a later successful retry", async () => {
  const f = fixture();
  f.update.mockRejectedValueOnce(new Error("disk full"));
  await expect(retryAssistantPersistence("assistant-a", f.ports)).rejects.toThrow("disk full");
  expect(f.read()?.persistence_state).toBe("failed");
  expect(f.removeSavedCopy).not.toHaveBeenCalled();
  await retryAssistantPersistence("assistant-a", f.ports);
  expect(f.read()?.persistence_state).toBeUndefined();
});

test("does not reinsert a removed response or clear another runtime when the write resolves late", async () => {
  const f = fixture();
  let finish!: () => void;
  f.update.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const saving = retryAssistantPersistence("assistant-a", f.ports);
  expect(f.read()?.persistence_state).toBe("retrying");
  await expect(retryAssistantPersistence("assistant-a", f.ports)).rejects.toThrow("not waiting");
  f.remove();
  finish();
  await saving;
  expect(f.read()).toBeUndefined();
  expect(f.clearError).not.toHaveBeenCalled();
  expect(f.resumeQueue).not.toHaveBeenCalled();
});
