import { describe, expect, test } from "bun:test";
import { createChatCompactionRuntime, type ChatCompactionRuntimeState } from "./chatCompactionRuntime";
import type { ConversationCompactionState } from "../types";

const makeCompactionState = (
  conversationId = "conversation",
): ConversationCompactionState => ({
  conversationId,
  upToMessageId: "m1",
  summaryText: "summary",
  toolDigest: [],
  usedSourcePassageIds: [],
  interestingSourcePassageIds: [],
  estimatedTokensBefore: 100,
  estimatedTokensAfter: 20,
  fingerprint: "fingerprint",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prunedToolContextMessageIds: [],
});

describe("chatCompactionRuntime", () => {
  test("does not overwrite transient status with persisted state", () => {
    let state: ChatCompactionRuntimeState = {
      conversationCompactionStatusById: {},
      sessionCompactionEventsByConversationId: {},
    };
    const runtime = createChatCompactionRuntime({
      getState: () => state,
      setState: (updater) => {
        state = { ...state, ...updater(state) };
      },
      getLastConversationMessageId: () => "m1",
    });

    runtime.setConversationCompactionActivityStarted("conversation", "manual");
    runtime.publishPersistedCompactionStatusIfIdle(
      "conversation",
      makeCompactionState(),
    );

    expect(state.conversationCompactionStatusById.conversation?.phase).toBe(
      "compacting",
    );
  });

  test("keeps a session event at the visual anchor and completes it", () => {
    let state: ChatCompactionRuntimeState = {
      conversationCompactionStatusById: {},
      sessionCompactionEventsByConversationId: {},
    };
    const runtime = createChatCompactionRuntime({
      getState: () => state,
      setState: (updater) => {
        state = { ...state, ...updater(state) };
      },
      getLastConversationMessageId: () => "fallback",
    });

    runtime.markConversationCompactionStarted(
      "conversation",
      "safety_prestream",
      null,
      "user-message",
    );
    runtime.completeLatestSessionCompactionEvent(
      "conversation",
      makeCompactionState(),
      "safety_prestream",
    );

    expect(
      state.sessionCompactionEventsByConversationId.conversation?.[0]
        ?.displayAfterMessageId,
    ).toBe("user-message");
    expect(
      state.sessionCompactionEventsByConversationId.conversation?.[0]?.status,
    ).toBe("completed");
  });
});
