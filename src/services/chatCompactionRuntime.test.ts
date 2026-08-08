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

  test("clears the conversation event key when no event remains", () => {
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

    runtime.startSessionCompactionEvent("conversation", "manual", "m1");
    runtime.clearLatestRunningSessionCompactionEvent("conversation", "manual");

    expect(
      Object.prototype.hasOwnProperty.call(
        state.sessionCompactionEventsByConversationId,
        "conversation",
      ),
    ).toBe(false);
  });

  test("publishes a final checkpoint status when no transient phase is active", () => {
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

    runtime.publishPersistedCompactionStatusIfIdle(
      "conversation",
      makeCompactionState(),
    );

    expect(state.conversationCompactionStatusById.conversation?.phase).toBe(
      "compacted",
    );
    expect(state.conversationCompactionStatusById.conversation?.upToMessageId).toBe(
      "m1",
    );
  });

  test("uses the last visible message as the fallback visual anchor", () => {
    let state: ChatCompactionRuntimeState = {
      conversationCompactionStatusById: {},
      sessionCompactionEventsByConversationId: {},
    };
    const runtime = createChatCompactionRuntime({
      getState: () => state,
      setState: (updater) => {
        state = { ...state, ...updater(state) };
      },
      getLastConversationMessageId: () => "last-visible-message",
    });

    runtime.startSessionCompactionEvent("conversation", "manual");

    expect(
      state.sessionCompactionEventsByConversationId.conversation?.[0]
        ?.displayAfterMessageId,
    ).toBe("last-visible-message");
  });
});
