import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatMessage, ConversationApprovalGrant, PendingToolApproval, ToolRiskLevel } from "../types";
import type { ChatToolExecutionPorts, PendingToolApprovalResolution } from "./chatToolExecutionContracts";
import type { FrozenToolCallContext } from "./chatStreamContracts";
import type { ScopedTurnConfiguration } from "./configurationClient";
import type { TerminalSessionDto } from "./tauriIpc";
import { EMPTY_CONVERSATION_RUNTIME } from "../domains/chat/runtimeState";
import { buildMCPToolId } from "./mcp/identifiers";

// Mock only IO services. The runtime imports no store or UI, even without these mocks.
const configuration = await import("./configurationClient");
const recovery = await import("./toolApprovalRecovery");
const loadConfiguration = mock(async (): Promise<ScopedTurnConfiguration | null> => null);
const saveRecovery = mock(async (_id: string, _approval: PendingToolApproval | null): Promise<void> => { });
mock.module("./configurationClient", () => ({ ...configuration, loadScopedTurnConfiguration: loadConfiguration }));
mock.module("./toolApprovalRecovery", () => ({ ...recovery, persistToolApprovalRecovery: saveRecovery }));
const { createChatToolExecution } = await import("./chatToolExecution");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const checkpoint = () => new Promise<void>((done) => setImmediate(done));
const terminalSession: TerminalSessionDto = {
  id: "terminal", project_id: null, project_name: null, mount_name: null, workspace_path: null,
  cwd: "/workspace", status: "idle", last_command: null, output: "ok", exit_code: 0,
  timed_out: false, output_truncated: false, updated_at: "2026-01-01T00:00:00Z",
};

function setup(tool = "read", riskLevel: ToolRiskLevel = "yolo") {
  const abort = new AbortController();
  const operation: FrozenToolCallContext = {
    conversationId: "conversation", sessionId: "session", turnId: "turn", assistantMessageId: "assistant",
    mode: "Implement", agentType: "build", taskId: "task", signal: abort.signal,
    executionContext: {
      groupId: null, groupName: null, projectId: "project", projectName: "Project", projectIds: ["project"],
      actionableProjectIds: ["project"], contextProjectIds: [], focusedProjectId: "project",
      projectMounts: [], virtualRootEnabled: false, workspacePathsByProjectId: { project: "/workspace" },
      defaultWorkspacePath: "/workspace", workspacePath: "/workspace", taskId: "task", branchName: "develop",
    },
    allowedToolIds: [tool], scopedTurnConfiguration: null, mcpServers: [], riskLevel,
  };
  const runtime = {
    ...EMPTY_CONVERSATION_RUNTIME, phase: "streaming" as const,
    sessionId: "session", turnId: "turn", assistantMessageId: "assistant"
  };
  const message: ChatMessage = {
    id: "assistant", conversation_id: "conversation", task_id: "task",
    role: "assistant", content: "", timestamp: "2026-01-01T00:00:00Z"
  };
  const events: string[] = [];
  const pending = new Map<string, PendingToolApproval>();
  const grants = new Map<string, ConversationApprovalGrant[]>();
  let epoch = 0;
  const executor = {
    resolveMutatingToolApprovalScope: mock(() => null),
    resolveExplicitMutatingToolProjectTargets: mock(() => [] as string[]),
    executeWorkspaceTool: mock<Awaited<ReturnType<ChatToolExecutionPorts["workspace"]["executor"]>>["executeWorkspaceTool"]>(async () => "workspace result"),
  };
  const ports: ChatToolExecutionPorts = {
    runtime: {
      read: () => runtime,
      messages: () => [message],
      updateTrace: mock((_id, _call, status) => { events.push(`trace:${status}`); }),
      persistPartial: mock(async () => { events.push("persist"); }),
    },
    approvals: {
      get epoch() { return epoch; },
      resolvers: new Map(), mutationVersions: new Map(), challenges: new Set(),
      serialize: async (_id, run) => run(),
      pending: (id) => pending.get(id),
      publish: (id, value, expected) => {
        if (expected && pending.get(id) !== expected) return;
        events.push(value ? `publish:${value.recoveryState ?? "pending"}` : "clear");
        if (value) pending.set(id, value);
        else pending.delete(id);
      },
      grants: (id) => grants.get(id) ?? [],
      writeGrants: (id, value) => { grants.set(id, value); },
    },
    policy: {
      isSourceToolEnabled: mock(async () => true),
      executionContext: () => operation.executionContext,
      loadRiskLevel: async () => riskLevel,
      mcpRuntime: () => ({ servers: [...operation.mcpServers], tools: operation.mcpServers.flatMap((s) => s.tools ?? []) }),
      resolveMcpRuntime: mock(async () => ({ servers: [], tools: [], failures: [] })),
      isPlanReplicaDivergence: (_error): _error is never => false,
      webConfig: () => ({ enableWebSearch: false, enableWebFetch: false, webSearchOptions: undefined }),
    },
    sources: {
      readFile: mock(async () => "file"), readSources: mock(async () => "sources"), editSource: mock(async () => "edited"),
      containsPassage: mock(async () => true), addWebCitations: mock(() => { }),
      addCitation: mock(() => "citation"), addSourcePassage: mock(() => "passage"),
    },
    handlers: {
      configVirtualScope: mock(async () => undefined), skill: mock(async () => undefined),
      mcp: mock(async () => "mcp result"), taskTodo: mock(async () => undefined),
      taskArtifact: mock(async () => undefined), architect: mock(async () => undefined),
    },
    terminal: {
      cachedSession: () => terminalSession,
      createSession: mock(async () => terminalSession), readSession: mock(async () => terminalSession),
      runCommand: mock(async () => terminalSession), killSession: mock(async () => terminalSession),
    },
    workspace: {
      executor: async () => executor,
      resolvePromotion: mock(() => ({ task: undefined, projectIds: [], unavailableResult: null })),
      promote: mock(async () => null), recordCheckpoint: mock(async () => { }),
    },
  };
  saveRecovery.mockImplementation(async (_id, approval) => { events.push(approval ? "marker:open" : "marker:closed"); });
  const execute = createChatToolExecution(ports);
  const run = (args: Record<string, unknown> = {}) => execute(operation, tool, args, "call");
  const resolve = (decision: PendingToolApprovalResolution) => {
    const resolver = ports.approvals.resolvers.get("conversation::call");
    expect(resolver).toBeDefined();
    resolver!(decision);
  };
  return {
    ports, operation, runtime, abort, pending, grants, events, executor, execute, run, resolve,
    resetEpoch: () => { epoch += 1; }
  };
}

beforeEach(() => {
  loadConfiguration.mockReset();
  loadConfiguration.mockImplementation(async () => null);
  saveRecovery.mockReset();
});

describe("chat tool execution policy and frozen ownership", () => {
  test("blocks obsolete sessions before routing and when source policy finishes late", async () => {
    const f = setup();
    f.runtime.sessionId = "new-session";
    expect(await f.run()).toMatchObject({ errorKind: "aborted" });
    expect(f.ports.policy.isSourceToolEnabled).not.toHaveBeenCalled();
    f.runtime.sessionId = "session";
    const enabled = deferred<boolean>();
    f.ports.policy.isSourceToolEnabled = () => enabled.promise;
    const running = f.run();
    f.runtime.turnId = "new-turn";
    enabled.resolve(true);
    expect(await running).toMatchObject({ errorKind: "aborted" });
    expect(f.executor.executeWorkspaceTool).not.toHaveBeenCalled();
  });

  test("enforces the frozen allowlist, project restriction, and Implement plan policy", async () => {
    const f = setup("write");
    f.operation.allowedToolIds = [];
    expect(await f.run()).toMatchObject({ errorKind: "permission" });
    f.operation.allowedToolIds = ["write"];
    f.operation.scopedTurnConfiguration = {
      projectIds: ["project"], focusProjectId: "project", riskLevel: "yolo",
      maxTurns: null, models: {}, builtInTools: { write: false }, modeTools: {}, allowedMcpServerIds: [], mcpServers: {}
    };
    expect(await f.run()).toMatchObject({ errorKind: "permission" });
    f.operation.scopedTurnConfiguration = null;
    f.operation.agentType = "plan";
    expect(await f.run()).toMatchObject({ errorKind: "permission", result: expect.stringContaining("read-only") });
    expect(f.ports.runtime.updateTrace).toHaveBeenLastCalledWith("assistant", "call", "denied");
    expect(f.executor.executeWorkspaceTool).not.toHaveBeenCalled();
  });

  test("keeps the Git challenge per turn and normalizes Architect aliases before routing", async () => {
    const f = setup("git_add");
    expect(await f.run({ path: "src" })).toMatchObject({ errorKind: "permission", result: expect.stringContaining("explicitly asked") });
    expect(await f.run({ path: "src" })).toBe("workspace result");
    f.operation.turnId = f.runtime.turnId = "next-turn";
    expect(await f.run({ path: "src" })).toMatchObject({ errorKind: "permission" });
    f.operation.mode = "Architect";
    f.operation.allowedToolIds = ["plan_get"];
    f.ports.handlers.architect = mock(async () => "plan");
    expect(await f.execute(f.operation, "get_plan", {}, "alias")).toBe("plan");
    expect(f.ports.handlers.architect).toHaveBeenCalledWith({ assistantMessageId: "assistant", toolName: "plan_get", args: {} });
  });

  test("suppresses late source marking and checks cancellation between legacy handlers", async () => {
    const f = setup("mark_source_passage");
    f.operation.mode = "Chat";
    const contains = deferred<boolean>();
    f.ports.sources.containsPassage = () => contains.promise;
    const running = f.run({ title: "A source", passage: "An observed passage" });
    await checkpoint();
    f.abort.abort();
    contains.resolve(true);
    expect(await running).toMatchObject({ errorKind: "aborted" });
    expect(f.ports.sources.addSourcePassage).not.toHaveBeenCalled();
    const g = setup();
    g.ports.handlers.configVirtualScope = async () => { g.abort.abort(); return undefined; };
    expect(await g.run()).toMatchObject({ errorKind: "aborted" });
    expect(g.ports.handlers.skill).not.toHaveBeenCalled();
    expect(g.executor.executeWorkspaceTool).not.toHaveBeenCalled();
  });

  test("promotes only the frozen context and retains checkpoint and invocation identities", async () => {
    const f = setup("write");
    f.operation.executionContext.contextProjectIds = ["context"];
    f.ports.workspace.resolvePromotion = () => ({ task: { id: "task" }, projectIds: ["context"], unavailableResult: null });
    f.ports.workspace.promote = mock(async () => ({ promotedProjectIds: ["context"] }));
    f.ports.policy.executionContext = () => ({ ...f.operation.executionContext, workspacePath: "/other-selection" });
    f.executor.executeWorkspaceTool.mockImplementation(async (_name, _args, _mode, options) => {
      expect(options?.workspacePath).toBe("/workspace");
      expect(options?.signal).toBe(f.abort.signal);
      expect(options?.invocationId).toBe("conversation:turn:call");
      await options?.onCodeCheckpoint?.({ toolName: "write", files: [] });
      return "written";
    });
    expect(await f.run({ path: "file.ts" })).toContain('"promoted_project_ids":["context"]');
    expect(f.operation.executionContext.contextProjectIds).toEqual(["context"]);
    expect(f.ports.workspace.recordCheckpoint).toHaveBeenCalledWith({
      conversationId: "conversation", turnId: "turn",
      assistantMessageId: "assistant", toolCallId: "call", toolName: "write", files: []
    });
  });

  test("does not execute a workspace tool when promotion finishes after stop", async () => {
    const f = setup("write");
    f.ports.workspace.resolvePromotion = () => ({ task: { id: "task" }, projectIds: ["context"], unavailableResult: null });
    f.ports.workspace.promote = async () => { f.abort.abort(); return { promotedProjectIds: ["context"] }; };
    expect(await f.run({ path: "file.ts" })).toMatchObject({ errorKind: "aborted" });
    expect(f.executor.executeWorkspaceTool).not.toHaveBeenCalled();
  });
});

describe("durable tool approvals", () => {
  test("terminal_run always asks, persists before publishing, and never remembers permission", async () => {
    const f = setup("terminal_run");
    const running = f.run({ session_id: "terminal", command: "pwd" });
    await checkpoint();
    expect(f.events).toEqual(["trace:pending_approval", "persist", "marker:open", "publish:pending"]);
    expect(f.ports.terminal.runCommand).not.toHaveBeenCalled();
    expect(f.pending.get("conversation")?.canApproveForConversation).toBe(false);
    f.resolve({ kind: "allow_conversation" });
    expect(JSON.parse(String(await running)).output).toBe("ok");
    expect(f.events.slice(4)).toEqual(["trace:denied", "persist", "marker:closed", "clear", "trace:running"]);
    expect(f.grants.size).toBe(0);
    expect(f.ports.approvals.resolvers.size).toBe(0);
  });

  test.each(["workspace", "risk", "disabled"])("denies approval after %s policy changes", async (change) => {
    const f = setup("terminal_run");
    const running = f.run({ session_id: "terminal", command: "pwd" });
    await checkpoint();
    if (change === "workspace") f.ports.policy.executionContext = () => ({ ...f.operation.executionContext, workspacePath: "/other" });
    if (change === "risk") f.ports.policy.loadRiskLevel = async () => "strict";
    if (change === "disabled") f.ports.policy.isSourceToolEnabled = async () => false;
    f.resolve({ kind: "allow_once" });
    expect(await running).toMatchObject({ errorKind: "permission", result: expect.stringContaining("policy or workspace changed") });
    expect(f.ports.terminal.runCommand).not.toHaveBeenCalled();
    expect(f.pending.size).toBe(0);
  });

  test("a refusal during closing persistence wins over an earlier allowance", async () => {
    const f = setup("terminal_run");
    const closing = deferred<void>();
    const running = f.run({ session_id: "terminal", command: "pwd" });
    await checkpoint();
    f.ports.runtime.persistPartial = () => closing.promise;
    f.resolve({ kind: "allow_once" });
    await checkpoint();
    f.resolve({ kind: "deny", reason: "Cancel this command" });
    closing.resolve();
    expect(await running).toMatchObject({ errorKind: "permission", result: expect.stringContaining("Cancel this command") });
    expect(f.ports.terminal.runCommand).not.toHaveBeenCalled();
  });

  test("keeps an interrupted approval if closing persistence fails", async () => {
    const f = setup("terminal_run");
    const running = f.run({ session_id: "terminal", command: "pwd" });
    await checkpoint();
    f.ports.runtime.persistPartial = async () => { throw new Error("disk unavailable"); };
    f.resolve({ kind: "allow_once" });
    await expect(running).rejects.toThrow("disk unavailable");
    expect(f.pending.get("conversation")).toMatchObject({ recoveryState: "interrupted", canApproveForConversation: false });
    expect(f.events).not.toContain("marker:closed");
    expect(f.ports.terminal.runCommand).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ errorKind: "permission", result: expect.stringContaining("interrupted") });
  });

  test("epoch reset expires old approval without deleting a replacement resolver", async () => {
    const f = setup("terminal_run");
    const running = f.run({ session_id: "terminal", command: "pwd" });
    await checkpoint();
    f.resolve({ kind: "allow_once" });
    f.resetEpoch();
    const replacement = mock(() => { });
    f.ports.approvals.resolvers.set("conversation::call", replacement);
    expect(await running).toMatchObject({ errorKind: "aborted" });
    expect(f.ports.approvals.resolvers.get("conversation::call")).toBe(replacement);
    expect(f.ports.terminal.runCommand).not.toHaveBeenCalled();
  });

  test("revalidates MCP identity and remembers only an unchanged approved tool", async () => {
    const tool = buildMCPToolId("server", "inspect");
    const f = setup(tool, "balanced");
    const mcpTool = { id: tool, name: "inspect", serverId: "server", enabled: true, description: "Inspect", inputSchema: {} };
    f.operation.mcpServers = [{ id: "server", name: "Server", category: "other", status: "online", description: "Test server", icon: "terminal", tools: [mcpTool] }];
    const running = f.run();
    await checkpoint();
    expect(f.pending.get("conversation")?.mcpIdentity).toEqual({ serverId: "server", toolName: "inspect" });
    f.resolve({ kind: "allow_conversation" });
    expect(await running).toBe("mcp result");
    expect(f.grants.get("conversation")).toHaveLength(1);
    expect(f.ports.handlers.mcp).toHaveBeenCalledWith(tool, {}, f.operation.mcpServers, { projectIds: ["project"], signal: f.abort.signal });
    f.grants.clear();
    const changed = f.run();
    await checkpoint();
    f.ports.policy.mcpRuntime = () => ({ servers: [], tools: [{ ...mcpTool, name: "replacement" }] });
    f.resolve({ kind: "allow_once" });
    expect(await changed).toMatchObject({ errorKind: "permission" });
    expect(f.ports.handlers.mcp).toHaveBeenCalledTimes(1);
  });
});

describe("agent terminal isolation", () => {
  test("rejects manual sessions and omits project metadata from agent results", async () => {
    const f = setup("terminal_read");
    f.ports.terminal.cachedSession = () => ({ ...terminalSession, project_id: "manual" });
    expect(await f.run({ session_id: "terminal" })).toContain("manual project terminal");
    f.ports.terminal.cachedSession = () => terminalSession;
    const result = JSON.parse(String(await f.run({ session_id: "terminal" })));
    expect(result).not.toHaveProperty("project_id");
    expect(result).not.toHaveProperty("workspace_path");
  });

  test("abort kills the exact execution and removes its listener after completion", async () => {
    const f = setup("terminal_run");
    const command = deferred<TerminalSessionDto>();
    f.ports.terminal.runCommand = mock(() => command.promise);
    const running = f.run({ session_id: "terminal", command: "pwd", timeout_ms: 9_000_000 });
    await checkpoint();
    f.resolve({ kind: "allow_once" });
    await checkpoint();
    f.abort.abort();
    command.resolve(terminalSession);
    await running;
    expect(f.ports.terminal.runCommand).toHaveBeenCalledWith({ sessionId: "terminal", command: "pwd", timeoutMs: 1_800_000, executionId: expect.any(String) });
    expect(f.ports.terminal.killSession).toHaveBeenCalledWith("terminal", expect.any(String));
    expect(f.ports.terminal.killSession).toHaveBeenCalledTimes(1);
  });
});
