import { describe, expect, it } from "bun:test";

import type { ChatMessage } from "../../types";
import {
  buildMessageState,
  findChatMessageInState,
  getConversationMessagesFromState,
  sortMessagesChronologically,
} from "./chatMessageState";

const message = (
  id: string,
  conversationId: string,
  minute: number,
): ChatMessage => ({
  id,
  task_id: "",
  conversation_id: conversationId,
  role: "user",
  content: id,
  timestamp: `2026-05-16T10:${String(minute).padStart(2, "0")}:00.000Z`,
});

describe("chatMessageState", () => {
  it("sorts and indexes messages by conversation", () => {
    const messages = [
      message("c2-a", "conv-2", 3),
      message("c1-b", "conv-1", 2),
      message("c1-a", "conv-1", 1),
    ];

    const state = buildMessageState(messages);

    expect(state.messagesByConversationId["conv-1"]?.map((item) => item.id)).toEqual([
      "c1-a",
      "c1-b",
    ]);
    expect(state.messageIndexById["c2-a"]).toBe(0);
  });

  it("falls back to the flat message list when the conversation index is missing", () => {
    const messages = [
      message("later", "conv-1", 2),
      message("earlier", "conv-1", 1),
    ];

    expect(
      getConversationMessagesFromState(
        { messages, messagesByConversationId: {} },
        "conv-1",
      ).map((item) => item.id),
    ).toEqual(["earlier", "later"]);
    expect(sortMessagesChronologically(messages).map((item) => item.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("finds messages through index, flat fallback, or conversation buckets", () => {
    const indexed = message("indexed", "conv-1", 1);
    const bucketOnly = message("bucket", "conv-2", 2);

    expect(
      findChatMessageInState(
        {
          messages: [indexed],
          messageIndexById: { indexed: 0 },
          messagesByConversationId: { "conv-2": [bucketOnly] },
        },
        "indexed",
      )?.id,
    ).toBe("indexed");
    expect(
      findChatMessageInState(
        {
          messages: [indexed],
          messageIndexById: {},
          messagesByConversationId: { "conv-2": [bucketOnly] },
        },
        "bucket",
      )?.id,
    ).toBe("bucket");
  });
});
