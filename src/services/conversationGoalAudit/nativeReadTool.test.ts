import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { GoalAuditorReadInput } from "../ipc/goalAudit";
import { createGoalAuditProviderExecutor, type GoalAuditReadToolContext } from "./providerExecutor";
import type { GoalAuditChildInput } from "./types";

const executeGoalAuditorRead = mock(async (_input: GoalAuditorReadInput): Promise<string> => "contents");
const isTauriAvailable = mock(() => true);
mock.module("../ipc/goalAudit", () => ({
  executeGoalAuditorRead,
  recordGoalAuditTransition: mock(async () => ({})),
  linkGoalAuditChildConversation: mock(async () => ({})),
}));
mock.module("../ipc/runtime", () => ({
  isTauriAvailable,
  isRemoteBackendAvailable: () => false,
  safeInvoke: async <T>(fn: () => Promise<T>) => fn(),
}));

const { executeNativeGoalAuditReadTool } = await import("./nativeReadTool");
const context = Object.freeze({
  runId: "run-1",
  parentConversationId: "parent-1",
  childConversationId: "child-1",
});
const signal = () => new AbortController().signal;

beforeEach(() => {
  executeGoalAuditorRead.mockClear();
  isTauriAvailable.mockReset();
  isTauriAvailable.mockReturnValue(true);
});

describe("native goal audit read port", () => {
  it("passes only runtime identities to the native command", async () => {
    const args = { path: "README.md" };
    expect(await executeNativeGoalAuditReadTool("read", args, "provider-call", signal(), context))
      .toEqual({ kind: "result", result: "contents" });
    expect(executeGoalAuditorRead).toHaveBeenCalledWith({
      runId: "run-1", parentConversationId: "parent-1", childConversationId: "child-1",
      toolId: "read", args,
    });
    expect(executeGoalAuditorRead.mock.calls[0]?.[0]).not.toHaveProperty("id");
  });

  it("accepts each native read tool", async () => {
    for (const name of [
      "list", "read", "glob", "grep", "ast_grep",
      "git_status", "git_log", "git_branch_list", "git_diff", "git_get_tree",
    ]) {
      await expect(executeNativeGoalAuditReadTool(name, {}, undefined, signal(), context))
        .resolves.toEqual({ kind: "result", result: "contents" });
    }
    expect(executeGoalAuditorRead.mock.calls.map(([input]) => input.toolId)).toEqual([
      "list", "read", "glob", "grep", "ast_grep",
      "git_status", "git_log", "git_branch_list", "git_diff", "git_get_tree",
    ]);
  });

  it("refuses missing context, forged arguments, unknown tools and non-object arguments", async () => {
    const call = (name: string, args: Record<string, unknown>, auditContext: GoalAuditReadToolContext = context) =>
      executeNativeGoalAuditReadTool(name, args, undefined, signal(), auditContext);
    await expect(executeNativeGoalAuditReadTool("read", {}, undefined, signal(), undefined as unknown as typeof context)).rejects.toThrow("context");
    await expect(call("read", { runId: "forged", path: "README.md" })).rejects.toThrow("arguments");
    await expect(call("write", {})).rejects.toThrow("tool");
    await expect(call("read_file", {})).rejects.toThrow("tool");
    await expect(call("read", [] as unknown as Record<string, unknown>)).rejects.toThrow("arguments");
    await expect(call("read", {}, { ...context, runId: " " })).rejects.toThrow("context");
    expect(executeGoalAuditorRead).not.toHaveBeenCalled();
  });

  it("fails closed when Tauri is unavailable", async () => {
    isTauriAvailable.mockReturnValue(false);
    await expect(executeNativeGoalAuditReadTool("read", {}, undefined, signal(), context))
      .rejects.toThrow("Tauri is unavailable");
    expect(executeGoalAuditorRead).not.toHaveBeenCalled();
  });

  it("does not start a cancelled read or return a late native response", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(executeNativeGoalAuditReadTool("read", {}, undefined, cancelled.signal, context))
      .rejects.toHaveProperty("name", "AbortError");
    expect(executeGoalAuditorRead).not.toHaveBeenCalled();

    let finish!: (value: string) => void;
    executeGoalAuditorRead.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = new AbortController();
    const result = executeNativeGoalAuditReadTool("read", {}, undefined, pending.signal, context);
    await Promise.resolve();
    pending.abort();
    await expect(result).rejects.toHaveProperty("name", "AbortError");
    finish("stale contents");
  });

  it("propagates native errors", async () => {
    const error = new Error("Goal auditor run is not active or linked");
    executeGoalAuditorRead.mockRejectedValueOnce(error);
    await expect(executeNativeGoalAuditReadTool("read", {}, undefined, signal(), context))
      .rejects.toBe(error);
  });
});

describe("goal audit executor with native read port", () => {
  const input: GoalAuditChildInput = {
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
  };
  const makeExecutor = (stream: Parameters<typeof createGoalAuditProviderExecutor>[0]["stream"]) =>
    createGoalAuditProviderExecutor({
      resolveProvider: () => ({
        providerId: "provider", providerType: "openai", baseUrl: "https://example.invalid", modelId: "model",
      }),
      resolveChildConversation: ({ runId, parentConversationId }) => ({
        id: "actual-child-conversation", runId, parentConversationId,
      }),
      executeReadTool: executeNativeGoalAuditReadTool,
      stream,
    });

  it("sends the three runtime identities to IPC and rejects identities in provider arguments", async () => {
    const executor = makeExecutor(async (options) => {
      await expect(options.onToolCall?.("read", {
        path: "README.md", runId: "forged-run", parentConversationId: "forged-parent",
        childConversationId: "forged-child",
      })).rejects.toThrow("arguments");
      expect(await options.onToolCall?.("read", { path: "README.md" }, "provider-call"))
        .toEqual({ kind: "result", result: "contents" });
      options.onComplete({ visibleContent: "complete", toolTraces: [] });
    });

    await expect(executor.execute({
      childRunId: "actual-run", parentConversationId: "actual-parent", depth: 1,
      input, signal: signal(),
    })).resolves.toEqual({ text: "complete" });
    expect(executeGoalAuditorRead).toHaveBeenCalledTimes(1);
    expect(executeGoalAuditorRead).toHaveBeenCalledWith({
      runId: "actual-run", parentConversationId: "actual-parent",
      childConversationId: "actual-child-conversation", toolId: "read",
      args: { path: "README.md" },
    });
  });

  it("discards a late IPC response after cancellation", async () => {
    const controller = new AbortController();
    let finishRead!: (value: string) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    executeGoalAuditorRead.mockImplementationOnce(() => {
      readStarted();
      return new Promise<string>((resolve) => { finishRead = resolve; });
    });
    let delivered: unknown;
    let finishStream!: () => void;
    const streamFinished = new Promise<void>((resolve) => { finishStream = resolve; });
    const executor = makeExecutor(async (options) => {
      const pending = options.onToolCall?.("read", { path: "README.md" });
      await started;
      controller.abort();
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      finishRead("stale contents");
      options.onComplete({ visibleContent: "stale completion", toolTraces: [] });
      delivered = await Promise.resolve(pending).catch(() => undefined);
      finishStream();
    });

    await expect(executor.execute({
      childRunId: "actual-run", parentConversationId: "actual-parent", depth: 1,
      input, signal: controller.signal,
    })).rejects.toHaveProperty("name", "AbortError");
    await streamFinished;
    expect(executeGoalAuditorRead).toHaveBeenCalledTimes(1);
    expect(delivered).toBeUndefined();
  });
});
