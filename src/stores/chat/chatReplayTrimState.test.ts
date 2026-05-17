import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  Conversation,
  ConversationQuestionnaireDraft,
} from "../../types";
import type {
  ConversationReplayPlan,
  ReplayCompactionMarker,
} from "../../services/conversationReplayService";
import { buildMessageState } from "./chatMessageState";
import type { MessageImageAttachment } from "./chatLocalSessionState";
import {
  buildReplayTrimStatePatch,
  type ReplayTrimStateShape,
} from "./chatReplayTrimState";

interface TestCompactionMarker extends ReplayCompactionMarker {
  id: string;
  status: "running" | "completed";
}

const makeMessage = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: "message",
  conversation_id: "conversation",
  task_id: "task",
  role: "user",
  content: "content",
  timestamp: "2026-05-16T10:00:00.000Z",
  tool_traces: [],
  ...patch,
});

const makeConversation = (
  patch: Partial<Conversation> = {},
): Conversation => ({
  id: "conversation",
  title: "Conversation",
  scope_mode: "Implement",
  task_id: "task",
  project_id: "project",
  last_message: "",
  message_count: 0,
  updated_at: "2026-05-16T10:00:00.000Z",
  is_unread: false,
  ...patch,
});

const makeDraft = (): ConversationQuestionnaireDraft => ({
  mode: "pending_reply",
  assistantMessageId: "assistant",
  currentStepIndex: 0,
  answersByStepId: {},
  draftTextByStepId: {},
});

const makeImage = (id: string): MessageImageAttachment => ({
  id,
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AA==",
  createdAt: "2026-05-16T10:00:00.000Z",
});

const makePlan = (
  patch: Partial<ConversationReplayPlan<TestCompactionMarker>> = {},
): ConversationReplayPlan<TestCompactionMarker> => ({
  conversationId: "conversation",
  replayMessageId: "u2",
  keptMessageIds: new Set(["u1", "a1", "u2"]),
  sessionCompactionEvents: [
    {
      id: "marker-before",
      status: "completed",
      displayAfterMessageId: "a1",
    },
  ],
  removedSessionCompactionEventCount: 1,
  shouldDeleteContextCompactionState: true,
  contextCompactionAction: "delete",
  diagnosticMessages: [],
  ...patch,
});

const makeState = (
  messages: ChatMessage[],
): ReplayTrimStateShape<TestCompactionMarker> => ({
  ...buildMessageState(messages),
  conversations: [
    makeConversation({
      id: "conversation",
      last_message: "old",
      message_count: 4,
    }),
    makeConversation({
      id: "other",
      task_id: "other-task",
      last_message: "other",
      message_count: 1,
    }),
  ],
  messageImagesByMessageId: {
    u1: [makeImage("image-kept")],
    a2: [makeImage("image-removed")],
    other1: [makeImage("image-other")],
  },
  questionnaireDraftsByConversationId: {
    conversation: makeDraft(),
    other: makeDraft(),
  },
  sessionCompactionEventsByConversationId: {
    conversation: [
      {
        id: "marker-before",
        status: "completed",
        displayAfterMessageId: "a1",
      },
      {
        id: "marker-after",
        status: "completed",
        displayAfterMessageId: "a2",
      },
    ],
    other: [
      {
        id: "marker-other",
        status: "completed",
        displayAfterMessageId: "other1",
      },
    ],
  },
});

describe("buildReplayTrimStatePatch", () => {
  test("trims only the replay conversation and preserves other conversations", () => {
    const messages = [
      makeMessage({ id: "u1", content: "first", timestamp: "2026-05-16T10:00:00.000Z" }),
      makeMessage({ id: "a1", role: "assistant", content: "answer", timestamp: "2026-05-16T10:01:00.000Z" }),
      makeMessage({ id: "u2", content: "retry", timestamp: "2026-05-16T10:02:00.000Z" }),
      makeMessage({ id: "a2", role: "assistant", content: "removed", timestamp: "2026-05-16T10:03:00.000Z" }),
      makeMessage({ id: "other1", conversation_id: "other", task_id: "other-task", content: "other" }),
    ];

    const result = buildReplayTrimStatePatch({
      state: makeState(messages),
      conversationId: "conversation",
      plan: makePlan(),
      now: () => new Date("2026-05-16T11:00:00.000Z"),
    });

    expect(result.patch.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "other1",
    ]);
    expect(result.patch.conversations.find((item) => item.id === "conversation")).toMatchObject({
      last_message: "retry",
      message_count: 3,
      updated_at: "2026-05-16T11:00:00.000Z",
    });
    expect(result.patch.conversations.find((item) => item.id === "other")).toMatchObject({
      last_message: "other",
      message_count: 1,
    });
  });

  test("prunes removed message images and keeps questionnaire drafts unless asked", () => {
    const messages = [
      makeMessage({ id: "u1" }),
      makeMessage({ id: "a1", role: "assistant" }),
      makeMessage({ id: "u2" }),
      makeMessage({ id: "a2", role: "assistant" }),
      makeMessage({ id: "other1", conversation_id: "other", task_id: "other-task" }),
    ];

    const result = buildReplayTrimStatePatch({
      state: makeState(messages),
      conversationId: "conversation",
      plan: makePlan(),
      clearQuestionnaireSession: false,
    });

    expect(result.patch.messageImagesByMessageId.u1).toHaveLength(1);
    expect(result.patch.messageImagesByMessageId.a2).toBeUndefined();
    expect(result.patch.messageImagesByMessageId.other1).toHaveLength(1);
    expect(result.shouldPersistMessageImages).toBe(true);
    expect(result.patch.questionnaireDraftsByConversationId.conversation).toBeDefined();
    expect(result.patch.questionnaireDraftsByConversationId.other).toBeDefined();
    expect(result.shouldPersistQuestionnaireDrafts).toBe(false);
  });

  test("clears the replay questionnaire draft and replaces session markers from the plan", () => {
    const messages = [
      makeMessage({ id: "u1" }),
      makeMessage({ id: "a1", role: "assistant" }),
      makeMessage({ id: "u2" }),
    ];

    const result = buildReplayTrimStatePatch({
      state: makeState(messages),
      conversationId: "conversation",
      plan: makePlan({ sessionCompactionEvents: undefined }),
      clearQuestionnaireSession: true,
    });

    expect(result.patch.questionnaireDraftsByConversationId.conversation).toBeUndefined();
    expect(result.patch.questionnaireDraftsByConversationId.other).toBeDefined();
    expect(result.shouldPersistQuestionnaireDrafts).toBe(true);
    expect(
      result.patch.sessionCompactionEventsByConversationId.conversation,
    ).toBeUndefined();
    expect(result.patch.sessionCompactionEventsByConversationId.other).toHaveLength(1);
  });
});
