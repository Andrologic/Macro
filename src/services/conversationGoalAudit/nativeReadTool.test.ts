import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { GoalAuditorReadInput } from "../ipc/goalAudit";

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

  it("refuses missing context, forged identities, unknown tools and non-object arguments", async () => {
    const call = (name: string, args: Record<string, unknown>, auditContext: typeof context = context) =>
      executeNativeGoalAuditReadTool(name, args, undefined, signal(), auditContext);
    await expect(executeNativeGoalAuditReadTool("read", {}, undefined, signal(), undefined as unknown as typeof context)).rejects.toThrow("context");
    await expect(call("read", { runId: "forged", path: "README.md" })).rejects.toThrow("arguments");
    await expect(call("write", {})).rejects.toThrow("tool");
    await expect(call("read_file", {})).rejects.toThrow("tool");
    await expect(call("read", [] as unknown as Record<string, unknown>)).rejects.toThrow("arguments");
    await expect(call("read", {}, { ...context })).rejects.toThrow("context");
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
