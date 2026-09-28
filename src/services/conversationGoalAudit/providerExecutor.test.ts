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

describe("goal auditor provider executor", () => {
  it("streams an isolated child with read tools and progress", async () => {
    const progress: string[] = [];
    const executeReadTool = mock(async () => "file contents");
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      executeReadTool,
      stream: async (options) => {
        expect(options.sessionId).toBe("child");
        expect(options.conversationId).toBe("child");
        expect(options.internalAgentProfile).toBe("goal_auditor");
        expect(options.messages).toEqual([
          { role: "system", content: "Inspect the evidence." },
          { role: "user", content: "Goal and evidence" },
        ]);
        expect(options.allowedToolIds).toContain("read_file");
        expect(options.allowedToolIds).toContain("git_diff");
        expect(options.allowedToolIds).not.toContain("write");
        expect(options.maxTurns).toBe(3);
        options.onToken("part");
        await options.onToolCall?.("read_file", { path: "file.txt" }, "call");
        options.onComplete({ visibleContent: '<think>Private reasoning</think>\n{"verdict":"continue"}', toolTraces: [] });
      },
    });
    const result = await executor.execute({
      childRunId: "child", parentConversationId: "parent", depth: 1,
      input: input(), signal: new AbortController().signal,
      onProgress: (event) => progress.push(event.kind),
    });
    expect(result.text).toBe('{"verdict":"continue"}');
    expect(executeReadTool).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(["token", "tool_started"]);
  });

  it("refuses a provider tool call outside the read allowlist", async () => {
    const executeReadTool = mock(async () => "never");
    let refused: Awaited<ReturnType<NonNullable<StreamingChatOptions["onToolCall"]>>> = undefined;
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      executeReadTool,
      stream: async (options) => {
        refused = await options.onToolCall?.("write", { path: "file.txt" });
        options.onComplete({ visibleContent: "{}", toolTraces: [] });
      },
    });
    await executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: new AbortController().signal });
    expect(refused).toMatchObject({ kind: "result", isError: true });
    expect(executeReadTool).not.toHaveBeenCalled();
  });

  it("settles after abort and does not return partial provider output", async () => {
    const controller = new AbortController();
    const executor = createGoalAuditProviderExecutor({
      resolveProvider: () => ({ providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model" }),
      executeReadTool: async () => "unused",
      stream: async (options) => {
        controller.abort();
        options.onComplete({ visibleContent: "partial", toolTraces: [] });
      },
    });
    await expect(executor.execute({ childRunId: "child", parentConversationId: "parent", depth: 1, input: input(), signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  });
});
