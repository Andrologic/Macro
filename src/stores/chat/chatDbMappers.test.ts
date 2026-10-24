import { describe, expect, it } from "bun:test";
import { resolveActiveConversationQuestionnaire } from '../../services/chatQuestionnaires';

import type { Conversation } from "../../types";
import type { DbConversation, DbMessage } from "../../services/tauriIpc";
import {
  assistantTurnRequiresUserReply,
  buildAssistantMessagePresentation,
  buildUserMessagePresentation,
  mapDbConversationToConversation,
  mapDbMessageToChatMessage,
  normalizeReasoningEffort,
  parseDbProviderInputItems,
  parseDbProviderTurnState,
} from "./chatDbMappers";

const dbConversation = (patch: Partial<DbConversation> = {}): DbConversation => ({
  id: "conv-1",
  title: "Conversation",
  description: null,
  scope_mode: "Chat",
  task_id: null,
  group_id: null,
  project_id: null,
  provider_id: "provider-1",
  model_id: "model-1",
  reasoning_effort: "high",
  created_at: "2026-05-16T09:00:00.000Z",
  last_message: null,
  message_count: 0,
  is_pinned: false,
  updated_at: "2026-05-16T10:00:00.000Z",
  ...patch,
});

const dbMessage = (patch: Partial<DbMessage> = {}): DbMessage => ({
  id: "message-1",
  conversation_id: "conv-1",
  role: "assistant",
  content: "Hello",
  created_at: "2026-05-16T10:00:00.000Z",
  turn_id: "turn-1",
  token_count: null,
  tool_traces_json: null,
  hidden_context: null,
  provider_input_items_json: null,
  provider_turn_state_json: null,
  ...patch,
});

describe("chatDbMappers", () => {
  it("rehydrates imported text without turning old quick replies or traces into live actions", () => {
    const content = "Pick one\n\n[quick-replies]\n- Oui\n- Non\n- Peut-être\n[/quick-replies]";
    const historical = mapDbMessageToChatMessage(dbMessage({ content, portable_history: {
      version: 1, importKey: "archive", manifest: "a".repeat(64), ordinal: "0",
      sourceOrdinal: "0", displayDate: null, inheritedFrom: null,
    }, tool_traces_json: '[{"tool_name":"question","status":"running"}]' }), new Map());
    expect(historical.content).toBe(content);
    expect(historical.choices).toBeUndefined();
    expect(historical.questionnaire).toBeUndefined();
    expect(historical.tool_traces).toBeUndefined();
    expect(historical.provider_turn_state).toBeUndefined();
    const ordinary = mapDbMessageToChatMessage(dbMessage({ content }), new Map());
    expect(ordinary.choices).toHaveLength(3);
    const reloaded = JSON.parse(JSON.stringify(historical));
    expect(resolveActiveConversationQuestionnaire('conv-1', [{ ...reloaded, questionnaire: ordinary.questionnaire }])).toBeNull();
    expect(resolveActiveConversationQuestionnaire('conv-1', [reloaded, { ...ordinary, id: 'new' }])?.assistantMessageId).toBe('new');
  });

  it("maps database conversations and normalizes reasoning effort", () => {
    expect(normalizeReasoningEffort("high")).toBe("high");
    expect(normalizeReasoningEffort("max")).toBe("max");
    expect(normalizeReasoningEffort("provider_custom")).toBe("provider_custom");
    expect(normalizeReasoningEffort("invalid effort")).toBeNull();

    const conversation = mapDbConversationToConversation(
      dbConversation({ description: null, last_message: null }),
    );

    expect(conversation.description).toBe("");
    expect(conversation.last_message).toBe("");
    expect(conversation.reasoning_effort).toBe("high");
    expect(conversation.is_unread).toBe(false);
  });

  it("parses provider payload JSON defensively", () => {
    expect(parseDbProviderInputItems('[{"type":"message"}]')).toEqual([
      { type: "message" },
    ]);
    expect(parseDbProviderInputItems('{"type":"message"}')).toBeUndefined();
    expect(
      parseDbProviderTurnState(
        JSON.stringify({ provider: "chatgpt", output_items: [{ id: "1" }] }),
      ),
    ).toEqual({ provider: "chatgpt", output_items: [{ id: "1" }] });
    expect(parseDbProviderTurnState(JSON.stringify({ provider: "other" }))).toBeUndefined();
  });

  it("maps assistant and user message presentation fields", () => {
    const conversation: Conversation = mapDbConversationToConversation(
      dbConversation({ task_id: "task-1" }),
    );
    const conversationById = new Map([[conversation.id, conversation]]);
    const assistant = mapDbMessageToChatMessage(
      dbMessage({
        role: "assistant",
        content: "Pick one\n\n[quick-replies]\n- Oui\n- Non\n- Peut-être\n[/quick-replies]",
      }),
      conversationById,
    );
    const user = mapDbMessageToChatMessage(
      dbMessage({ id: "user-1", role: "user", content: "Answer" }),
      conversationById,
    );

    expect(assistant.task_id).toBe("task-1");
    expect(assistant.choices?.map((choice) => choice.text)).toEqual([
      "Oui",
      "Non",
      "Peut-être",
    ]);
    expect(assistant.allow_free_response).toBe(true);
    expect(user.role).toBe("user");
    expect(buildAssistantMessagePresentation("Hello").content).toBe("Hello");
    expect(buildUserMessagePresentation("Hello").content).toBe("Hello");
    expect(assistantTurnRequiresUserReply("Hello")).toBe(false);
  });
});
