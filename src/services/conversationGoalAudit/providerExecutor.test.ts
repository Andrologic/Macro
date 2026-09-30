import { describe, expect, it, mock } from "bun:test";
import type { StreamingChatOptions } from "../streamingChat";
import { createGoalAuditProviderExecutor, type GoalAuditEffectiveSelection, type GoalAuditReadToolContext } from "./providerExecutor";
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

const selection = { providerId: "provider", modelId: "model", reasoningEffort: undefined };
const resolvedChild = () => ({ id: "conversation-child", runId: "child", parentConversationId: "parent", selection });

const expectPromptAbort = async (pending: Promise<unknown>) => {
  let deadline: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("Abort did not settle promptly.")), 500);
  });
  try {
    await expect(Promise.race([pending, timeout])).rejects.toHaveProperty("name", "AbortError");
  } finally {
    clearTimeout(deadline!);
  }
};

describe("goal auditor provider executor", () => {
  it("streams an isolated child with read tools and progress", async () => {
    const progress: string[] = [];
    const signal = new AbortController().signal;
    const executeReadTool = mock(async (
      _name: string, _args: Record<string, unknown>, _id: string | undefined,
      _signal: AbortSignal, _context: GoalAuditReadToolContext,
    ) => "file contents");
    const resolveChildConversation = mock(async ({ runId, parentConversationId, selection, signal }: {
      runId: string; parentConversationId: string; selection: GoalAuditEffectiveSelection; signal: AbortSignal;
    }) => {
      expect(runId).toBe("child");
      expect(parentConversationId).toBe("parent");
      expect(signal.aborted).toBe(false);
      expect(selection).toEqual({ providerId: "provider", modelId: "model", reasoningEffort: "high" });
      return { ...resolvedChild(), selection };
    });
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", apiKey: "secret", modelId: "model", reasoningEffort: "high" }),
      resolveChildConversation,
      executeReadTool,
      stream: async (options) => {
        expect(options.sessionId).toBe("child");
        expect(options.conversationId).toBe("conversation-child");
        expect(options.internalAgentProfile).toBe("goal_auditor");
        expect(options.reasoningEffort).toBe("high");
        expect(options.apiKey).toBe("secret");
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
        await options.onToolCall?.("read", {
          path: "file.txt", runId: "model-run", parentConversationId: "model-parent",
          childConversationId: "model-child",
        }, "call");
        options.onComplete({ visibleContent: '<think>Private reasoning</think>\n{"verdict":"continue"}', toolTraces: [] });
      },
    });
    const result = await executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal,
      onProgress: (event) => progress.push(event.kind),
    });
    expect(result.text).toBe('{"verdict":"continue"}');
    expect(resolveChildConversation).toHaveBeenCalledTimes(1);
    expect(executeReadTool).toHaveBeenCalledTimes(1);
    expect(executeReadTool).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ path: "file.txt", runId: "model-run" }),
      "call",
      signal,
      { runId: "child", parentConversationId: "parent", childConversationId: "conversation-child" },
    );
    expect(Object.isFrozen(executeReadTool.mock.calls[0][4])).toBe(true);
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

  it("refuses a read if progress changes the resolved child binding", async () => {
    const child = resolvedChild();
    const executeReadTool = mock(async () => "never");
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: () => child,
      executeReadTool,
      stream: async (options) => {
        await expect(options.onToolCall?.("read", { path: "file.txt" })).rejects.toThrow(
          "Invalid goal auditor child conversation binding.",
        );
        options.onComplete({ visibleContent: "{}", toolTraces: [] });
      },
    });
    await executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: new AbortController().signal,
      onProgress: (event) => {
        if (event.kind === "tool_started") child.parentConversationId = "other-parent";
      },
    });
    expect(executeReadTool).not.toHaveBeenCalled();
  });

  it("does not call the read port when progress cancels the audit", async () => {
    const controller = new AbortController();
    const executeReadTool = mock(async () => "never");
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: resolvedChild,
      executeReadTool,
      stream: async (options) => {
        const result = await options.onToolCall?.("read", { path: "file.txt" });
        expect(result).toEqual({ kind: "result", result: "Audit cancelled.", isError: true });
      },
    });
    await expect(executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: controller.signal,
      onProgress: (event) => {
        if (event.kind === "tool_started") controller.abort();
      },
    })).rejects.toHaveProperty("name", "AbortError");
    expect(executeReadTool).not.toHaveBeenCalled();
  });

  it("resolves the provider again after child creation before streaming", async () => {
    const resolveProvider = mock(() => ({
      providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid",
      modelId: "model",
    }));
    const stream = mock(async () => {});
    const executor = createGoalAuditProviderExecutor({
      resolveProvider,
      resolveChildConversation: () => {
        resolveProvider.mockImplementation(() => { throw new Error("Provider changed during child creation."); });
        return resolvedChild();
      },
      executeReadTool: async () => "unused",
      stream,
    });
    await expect(executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: new AbortController().signal,
    })).rejects.toThrow("Provider changed during child creation.");
    expect(resolveProvider).toHaveBeenCalledTimes(2);
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects a changed provider after reservation before streaming", async () => {
    let calls = 0;
    const stream = mock(async () => {});
    const resolveChildConversation = mock(({ runId, parentConversationId, selection }: {
      runId: string; parentConversationId: string; selection: GoalAuditEffectiveSelection;
    }) => ({ id: "conversation-child", runId, parentConversationId, selection }));
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({
        providerId: ++calls === 1 ? "provider-a" : "provider-b",
        providerType: "openai", baseUrl: "https://example.invalid", modelId: "model",
      }),
      resolveChildConversation,
      executeReadTool: async () => "unused",
      stream,
    });
    await expect(executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: new AbortController().signal,
    })).rejects.toThrow("provider changed after child reservation");
    expect(resolveChildConversation.mock.calls[0][0].selection.providerId).toBe("provider-a");
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects a mutated provider object reused by the second resolution", async () => {
    const provider = {
      providerId: "provider", providerType: "openai", baseUrl: "https://first.invalid", modelId: "model",
    };
    const stream = mock(async () => {});
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => provider,
      resolveChildConversation: ({ runId, parentConversationId, selection }) => {
        provider.baseUrl = "https://second.invalid";
        return { id: "conversation-child", runId, parentConversationId, selection };
      },
      executeReadTool: async () => "unused",
      stream,
    });
    await expect(executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: new AbortController().signal,
    })).rejects.toThrow("provider changed after child reservation");
    expect(stream).not.toHaveBeenCalled();
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

  it("settles promptly when provider resolution never completes", async () => {
    const controller = new AbortController();
    const resolveChildConversation = mock(resolvedChild);
    const stream = mock(async () => {});
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: (_input, signal) => {
        expect(signal).toBe(controller.signal);
        return new Promise(() => {});
      },
      resolveChildConversation,
      executeReadTool: async () => "unused",
      stream,
    });
    const pending = executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: controller.signal });
    controller.abort();
    await expectPromptAbort(pending);
    expect(resolveChildConversation).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("settles promptly when child resolution never completes", async () => {
    const controller = new AbortController();
    const stream = mock(async () => {});
    let childStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: ({ signal }) => {
        expect(signal).toBe(controller.signal);
        childStarted();
        return new Promise(() => {});
      },
      executeReadTool: async () => "unused",
      stream,
    });
    const pending = executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: controller.signal });
    await started;
    controller.abort();
    await expectPromptAbort(pending);
    expect(stream).not.toHaveBeenCalled();
  });

  it("settles promptly when streaming ignores abort and suppresses late progress", async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    let streamStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    let callbacks: StreamingChatOptions | undefined;
    const readTool = mock(async () => "unused");
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      resolveChildConversation: resolvedChild,
      executeReadTool: readTool,
      stream: async (options) => {
        callbacks = options;
        streamStarted();
        return new Promise(() => {});
      },
    });
    const pending = executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: controller.signal, onProgress: (event) => progress.push(event.kind) });
    await started;
    controller.abort();
    await expectPromptAbort(pending);
    callbacks?.onToken("late token");
    callbacks?.onToolResult?.("read", "late result");
    await callbacks?.onToolCall?.("read", {});
    callbacks?.onComplete({ visibleContent: "late completion", toolTraces: [] });
    expect(progress).toEqual([]);
    expect(readTool).not.toHaveBeenCalled();
  });
});
