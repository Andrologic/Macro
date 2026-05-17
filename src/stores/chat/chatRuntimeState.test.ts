import { describe, expect, it } from "bun:test";

import type { ConversationRuntimeState } from "../../types";
import {
  buildConversationRuntimePatch,
  buildLegacyStreamingFlags,
  getConversationRuntimeSnapshot,
  isConversationRuntimeActive,
} from "./chatRuntimeState";

const runtime = (
  phase: ConversationRuntimeState["phase"],
): ConversationRuntimeState => ({
  phase,
  sessionId: `${phase}-session`,
  turnId: `${phase}-turn`,
  assistantMessageId: `${phase}-assistant`,
  abortController: new AbortController(),
  lastError: phase === "error" ? "failed" : null,
});

describe("chatRuntimeState", () => {
  it("resolves legacy global flags from per-conversation runtimes", () => {
    const streaming = runtime("streaming");
    const flags = buildLegacyStreamingFlags({
      selectedConversationId: "conv-2",
      conversationRuntimeById: {
        "conv-1": runtime("preparing"),
        "conv-2": streaming,
      },
    });

    expect(flags.isLoading).toBe(true);
    expect(flags.isStreaming).toBe(true);
    expect(flags.sendState).toBe("preparing");
    expect(flags.abortController).toBe(streaming.abortController ?? null);
  });

  it("patches a single conversation runtime while preserving global flags", () => {
    const patch = buildConversationRuntimePatch(
      {
        selectedConversationId: "conv-1",
        conversationRuntimeById: {},
      },
      "conv-1",
      runtime("streaming"),
    );

    expect(patch.conversationRuntimeById["conv-1"]?.phase).toBe("streaming");
    expect(patch.sendState).toBe("streaming");

    const cleared = buildConversationRuntimePatch(
      {
        selectedConversationId: "conv-1",
        conversationRuntimeById: patch.conversationRuntimeById,
      },
      "conv-1",
      null,
    );

    expect(cleared.conversationRuntimeById["conv-1"]).toBeUndefined();
    expect(cleared.sendState).toBe("idle");
  });

  it("distinguishes active and idle runtime phases", () => {
    expect(isConversationRuntimeActive(runtime("preparing"))).toBe(true);
    expect(isConversationRuntimeActive(runtime("overflow_recovery"))).toBe(true);
    expect(isConversationRuntimeActive(runtime("streaming"))).toBe(true);
    expect(isConversationRuntimeActive(runtime("error"))).toBe(false);
    expect(getConversationRuntimeSnapshot({}, null).phase).toBe("idle");
  });
});
