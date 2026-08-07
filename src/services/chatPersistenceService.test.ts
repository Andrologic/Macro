import { describe, expect, it, mock } from "bun:test";

import type { ChatMessage, Conversation, ToolTrace } from "../types";
import type {
  DbChatBootstrapSnapshot,
  DbConversation,
  DbMessage,
} from "./tauriIpc";
import {
  createAssistantPlaceholderMessage,
  createUserMessage,
  deleteConversation,
  deleteConversations,
  deleteMessagesAfter,
  loadChatBootstrapSnapshot,
  loadConversationMessages,
  persistAssistantCompletionResult,
  persistAssistantPartialResult,
  renameConversation,
  updateEditedUserMessage,
  updateProviderInputItemsForMessage,
  type ChatPersistenceAdapters,
  type ChatPersistenceIpc,
} from "./chatPersistenceService";

const dbConversation = (
  patch: Partial<DbConversation> = {},
): DbConversation => ({
  id: "conv-1",
  title: "Conversation",
  description: null,
  scope_mode: "Chat",
  task_id: "task-1",
  group_id: null,
  project_id: null,
  provider_id: "provider-1",
  model_id: "model-1",
  reasoning_effort: "high",
  created_at: "2026-05-16T09:00:00.000Z",
  updated_at: "2026-05-16T10:00:00.000Z",
  last_message: null,
  message_count: 0,
  is_pinned: false,
  ...patch,
});

const dbMessage = (patch: Partial<DbMessage> = {}): DbMessage => ({
  id: "message-1",
  conversation_id: "conv-1",
  turn_id: "turn-1",
  role: "assistant",
  content: "Hello",
  created_at: "2026-05-16T10:00:00.000Z",
  token_count: null,
  tool_traces_json: null,
  hidden_context: null,
  provider_input_items_json: null,
  provider_turn_state_json: null,
  ...patch,
});

const chatMessage = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message-1",
  conversation_id: "conv-1",
  turn_id: "turn-1",
  task_id: "task-1",
  role: "assistant",
  content: "Hello",
  timestamp: "2026-05-16T10:00:00.000Z",
  tool_traces: [],
  ...patch,
});

const baseIpc = (
  patch: Partial<ChatPersistenceIpc> = {},
): ChatPersistenceIpc => ({
  getChatBootstrapSnapshot: mock(async () => ({
    conversations: [],
    messages_by_conversation_id: {},
  })),
  listConversations: mock(async () => []),
  listMessages: mock(async () => []),
  createMessage: mock(async (_conversationId, role, content, options) =>
    dbMessage({
      id: options?.id ?? "message-1",
      role,
      content,
      turn_id: options?.turnId,
      tool_traces_json: options?.toolTraces
        ? JSON.stringify(options.toolTraces)
        : null,
      hidden_context: options?.hiddenContext ?? null,
      provider_input_items_json: options?.providerInputItems
        ? JSON.stringify(options.providerInputItems)
        : null,
      provider_turn_state_json: options?.providerTurnState
        ? JSON.stringify(options.providerTurnState)
        : null,
    }),
  ),
  updateMessage: mock(async () => undefined),
  deleteMessagesAfter: mock(async () => undefined),
  renameConversation: mock(async () => undefined),
  deleteConversation: mock(async () => undefined),
  deleteConversations: mock(async () => undefined),
  ...patch,
});

const adapters = (params?: {
  available?: boolean;
  ipc?: Partial<ChatPersistenceIpc>;
}): ChatPersistenceAdapters => ({
  isTauriAvailable: () => params?.available ?? true,
  ipc: baseIpc(params?.ipc),
  now: () => new Date("2026-05-16T10:00:00.000Z"),
  randomIdSuffix: () => "abc123",
});

describe("chatPersistenceService", () => {
  it("loads bootstrap snapshots and maps conversations/messages", async () => {
    const snapshot: DbChatBootstrapSnapshot = {
      conversations: [dbConversation({ message_count: 1 })],
      messages_by_conversation_id: {
        "conv-1": [dbMessage({ role: "user", content: "Hi" })],
      },
    };
    const result = await loadChatBootstrapSnapshot(
      adapters({
        ipc: { getChatBootstrapSnapshot: mock(async () => snapshot) },
      }),
    );

    expect(result.conversations[0]?.id).toBe("conv-1");
    expect(result.messages[0]?.content).toBe("Hi");
    expect(result.loadedConversationIds.has("conv-1")).toBe(true);
  });

  it("falls back to conversation-only bootstrap when snapshot loading fails", async () => {
    const ipc = baseIpc({
      getChatBootstrapSnapshot: mock(async () => {
        throw new Error("unsupported");
      }),
      listConversations: mock(async () => [dbConversation()]),
    });

    const result = await loadChatBootstrapSnapshot({
      ...adapters(),
      ipc,
    });

    expect(result.conversations).toHaveLength(1);
    expect(result.messages).toEqual([]);
    expect(result.bootstrapError).toBeInstanceOf(Error);
    expect(ipc.listConversations).toHaveBeenCalledTimes(1);
  });

  it("loads a conversation transcript with task metadata from conversations", async () => {
    const result = await loadConversationMessages(adapters({
      ipc: {
        listMessages: mock(async () => [
          dbMessage({ role: "assistant", content: "Answer" }),
        ]),
      },
    }), {
      conversationId: "conv-1",
      conversations: [
        {
          id: "conv-1",
          title: "Conversation",
          description: "",
          scope_mode: "Chat",
          task_id: "task-1",
          group_id: null,
          project_id: null,
          provider_id: null,
          model_id: null,
          reasoning_effort: null,
          updated_at: "2026-05-16T10:00:00.000Z",
          last_message: "",
          message_count: 1,
          is_unread: false,
        } satisfies Conversation,
      ],
    });

    expect(result[0]?.task_id).toBe("task-1");
    expect(result[0]?.content).toBe("Answer");
  });

  it("creates deterministic non-Tauri user and assistant messages", async () => {
    const nonTauri = adapters({ available: false });

    await expect(
      createUserMessage(nonTauri, {
        conversationId: "conv-1",
        turnId: "turn-1",
        taskId: "task-1",
        content: "Hello",
        providerInputItems: [{ type: "message" }],
      }),
    ).resolves.toMatchObject({
      id: "msg-1778925600000",
      role: "user",
      content: "Hello",
      provider_input_items: [{ type: "message" }],
    });

    await expect(
      createAssistantPlaceholderMessage(nonTauri, {
        conversationId: "conv-1",
        turnId: "turn-1",
        taskId: "task-1",
      }),
    ).resolves.toMatchObject({
      id: "msg-1778925600000-abc123-assistant",
      role: "assistant",
      content: "",
      tool_traces: [],
    });
  });

  it("creates Tauri messages through IPC and maps provider metadata", async () => {
    const trace: ToolTrace = {
      tool_call_id: "trace-1",
      tool_name: "read",
      status: "done",
      detail: "ok",
    };
    const ipc = baseIpc({
      createMessage: mock(async (_conversationId, role, content, options) =>
        dbMessage({
          id: options?.id ?? "message-1",
          role,
          content,
          turn_id: options?.turnId,
          tool_traces_json: JSON.stringify([trace]),
          provider_input_items_json: JSON.stringify([{ id: "provider-item" }]),
        }),
      ),
    });

    const assistant = await createAssistantPlaceholderMessage(
      { ...adapters(), ipc },
      {
        conversationId: "conv-1",
        turnId: "turn-1",
        taskId: "task-1",
      },
    );

    expect(assistant.id).toBe("msg-1778925600000-abc123-assistant");
    expect(assistant.tool_traces).toEqual([trace]);
    expect(assistant.provider_input_items).toEqual([{ id: "provider-item" }]);
    expect(ipc.createMessage).toHaveBeenCalledWith(
      "conv-1",
      "assistant",
      "",
      {
        id: "msg-1778925600000-abc123-assistant",
        turnId: "turn-1",
        toolTraces: [],
      },
    );
  });

  it("persists message updates and preserves assistant tool traces on completion", async () => {
    const ipc = baseIpc();
    const current = chatMessage({
      id: "assistant-1",
      tool_traces: [
        {
          tool_call_id: "trace-1",
          tool_name: "read",
          status: "done",
          detail: "ok",
        },
      ],
    });

    await updateProviderInputItemsForMessage({ ...adapters(), ipc }, {
      message: current,
      providerInputItems: [{ id: "input" }],
    });
    await updateEditedUserMessage({ ...adapters(), ipc }, {
      message: current,
      content: "Edited",
      turnId: "turn-2",
      hiddenContext: "hidden",
      providerInputItems: [{ id: "edited-input" }],
    });
    await persistAssistantPartialResult({ ...adapters(), ipc }, current);
    await persistAssistantCompletionResult({ ...adapters(), ipc }, {
      assistantMessageId: "assistant-1",
      persistedAssistant: current,
      result: {
        visibleContent: "Done",
        toolTraces: [],
        providerInputItems: [{ id: "result-input" }],
        completionReason: "tool_turn_limit",
      },
    });

    expect(ipc.updateMessage).toHaveBeenLastCalledWith("assistant-1", "Done", {
      turnId: "turn-1",
      toolTraces: current.tool_traces,
      hiddenContext: undefined,
      providerInputItems: [{ id: "result-input" }],
      providerTurnState: undefined,
      completionReason: "tool_turn_limit",
    });
  });

  it("delegates conversation rename and delete operations only when Tauri is available", async () => {
    const ipc = baseIpc();
    await renameConversation({ ...adapters(), ipc }, "conv-1", "Renamed");
    await deleteConversation({ ...adapters(), ipc }, "conv-1");
    await deleteConversations({ ...adapters(), ipc }, ["conv-1", "conv-2"]);

    expect(ipc.renameConversation).toHaveBeenCalledWith("conv-1", "Renamed");
    expect(ipc.deleteConversation).toHaveBeenCalledWith("conv-1");
    expect(ipc.deleteConversations).toHaveBeenCalledWith([
      "conv-1",
      "conv-2",
    ]);

    const nonTauriIpc = baseIpc();
    await renameConversation(
      { ...adapters({ available: false }), ipc: nonTauriIpc },
      "conv-1",
      "Ignored",
    );
    expect(nonTauriIpc.renameConversation).not.toHaveBeenCalled();
  });

  it("delegates replay message trimming only when Tauri is available", async () => {
    const ipc = baseIpc();

    await deleteMessagesAfter({ ...adapters(), ipc }, "conv-1", "message-1");
    await deleteMessagesAfter(
      { ...adapters({ available: false }), ipc },
      "conv-1",
      "message-1",
    );

    expect(ipc.deleteMessagesAfter).toHaveBeenCalledTimes(1);
    expect(ipc.deleteMessagesAfter).toHaveBeenCalledWith(
      "conv-1",
      "message-1",
    );
  });
});
