import { describe, expect, it, mock } from "bun:test";
import type { StreamingChatOptions } from "../streamingChat";
import { createGoalAuditProviderExecutor } from "./providerExecutor";
import type { GoalAuditChildInput } from "./types";

const input = (): GoalAuditChildInput => ({
  profile: "goal_auditor",
  systemPrompt: "Inspect the evidence.",
  authorization: {
    agentId: "goal_auditor",
    serializedContext: "Goal and evidence",
    childDepth: 1,
    activeDelegationsForParent: 0,
    policy: {
      capabilities: ["workspace.read", "git.read"],
      limits: { maxChildDepth: 1, maxConcurrencyPerParent: 1, maxContextBytes: 4096, maxTurns: 3 },
    },
  },
});

const resolvedChild = () => ({ id: "conversation-child", runId: "child", parentConversationId: "parent" });

describe("goal auditor provider executor", () => {
  it("streams an isolated child with read tools and progress", async () => {
    const progress: string[] = [];
    const executeReadTool = mock(async () => "file contents");
    const resolveChildConversation = mock(async ({ runId, parentConversationId, signal }: {
      runId: string; parentConversationId: string; signal: AbortSignal;
    }) => {
      expect(runId).toBe("child");
      expect(parentConversationId).toBe("parent");
      expect(signal.aborted).toBe(false);
      return resolvedChild();
    });
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation,
      executeReadTool,
      stream: async (options) => {
        expect(options.sessionId).toBe("child");
        expect(options.conversationId).toBe("conversation-child");
        expect(options.internalAgentProfile).toBe("goal_auditor");
        expect(options.messages).toEqual([
          { role: "system", content: "Inspect the evidence." },
          { role: "user", content: "Goal and evidence" },
        ]);
        expect(options.allowedToolIds).toContain("read");
        expect(options.allowedToolIds).not.toContain("read_file");
        expect(options.allowedToolIds).toContain("git_diff");
        expect(options.allowedToolIds).not.toContain("write");
        expect(options.maxTurns).toBe(3);
        options.onToken("part");
        await options.onToolCall?.("read", { path: "file.txt" }, "call");
        options.onComplete({ visibleContent: '<think>Private reasoning</think>\n{"verdict":"continue"}', toolTraces: [] });
      },
    });
    const result = await executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: new AbortController().signal,
      onProgress: (event) => progress.push(event.kind),
    });
    expect(result.text).toBe('{"verdict":"continue"}');
    expect(resolveChildConversation).toHaveBeenCalledTimes(1);
    expect(executeReadTool).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(["token", "tool_started"]);
  });

  it("refuses a provider tool call outside the read allowlist", async () => {
    const executeReadTool = mock(async () => "never");
    const refused: Array<Awaited<ReturnType<NonNullable<StreamingChatOptions["onToolCall"]>>>> = [];
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: resolvedChild,
      executeReadTool,
      stream: async (options) => {
        refused.push(await options.onToolCall?.("read_file", { path: "attachment.txt" }));
        refused.push(await options.onToolCall?.("write", { path: "file.txt" }));
        options.onComplete({ visibleContent: "{}", toolTraces: [] });
      },
    });
    await executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: new AbortController().signal });
    expect(refused).toEqual([
      expect.objectContaining({ kind: "result", isError: true }),
      expect.objectContaining({ kind: "result", isError: true }),
    ]);
    expect(executeReadTool).not.toHaveBeenCalled();
  });

  it("settles after abort and does not return partial provider output", async () => {
    const controller = new AbortController();
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: resolvedChild,
      executeReadTool: async () => "unused",
      stream: async (options) => {
        controller.abort();
        options.onComplete({ visibleContent: "partial", toolTraces: [] });
      },
    });
    await expect(executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  });

  it("rejects a child with an invalid run or parent binding before streaming", async () => {
    const stream = mock(async () => {});
    for (const child of [
      { ...resolvedChild(), parentConversationId: "other-parent" },
      { ...resolvedChild(), runId: "other-run" },
      { ...resolvedChild(), id: "child" },
      { ...resolvedChild(), id: "" },
    ]) {
      const executor = createGoalAuditProviderExecutor({
        resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
        resolveChildConversation: () => child,
        executeReadTool: async () => "unused",
        stream,
      });
      await expect(executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: new AbortController().signal })).rejects.toThrow("Invalid goal auditor child conversation binding.");
    }
    expect(stream).not.toHaveBeenCalled();
  });

  it("aborts while resolving the child and never starts provider streaming", async () => {
    const controller = new AbortController();
    const stream = mock(async () => {});
    let finishResolution: (child: ReturnType<typeof resolvedChild>) => void = () => {};
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: ({ signal }) => {
        expect(signal).toBe(controller.signal);
        return new Promise((resolve) => { finishResolution = resolve; });
      },
      executeReadTool: async () => "unused",
      stream,
    });
    const pending = executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    finishResolution(resolvedChild());
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(stream).not.toHaveBeenCalled();
  });
});
