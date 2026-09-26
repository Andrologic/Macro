import { describe, expect, it } from "bun:test";
import type { ChatMessage, ConversationCompactionState } from "../types";
import {
  cloneStreamMessage,
  normalizeMessagesForProviderContext,
  shouldCountProviderInputItemsForContext,
} from "./chatStreamCompactionMessages";
import type { ContextBudgetPolicy } from "./contextCompaction";
import type { StreamMessage } from "./streamingChat";
import {
  createChatStreamCompaction,
  type ChatStreamCompactionParams,
  type ChatStreamCompactionPorts,
} from "./chatStreamCompaction";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const fixture = () => {
  const params: ChatStreamCompactionParams = {
    conversationId: "conversation", assistantMessageId: "assistant-current",
    resolvedTaskId: "task", selectedProviderId: "provider", selectedModelId: "model",
    providerConfig: { providerType: "openai", baseUrl: "https://example.invalid" },
    projectIdentity: "project:project", citations: [],
  };
  const preparedMessages: StreamMessage[] = [
    { role: "user", content: "old request ".repeat(400) },
    { role: "assistant", content: "old answer ".repeat(400) },
    { role: "user", content: "second request ".repeat(100) },
    { role: "assistant", content: "second answer ".repeat(100) },
    { role: "user", content: "new request" },
    { role: "tool", content: "recent result", tool_call_id: "tool-current" },
  ];
  const orderedMessages: ChatMessage[] = preparedMessages.map((message, index) => ({
    id: index === preparedMessages.length - 1 ? params.assistantMessageId : `real-${index}`,
    conversation_id: params.conversationId, task_id: params.resolvedTaskId,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content as string,
    timestamp: `2026-05-16T10:00:0${index}.000Z`,
    ...(index === preparedMessages.length - 1 ? { completion_reason: "stop" as const } : {}),
  }));
  const request = {
    messages: [{ role: "system", content: "You are Macro." }, ...preparedMessages] as StreamMessage[],
    turnCount: 2, toolResultCount: 1,
  };
  const owner = { streaming: true, completion: true, aborted: false };
  const projections: string[] = [];
  const events: Parameters<ChatStreamCompactionPorts["persistence"]["recordConversationCompactionEvent"]>[0][] = [];
  const checkpoints: ConversationCompactionState[] = [];
  const calls = { summary: 0, prepare: 0, tools: 0, budget: 0 };
  const ports: ChatStreamCompactionPorts = {
    policy: {
      shouldAcceptStreamUpdate: () => owner.streaming,
      stillOwnsCompletionConsolidation: () => owner.completion,
      isAbortSignalAborted: () => owner.aborted,
      loadContextBudgetPolicy: async () => { calls.budget++; return {}; },
      generateSummary: async () => { calls.summary++; return "Useful compacted summary."; },
      estimateSerializedPayloadTokens: () => 3500,
    },
    read: {
      getFootprintFields: () => ({
        modelContextWindowTokens: 5000, outputLimitTokens: 500,
        contextLimitSource: "provider_metadata", isContextLimitAuthoritative: true,
        contextLimitConfidence: "verified",
      }),
      getToolDefinitions: () => { calls.tools++; return []; },
      getCompactionStatus: () => null,
      prepareMessagesForRequest: async () => {
        calls.prepare++;
        return { systemMessage: "You are Macro.", preparedMessages, orderedMessages, citations: [] };
      },
    },
    projection: {
      markConversationCompactionStarted: () => { projections.push("started"); },
      completeLatestSessionCompactionEvent: () => { projections.push("completed"); },
      clearLatestRunningSessionCompactionEvent: () => { projections.push("cleared"); },
      setConversationCompactionStatus: (_id, status) => { projections.push(status?.phase ?? "restored"); },
      info: (message) => { projections.push(message); },
    },
    persistence: {
      persistConversationCompactionState: async (state) => { checkpoints.push(state); },
      recordConversationCompactionEvent: async (event) => { events.push(event); },
    },
  };
  return { params, ports, request, owner, projections, events, checkpoints, calls,
    runtime: createChatStreamCompaction(params, ports) };
};

describe("chat stream tool-boundary compaction", () => {
  it("keeps the synthetic checkpoint transient and consolidates once under the completion owner", async () => {
    const f = fixture();
    const result = await f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    expect(result?.compacted).toBe(true);
    expect(f.checkpoints).toEqual([]);
    expect(f.events[0].metadata?.checkpointDecision).toBe("transient");
    expect(f.projections.slice(0, 2)).toEqual(["started", "completed"]);
    // Completion has a different canonical owner than the active stream.
    f.owner.streaming = false;
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.checkpoints).toHaveLength(1);
    expect(f.checkpoints[0].upToMessageId).toMatch(/^real-/);
    expect(f.events[1].metadata?.result).toBe("tool_boundary_consolidation");
    expect(f.events[1].metadata?.completionReason).toBe("stop");
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.checkpoints).toHaveLength(1);
    expect(f.calls.prepare).toBe(1);
  });

  it("does nothing without a tool batch or enough prepared messages", async () => {
    const f = fixture();
    await f.runtime.compactFollowUpMessagesBeforeProviderRequest({ ...f.request, toolResultCount: 0 });
    await f.runtime.compactFollowUpMessagesBeforeProviderRequest({ ...f.request, messages: f.request.messages.slice(0, 3) });
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.calls.budget).toBe(0);
    expect(f.events).toEqual([]);
  });

  for (const invalidation of ["streaming", "aborted"] as const) {
    it(`drops a delayed budget after ${invalidation} invalidation`, async () => {
      const f = fixture();
      const budget = deferred<ContextBudgetPolicy>();
      f.ports.policy.loadContextBudgetPolicy = () => budget.promise;
      const running = f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
      if (invalidation === "streaming") f.owner.streaming = false;
      else f.owner.aborted = true;
      budget.resolve({});
      expect(await running).toBeUndefined();
      expect(f.calls.tools).toBe(0);
      expect(f.projections).toEqual([]);
      expect(f.events).toEqual([]);
    });
  }

  it("drops a delayed summary without publishing or keeping a pending checkpoint", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const summary = deferred<string>();
    f.ports.policy.generateSummary = () => { entered.resolve(); return summary.promise; };
    const running = f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    await entered.promise;
    f.owner.streaming = false;
    summary.resolve("Old stream summary.");
    expect(await running).toBeUndefined();
    expect(f.projections).toEqual(["started"]);
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.events).toEqual([]);
    expect(f.calls.prepare).toBe(0);
  });

  it("does not return provider messages after a delayed audit loses ownership", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const audit = deferred<void>();
    f.ports.persistence.recordConversationCompactionEvent = () => { entered.resolve(); return audit.promise; };
    const running = f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    await entered.promise;
    f.owner.streaming = false;
    audit.resolve();
    expect(await running).toBeUndefined();
  });

  it("suppresses stale asynchronous failures but propagates current failures", async () => {
    const f = fixture();
    const budget = deferred<ContextBudgetPolicy>();
    f.ports.policy.loadContextBudgetPolicy = () => budget.promise;
    const running = f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    f.owner.streaming = false;
    budget.reject(new Error("late read"));
    expect(await running).toBeUndefined();
    f.owner.streaming = true;
    await expect(f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request)).rejects.toThrow("late read");
  });

  for (const boundary of ["budget", "prepare", "summary", "persist"] as const) {
    it(`fences completion after delayed ${boundary} and consumes the pending checkpoint once`, async () => {
      const f = fixture();
      await f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
      const entered = deferred<void>();
      const release = deferred<void>();
      const pause = async () => { entered.resolve(); await release.promise; };
      if (boundary === "budget") f.ports.policy.loadContextBudgetPolicy = async () => { await pause(); return {}; };
      if (boundary === "prepare") {
        const prepare = f.ports.read.prepareMessagesForRequest;
        f.ports.read.prepareMessagesForRequest = async () => { await pause(); return prepare(); };
      }
      if (boundary === "summary") f.ports.policy.generateSummary = async () => { await pause(); return "Late summary."; };
      if (boundary === "persist") f.ports.persistence.persistConversationCompactionState = async () => { await pause(); };
      const running = f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
      await entered.promise;
      f.owner.completion = false;
      release.resolve();
      await running;
      expect(f.events).toHaveLength(1);
      expect(f.checkpoints).toEqual([]);
      if (boundary === "budget") expect(f.calls.prepare).toBe(0);
      f.owner.completion = true;
      await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
      expect(f.events).toHaveLength(1);
    });
  }

  it("preserves a failed compaction audit and restores the previous projection", async () => {
    const f = fixture();
    f.ports.projection.markConversationCompactionStarted = () => {
      throw new Error("context_length_exceeded");
    };
    await expect(f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request))
      .rejects.toThrow("context_length_exceeded");
    expect(f.events[0].errorCode).toBe("context_overflow");
    expect(f.events[0].metadata?.result).toBe("tool_boundary_compaction_error");
    expect(f.projections).toEqual(["cleared", "restored"]);
  });

  it("audits a hard stop after compaction and never queues its checkpoint", async () => {
    const f = fixture();
    let estimates = 0;
    f.ports.policy.estimateSerializedPayloadTokens = () => ++estimates <= 2 ? 3500 : 10000;
    await expect(f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request))
      .rejects.toThrow("too large");
    expect(f.events[0].status).toBe("blocked");
    expect(f.events[0].metadata?.result).toBe("tool_boundary_context_too_large");
    expect(f.projections).toContain("too_large");
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.calls.prepare).toBe(0);
  });

  it("preserves the manual-compaction requirement", async () => {
    const f = fixture();
    f.ports.policy.loadContextBudgetPolicy = async () => ({ auto: false });
    f.ports.policy.estimateSerializedPayloadTokens = () => 4950;
    await expect(f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request))
      .rejects.toThrow("manual");
    expect(f.projections).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it("audits failed consolidation without persisting a synthetic checkpoint", async () => {
    const f = fixture();
    await f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    const prepare = f.ports.read.prepareMessagesForRequest;
    f.ports.read.prepareMessagesForRequest = async () => {
      const request = await prepare();
      const oversizedUser = "x".repeat(20000);
      request.preparedMessages[4] = { role: "user", content: oversizedUser };
      request.orderedMessages[4] = { ...request.orderedMessages[4], content: oversizedUser };
      return request;
    };
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.checkpoints).toEqual([]);
    expect(f.events[1].errorCode).toBe("tool_boundary_consolidation_failed");
    expect(f.events[1].metadata?.result).toBe("tool_boundary_consolidation_failed");
    expect(f.projections.at(-1)).toContain("consolidation failed");
  });

  it("skips consolidation when the durable assistant is missing", async () => {
    const f = fixture();
    await f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    const prepare = f.ports.read.prepareMessagesForRequest;
    f.ports.read.prepareMessagesForRequest = async () => {
      const request = await prepare();
      return { ...request, orderedMessages: request.orderedMessages.slice(0, -1) };
    };
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.checkpoints).toEqual([]);
    expect(f.events).toHaveLength(1);
    expect(f.projections.at(-1)).toContain("assistant_message_missing");
  });

  it("aborts consolidation before requesting durable messages", async () => {
    const f = fixture();
    await f.runtime.compactFollowUpMessagesBeforeProviderRequest(f.request);
    f.owner.aborted = true;
    await f.runtime.consolidatePendingToolBoundaryCompactionAfterPersistence();
    expect(f.calls.prepare).toBe(0);
    expect(f.checkpoints).toEqual([]);
  });
});

it("preserves multimodal metadata and isolates provider items in pending message copies", () => {
  const message: StreamMessage = {
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    image_metadata: [{ width: 120, height: 90 }],
    provider_input_items: [{ nested: { text: "provider context" } }],
  };
  const copy = cloneStreamMessage(message);
  expect(copy).toEqual(message);
  expect(copy.provider_input_items?.[0]).not.toBe(message.provider_input_items?.[0]);
  expect(copy.image_metadata?.[0]).not.toBe(message.image_metadata?.[0]);
  const normalized = normalizeMessagesForProviderContext("copilot", [copy]);
  expect(normalized[0].provider_input_items).toBeUndefined();
  expect(normalized[0].image_metadata).toEqual(message.image_metadata);
  expect(shouldCountProviderInputItemsForContext("copilot")).toBe(false);
  const messages = [message];
  expect(normalizeMessagesForProviderContext("openai", messages)).toBe(messages);
});
