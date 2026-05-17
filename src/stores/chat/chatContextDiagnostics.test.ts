import { describe, expect, it } from "bun:test";

import type { ChatMessage } from "../../types";
import { estimateConversationFootprint } from "../../services/contextCompaction";
import type { StreamMessage } from "../../services/streamingChat";
import {
  buildContextDiagnosticsFromFootprint,
  countPreparedToolContextLines,
  inspectProviderInputValue,
} from "./chatContextDiagnostics";

const message = (
  id: string,
  role: "user" | "assistant",
  content: string,
): ChatMessage => ({
  id,
  task_id: "task-1",
  conversation_id: "conv-1",
  role,
  content,
  timestamp: "2026-05-16T10:00:00.000Z",
});

describe("chatContextDiagnostics", () => {
  it("builds diagnostics counts and top contributors from a footprint", () => {
    const orderedMessages = [
      message("u1", "user", "read file"),
      message("a1", "assistant", "done"),
    ];
    const preparedMessages: StreamMessage[] = [
      {
        role: "user",
        content: "read file",
      },
      {
        role: "assistant",
        content: "<tool_context>line 1\nline 2</tool_context>",
      },
    ];
    const footprint = estimateConversationFootprint({
      systemMessage: "You are Macro.",
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 128_000,
      outputLimitTokens: 8_000,
      contextLimitSource: "provider_metadata",
      isContextLimitAuthoritative: true,
      contextLimitConfidence: "verified",
      mode: "blocking",
    });

    const diagnostics = buildContextDiagnosticsFromFootprint({
      conversationId: "conv-1",
      status: "ready",
      orderedMessages,
      preparedMessages,
      citations: [],
      footprintAfter: footprint,
    });

    expect(diagnostics.counts.messages).toBe(2);
    expect(diagnostics.counts.hiddenContextLines).toBe(2);
    expect(diagnostics.breakdown.map((item) => item.id)).toContain(
      "hidden_context",
    );
    expect(diagnostics.topContributors.length).toBeGreaterThan(0);
  });

  it("inspects provider input reasoning and tool result lines", () => {
    expect(
      inspectProviderInputValue({
        reasoning: "first\nsecond",
        output: "tool result",
      }),
    ).toEqual({ reasoningLines: 2, toolResultLines: 1 });
    expect(
      countPreparedToolContextLines([
        { role: "assistant", content: "<tool_context>a\nb</tool_context>" },
      ]),
    ).toBe(2);
  });
});
