import { chatSendFixture } from "../test-utils/chatSendFixture";
import { resolveScopedMcpRuntime, callScopedMcpTool, type ScopedMcpRuntimeDeps } from "./scopedMcpRuntime";
import { chatRequestPreparationFixture } from "../test-utils/chatRequestPreparationFixture";
import { prepareAssistantStreamLaunch } from "./chatRequestPreparation";
import { getImplementAgentToolPolicy } from "./toolModePolicy";
import { describe, expect, mock, test } from "bun:test";
import type { AgentType, ChatMessage, ConversationRuntimeState, ToolTrace } from "../types";
import { EMPTY_CONVERSATION_RUNTIME } from "../domains/chat/runtimeState";
import { createAssistantStreamRuntime, type ChatAssistantStreamPorts } from "./chatAssistantStreamRuntime";
import { createChatTurnRuntime } from "./chatTurnRuntime";
import type { AssistantStreamLaunch } from "./chatStreamContracts";
import type { ConversationCompactionStatus } from "./contextCompactionSession";
import type { StreamCompletionResult, StreamingChatOptions } from "./streamingChat";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
const result = (visibleContent: string): StreamCompletionResult => ({ visibleContent, toolTraces: [] });

function launch(conversationId: string, sessionId = `${conversationId}-session`): AssistantStreamLaunch {
  const projectId = `${conversationId}-project`;
  const workspacePath = `/workspaces/${projectId}`;
  return {
    sessionId, conversationId,
    assistantMessage: {
      id: `${sessionId}-assistant`, turn_id: `${sessionId}-turn`,
      task_id: `${conversationId}-task`, conversation_id: conversationId,
      role: "assistant", content: "", timestamp: "2026-01-01T00:00:00.000Z",
    },
    replyToMessageId: `${sessionId}-user`, userContent: "Inspect this project",
    modeAtSend: "Architect", resolvedTaskId: `${conversationId}-task`,
    architectPlanAtSend: { planId: `${conversationId}-plan`, targetBranch: "develop" },
    selectedProviderId: "provider", selectedModelId: "model",
    providerConfig: {
      id: "provider", name: "Test provider", providerType: "openai",
      baseUrl: "https://provider.example.test", hasStoredApiKey: false,
      isEnabled: true, isLocal: false,
    },
    messagesForRequest: [{ role: "user", content: "Inspect this project" }],
    contextDiagnosticsBaselineSeed: {
      conversationId, modeAtSend: "Architect", providerId: "provider", providerType: "openai",
      baseUrl: "https://provider.example.test", modelId: "model", modelContextWindowTokens: 128000,
      allowedToolIds: ["read"], toolDefinitions: [], messagesForRequest: [], citations: [],
      repositoryInstructionSources: [], repositoryInstructionIssues: [],
    },
    executionContext: {
      groupId: null, groupName: null, projectIds: [projectId], actionableProjectIds: [projectId],
      contextProjectIds: [], projectMounts: [], focusedProjectId: projectId,
      virtualRootEnabled: false, workspacePathsByProjectId: { [projectId]: workspacePath },
      defaultWorkspacePath: workspacePath, projectId, projectName: projectId,
      taskId: `${conversationId}-task`, branchName: "develop", workspacePath,
    },
    fileToolContext: [], allowedToolIds: ["read"], riskLevel: "balanced",
    scopedTurnConfiguration: null, showToolTraces: true, enableWebSearch: false,
    enableWebFetch: false, webSearchOptions: undefined, mcpTools: [], mcpServers: [],
    skillToolIds: [], runnableSkillToolIds: [], maxTurns: 10,
    abortController: new AbortController(),
  };
}

function setup() {
  const states = new Map<string, ConversationRuntimeState>();
  const messages = new Map<string, ChatMessage>();
  const saved = new Map<string, StreamCompletionResult>();
  const partials: ChatMessage[] = [];
  const statuses = new Map<string, ConversationCompactionStatus>();
  const calls: Array<{ options: StreamingChatOptions; done: ReturnType<typeof deferred<void>> }> = [];
  const cancelTransport = mock((_sessionId: string) => undefined);
  const settled = mock((_conversationId: string) => undefined);
  const owner = createChatTurnRuntime({
    state: {
      read: (id) => states.get(id) ?? EMPTY_CONVERSATION_RUNTIME,
      project: (id, state) => {
        if (state) states.set(id, state);
        else states.delete(id);
      },
      isDeleted: () => false,
    },
    cancelTransport, settled,
  });
  const fields = (id: string, patch: Partial<ChatMessage>) => {
    const message = messages.get(id);
    if (!message) throw new Error(`Missing message ${id}`);
    messages.set(id, { ...message, ...patch });
  };
  const append = mock<ChatAssistantStreamPorts["messages"]["append"]>((id, chunk) => {
    fields(id, { content: messages.get(id)!.content + chunk });
  });
  const complete = mock<ChatAssistantStreamPorts["persistence"]["complete"]>(async (_id, messageId, completion) => {
    saved.set(messageId, structuredClone(completion));
  });
  const partial = mock<ChatAssistantStreamPorts["persistence"]["partial"]>(async (message) => {
    partials.push(structuredClone(message));
  });
  const failed = mock<ChatAssistantStreamPorts["persistence"]["failed"]>((failure) => {
    fields(failure.assistantMessage.id, { persistence_state: "failed", persistence_error: failure.message });
    owner.set(failure.assistantMessage.conversation_id, {
      phase: "error", sessionId: failure.sessionId, turnId: failure.turnId,
      assistantMessageId: failure.assistantMessage.id, abortController: null,
      lastError: failure.message, lastErrorOrigin: "macro", lastErrorDisplayTarget: "composer",
    });
  });
  const sync = mock<ChatAssistantStreamPorts["persistence"]["sync"]>(async () => undefined);
  const execute = mock<ChatAssistantStreamPorts["tools"]["execute"]>(async () => "file contents");
  const preserve = mock<ChatAssistantStreamPorts["tools"]["preserve"]>(async (_operation, _name, _callId, resolution) => resolution);
  const boundError = mock<ChatAssistantStreamPorts["tools"]["boundError"]>(async (_operation, _name, _callId, error) => error);
  const prepare = mock<ChatAssistantStreamPorts["prepare"]>(async () => {
    throw new Error("Unexpected overflow recovery");
  });
  const consolidate = mock(async () => undefined);
  const record = mock<ChatAssistantStreamPorts["diagnostics"]["record"]>(() => undefined);
  const clear = mock<ChatAssistantStreamPorts["diagnostics"]["clear"]>(() => undefined);
  const recordOverflowLimit = mock<ChatAssistantStreamPorts["provider"]["recordOverflowLimit"]>(async () => undefined);
  const taskFailed = mock<ChatAssistantStreamPorts["tasks"]["failed"]>(async () => undefined);
  const deleteMessagesAfter = mock(async (_conversationId: string, _messageId: string) => undefined);
  const unexpectedIpc = async (): Promise<never> => { throw new Error("Unexpected persistence IPC"); };
  const ports: ChatAssistantStreamPorts = {
    owner, isDeleted: () => false,
    messages: {
      get: (id) => messages.get(id),
      ordered: (id) => [...messages.values()].filter((message) => message.conversation_id === id),
      append,
      fields, content: (id, content) => fields(id, { content }),
      completed: mock(() => undefined),
      removeEmpty: (id) => {
        const message = messages.get(id);
        if (message && !message.content && !message.tool_traces?.length) messages.delete(id);
      },
    },
    persistence: {
      complete, partial, failed, sync,
      adapters: {
        isTauriAvailable: () => true,
        ipc: {
          getChatBootstrapSnapshot: unexpectedIpc, listConversations: unexpectedIpc,
          listMessages: unexpectedIpc, createMessage: unexpectedIpc, updateMessage: unexpectedIpc,
          renameConversation: unexpectedIpc, deleteConversation: unexpectedIpc,
          deleteConversations: unexpectedIpc, deleteConversationTurn: unexpectedIpc,
          deleteMessagesAfter,
        },
      },
    },
    tasks: { status: () => "InProgress", failed: taskFailed, awaitingResponse: mock(async () => undefined) },
    provider: { reachable: mock(() => undefined), recordOverflowLimit, copilotTimeout: () => null },
    diagnostics: { record, clear, refresh: mock(async () => undefined) },
    prepare,
    compaction: {
      status: (id) => statuses.get(id),
      setStatus: (id, status) => { statuses.set(id, status); },
      create: () => ({
        compactFollowUpMessagesBeforeProviderRequest: async ({ messages }) => ({ messages }),
        consolidatePendingToolBoundaryCompactionAfterPersistence: consolidate,
      }),
    },
    tools: { execute, preserve, boundError }, replay: { finalize: mock(async () => undefined) },
    transport: (options) => {
      const done = deferred<void>();
      calls.push({ options, done });
      return done.promise;
    },
  };
  const runtime = createAssistantStreamRuntime(ports);
  function start(params: AssistantStreamLaunch) {
    messages.set(params.assistantMessage.id, structuredClone(params.assistantMessage));
    owner.rememberSession(params.conversationId, params.sessionId);
    owner.set(params.conversationId, {
      phase: "preparing", sessionId: params.sessionId, turnId: params.assistantMessage.turn_id,
      assistantMessageId: params.assistantMessage.id, abortController: params.abortController,
      lastError: null,
    });
    runtime.start(params);
    return calls.at(-1)!;
  }
  return {
    owner, runtime, start, calls, messages, saved, partials, statuses,
    cancelTransport, settled, append, complete, partial, failed, sync, execute, preserve,
    prepare, consolidate, record, clear, recordOverflowLimit, deleteMessagesAfter, taskFailed,
  };
}

describe("chatAssistantStreamRuntime with real lifecycle and orchestrator", () => {
  test("runtime helpers load without evaluating stores or React", async () => {
    // A fresh process keeps another test's module cache from hiding this dependency.
    const moduleUrl = new URL("./chatAssistantStreamRuntime.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `
      await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(Object.keys(require.cache).filter(path =>
        /[/\\\\]src[/\\\\]stores[/\\\\]/.test(path) ||
        /[/\\\\]node_modules[/\\\\](react|react-dom)[/\\\\]/.test(path)
      )));
    `], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("two conversations interleave tokens, steers and persistence independently", async () => {
    const h = setup();
    const a = launch("a");
    const b = launch("b");
    const streamA = h.start(a);
    const streamB = h.start(b);
    const persistA = deferred<void>();
    h.complete.mockImplementationOnce(async (_id, messageId, completion) => {
      await persistA.promise;
      h.saved.set(messageId, structuredClone(completion));
    });
    const steerA = { role: "user" as const, content: "A only" };
    const steerB = { role: "user" as const, content: "B only" };
    h.owner.enqueueSteer("a", steerA);
    h.owner.enqueueSteer("b", steerB);
    expect(streamB.options.consumePendingSteers?.()).toEqual([steerB]);
    expect(streamA.options.consumePendingSteers?.()).toEqual([steerA]);
    streamA.options.onToken("A");
    streamB.options.onToken("B");
    streamA.options.onToken(" answer");
    streamA.options.onComplete(result("A answer"));
    streamA.done.resolve();
    expect(h.owner.read("a").phase).toBe("persisting");
    expect(h.owner.read("b").phase).toBe("streaming");
    expect(h.messages.get(a.assistantMessage.id)?.content).toBe("A answer");

    streamB.options.onComplete(result("B answer"));
    streamB.done.resolve();
    await h.owner.drain("b");
    expect(h.owner.read("a").phase).toBe("persisting");
    expect(h.owner.read("b").phase).toBe("idle");
    expect(h.saved.has(a.assistantMessage.id)).toBe(false);
    expect(h.saved.get(b.assistantMessage.id)?.visibleContent).toBe("B answer");
    expect(h.sync.mock.calls).toEqual([["Architect", "b", b.architectPlanAtSend]]);

    persistA.resolve();
    await h.owner.drain("a");
    expect(h.owner.read("a").phase).toBe("idle");
    expect(h.saved.get(a.assistantMessage.id)?.visibleContent).toBe("A answer");
    expect(h.complete.mock.calls.map(([id, messageId]) => [id, messageId])).toEqual([
      ["a", a.assistantMessage.id], ["b", b.assistantMessage.id],
    ]);
    expect(h.append.mock.calls).toEqual([
      [a.assistantMessage.id, "A answer"], [b.assistantMessage.id, "B"],
    ]);
  });

  test("late callbacks from a replaced session cannot write or execute tools", async () => {
    const h = setup();
    const old = launch("a", "old");
    const oldStream = h.start(old);
    const pendingTool = deferred<string>();
    h.execute.mockImplementationOnce(async () => pendingTool.promise);
    const oldTool = oldStream.options.onToolCall?.("read", { path: "file.txt" }, "in-flight");
    const next = launch("a", "next");
    const nextStream = h.start(next);
    const diagnosticsBefore = h.record.mock.calls.length;

    oldStream.options.onToken("stale token");
    oldStream.options.onToolTracesUpdate?.([{ tool_call_id: "stale", tool_name: "read", status: "done" }]);
    oldStream.options.onLiveContextUpdate?.({ version: 1, visibleContent: "stale", visibleContentLength: 5, toolTraces: [] });
    expect(await oldStream.options.onToolCall?.("read", { path: "file.txt" }, "stale")).toMatchObject({ errorKind: "aborted" });
    pendingTool.resolve("Stale tool contents");
    expect(await oldTool).toMatchObject({ errorKind: "aborted" });
    oldStream.options.onComplete(result("stale completion"));
    oldStream.options.onError(new Error("stale failure"));
    oldStream.done.resolve();
    await checkpoint();

    expect(h.messages.get(old.assistantMessage.id)).toEqual(old.assistantMessage);
    expect(h.messages.get(next.assistantMessage.id)).toEqual(next.assistantMessage);
    expect(h.owner.read("a")).toMatchObject({ phase: "streaming", sessionId: "next", lastError: null });
    expect(h.record).toHaveBeenCalledTimes(diagnosticsBefore);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.preserve).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.partial).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.settled).not.toHaveBeenCalled();

    nextStream.options.onComplete(result("current completion"));
    nextStream.done.resolve();
    await h.owner.drain("a");
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.saved.get(next.assistantMessage.id)?.visibleContent).toBe("current completion");
  });

  for (const transportExit of ["resolve", "reject"] as const) {
    test(`stop during a tool waits for partial persistence when transport ${transportExit}s`, async () => {
      const h = setup();
      const params = launch("a");
      const stream = h.start(params);
      const tool = deferred<string>();
      const persistence = deferred<void>();
      h.execute.mockImplementationOnce(async () => tool.promise);
      h.partial.mockImplementationOnce(async (message) => {
        await persistence.promise;
        h.partials.push(structuredClone(message));
      });
      const trace: ToolTrace = { tool_call_id: "read-1", tool_name: "read", status: "running" };
      stream.options.onToken("Partial answer");
      stream.options.onToolTracesUpdate?.([trace]);
      const toolResult = stream.options.onToolCall?.("read", { path: "file.txt" }, "read-1");
      expect(h.execute).toHaveBeenCalledTimes(1);

      h.owner.stop("a");

      expect(params.abortController?.signal.aborted).toBe(true);
      expect(h.cancelTransport.mock.calls).toEqual([[params.sessionId]]);
      expect(h.partial).toHaveBeenCalledTimes(1);
      expect(h.partial.mock.calls[0][0]).toMatchObject({
        content: "Partial answer",
        tool_traces: [{ ...trace, recovery_state: "unknown" }],
      });
      expect(h.messages.get(params.assistantMessage.id)?.content).toBe("Partial answer");
      tool.resolve("Late tool result");
      expect(await toolResult).toMatchObject({ kind: "result", isError: true, errorKind: "aborted" });
      expect(h.preserve).not.toHaveBeenCalled();
      stream.options.onComplete(result("Late full answer"));
      if (transportExit === "resolve") stream.done.resolve();
      else stream.done.reject(new DOMException("Stopped", "AbortError"));
      let drained = false;
      const drain = h.owner.drain("a").then(() => { drained = true; });
      await checkpoint();
      expect(drained).toBe(false);
      expect(h.settled).not.toHaveBeenCalled();
      expect(h.partials).toEqual([]);
      expect(h.complete).not.toHaveBeenCalled();

      persistence.resolve();
      await drain;
      await checkpoint();
      expect(h.partials).toHaveLength(1);
      expect(h.partials[0]).toMatchObject({
        id: params.assistantMessage.id,
        content: "Partial answer",
        tool_traces: [{ ...trace, recovery_state: "unknown" }],
      });
      expect(h.settled.mock.calls).toEqual([["a"]]);
      expect(h.sync).not.toHaveBeenCalled();
      expect(h.deleteMessagesAfter).not.toHaveBeenCalled();
    });
  }

  for (const buffered of [false, true]) {
    test(`stop persists the active ${buffered ? "buffered" : "visible"} generation attempt`, async () => {
      const h = setup();
      const params = launch("a");
      const stream = h.start(params);
      const attempt = {
        id: "attempt-in-flight",
        status: buffered ? "abandoned" as const : "partial" as const,
        rawText: "Partial answer",
        acceptedText: buffered ? "" : "Partial answer",
        costUsd: null,
      };
      if (!buffered) stream.options.onToken("Partial answer");
      stream.options.onGenerationAttemptProgress?.(attempt);

      h.owner.stop("a");
      stream.done.resolve();
      await h.owner.drain("a");

      expect(h.partials).toHaveLength(1);
      expect(h.partials[0]).toMatchObject({
        id: params.assistantMessage.id,
        content: buffered ? "" : "Partial answer",
        generation_attempts: [attempt],
      });
    });
  }

  test("stop before the first token persists an empty in-flight attempt", async () => {
    const h = setup();
    const params = launch("a");
    const stream = h.start(params);
    const attempt = { id: "attempt-before-token", status: "partial" as const, rawText: "", acceptedText: "", costUsd: null };
    stream.options.onGenerationAttemptProgress?.(attempt);

    h.owner.stop("a");
    stream.done.resolve();
    await h.owner.drain("a");

    expect(h.partials).toHaveLength(1);
    expect(h.partials[0]).toMatchObject({ id: params.assistantMessage.id, content: "", generation_attempts: [attempt] });
    expect(h.messages.has(params.assistantMessage.id)).toBe(true);
  });

  test("a failed attempt checkpoint leaves the provider result and final persistence intact", async () => {
    const h = setup();
    const params = launch("a");
    const stream = h.start(params);
    const attempts = [{ id: "attempt-1", status: "completed" as const, rawText: "Answer", acceptedText: "Answer", costUsd: null }];
    h.partial.mockRejectedValueOnce(new Error("SQLITE_BUSY"));

    stream.options.onToken("Answer");
    await stream.options.onGenerationAttemptsUpdate?.(attempts);
    expect(h.partial.mock.calls[0]?.[0]).toMatchObject({ content: "Answer", generation_attempts: attempts });
    expect(h.messages.get(params.assistantMessage.id)?.content).toBe("Answer");

    stream.options.onComplete({ ...result("Answer"), generationAttempts: attempts });
    stream.done.resolve();
    await h.owner.drain("a");

    expect(h.owner.read("a").phase).toBe("idle");
    expect(h.saved.get(params.assistantMessage.id)?.generationAttempts).toEqual(attempts);
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.taskFailed).not.toHaveBeenCalled();
  });

  test("a provider error settles a running tool trace in the current session", async () => {
    const h = setup();
    const params = launch("a");
    const stream = h.start(params);
    stream.options.onToolTracesUpdate?.([{ tool_call_id: "tool-1", tool_name: "read", status: "running" }]);
    stream.options.onError(new Error("provider failed"));
    stream.done.resolve();
    await h.owner.drain("a");

    expect(h.messages.get(params.assistantMessage.id)?.tool_traces).toEqual([
      { tool_call_id: "tool-1", tool_name: "read", status: "running", recovery_state: "unknown" },
    ]);
    expect(h.partials.at(-1)?.tool_traces?.[0]?.recovery_state).toBe("unknown");
  });

  test("failed completion persistence retains the answer and a new turn can succeed", async () => {
    const h = setup();
    const params = launch("a", "first");
    const stream = h.start(params);
    h.complete.mockImplementationOnce(async () => { throw new Error("disk unavailable"); });
    stream.options.onComplete(result("Answer kept in memory"));
    stream.done.resolve();
    await h.owner.drain("a");

    expect(h.owner.read("a")).toMatchObject({ phase: "error", lastError: "disk unavailable", sessionId: "first" });
    expect(h.messages.get(params.assistantMessage.id)).toMatchObject({
      content: "Answer kept in memory", persistence_state: "failed", persistence_error: "disk unavailable",
    });
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.failed.mock.calls[0][0]).toMatchObject({ sessionId: "first", turnId: params.assistantMessage.turn_id });
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.consolidate).not.toHaveBeenCalled();

    const retry = launch("a", "retry");
    const next = h.start(retry);
    stream.options.onError(new Error("late first-turn error"));
    expect(h.owner.read("a")).toMatchObject({ phase: "streaming", sessionId: "retry", lastError: null });
    next.options.onComplete(result("Retried answer"));
    next.done.resolve();
    await h.owner.drain("a");

    expect(h.owner.read("a").phase).toBe("idle");
    expect(h.saved.get(retry.assistantMessage.id)?.visibleContent).toBe("Retried answer");
    expect(h.saved.has(params.assistantMessage.id)).toBe(false);
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.consolidate).toHaveBeenCalledTimes(1);
    expect(h.sync.mock.calls).toEqual([["Architect", "a", retry.architectPlanAtSend]]);
  });

  for (const content of ["Visible progress", ""]) {
    test(`stop during suspended error handling ${content ? "persists progress" : "recovers empty replay"} once`, async () => {
      const h = setup();
      const params = launch("a");
      params.modeAtSend = "Implement";
      const recoverReplay = mock(async () => undefined);
      params.replayRecovery = {
        replayId: "replay-a", onProgress: async () => undefined,
        onFailedBeforeProgress: recoverReplay,
      };
      const failureEffect = deferred<void>();
      h.taskFailed.mockImplementationOnce(async () => failureEffect.promise);
      const stream = h.start(params);
      if (content) stream.options.onToken(content);
      stream.options.onError(new Error("Provider connection lost"));
      await checkpoint();
      expect(h.taskFailed).toHaveBeenCalledTimes(1);

      h.owner.stop("a");
      stream.options.onError(new Error("Late duplicate provider error"));
      stream.options.onComplete(result("Late completion"));
      failureEffect.resolve();
      stream.done.resolve();
      await h.owner.drain("a");

      expect(h.cancelTransport.mock.calls).toEqual([[params.sessionId]]);
      expect(h.complete).not.toHaveBeenCalled();
      if (content) {
        expect(h.partial).toHaveBeenCalledTimes(1);
        expect(h.partials[0]).toMatchObject({ id: params.assistantMessage.id, content });
        expect(h.messages.get(params.assistantMessage.id)?.content).toBe(content);
        expect(recoverReplay).not.toHaveBeenCalled();
      } else {
        expect(recoverReplay).toHaveBeenCalledTimes(1);
        expect(h.partial).not.toHaveBeenCalled();
        expect(h.messages.has(params.assistantMessage.id)).toBe(false);
        expect(h.deleteMessagesAfter.mock.calls).toEqual([["a", params.replyToMessageId]]);
      }
    });
  }

  for (const contextLimit of ["128000", "128,000"]) {
    test(`overflow recovery (${contextLimit} tokens) survives old transport settlement`, async () => {
      const h = setup();
      const params = launch("a");
      const old = h.start(params);
      const initialAttempt = { id: "before-overflow", status: "partial" as const, rawText: "", acceptedText: "", costUsd: null };
      const recoveredAttempt = { id: "after-overflow", status: "completed" as const, rawText: "Recovered answer", acceptedText: "Recovered answer", costUsd: null };
      await old.options.onGenerationAttemptsUpdate?.([initialAttempt]);
      const preparation = deferred<Awaited<ReturnType<ChatAssistantStreamPorts["prepare"]>>>();
      h.prepare.mockImplementationOnce(async () => preparation.promise);
      old.options.onError(new Error(`maximum context length is ${contextLimit} tokens`));
      await checkpoint();

      expect(h.owner.read("a").phase).toBe("overflow_recovery");
      expect(h.statuses.get("a")?.phase).toBe("recovering_overflow");
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.prepare.mock.calls[0][0]).toMatchObject({
        conversationId: "a", executionContext: params.executionContext,
        compactionMode: "stream_overflow", forceCompaction: true, forcePrune: true,
        compactionDisplayAfterMessageId: params.assistantMessage.id,
      });
      expect(h.recordOverflowLimit.mock.calls).toEqual([["provider", "model", 128000]]);
      let drained = false;
      const drain = h.owner.drain("a").then(() => { drained = true; });
      preparation.resolve({ ...params, messagesForRequest: [{ role: "user", content: "Compacted history" }] });
      await checkpoint();
      expect(h.calls).toHaveLength(2);
      const recovered = h.calls[1];
      expect(recovered.options.messages).toEqual([{ role: "user", content: "Compacted history" }]);
      expect(recovered.options.sessionId).toBe(params.sessionId);
      expect(h.owner.read("a").phase).toBe("streaming");
      expect(h.statuses.get("a")?.phase).toBe("compacted");
      const steer = { role: "user" as const, content: "Keep this after recovery" };
      h.owner.enqueueSteer("a", steer);
      const oldFields = structuredClone(h.messages.get(params.assistantMessage.id));
      old.options.onToolTracesUpdate?.([{ tool_call_id: "late", tool_name: "read", status: "done" }]);
      expect(h.messages.get(params.assistantMessage.id)).toEqual(oldFields);
      expect(old.options.consumePendingSteers?.()).toEqual([]);
      expect(String(await old.options.onToolCall?.("read", {}, "late"))).toBe("Tool execution aborted");
      expect(h.execute).not.toHaveBeenCalled();

      old.done.resolve();
      await checkpoint();
      expect(drained).toBe(false);
      expect(h.settled).not.toHaveBeenCalled();
      expect(h.owner.read("a").phase).toBe("streaming");
      expect(recovered.options.consumePendingSteers?.()).toEqual([steer]);
      expect(h.deleteMessagesAfter).not.toHaveBeenCalled();
      recovered.options.onToken("Recovered answer");
      await recovered.options.onGenerationAttemptsUpdate?.([recoveredAttempt]);
      expect(h.messages.get(params.assistantMessage.id)?.generation_attempts).toEqual([initialAttempt, recoveredAttempt]);
      recovered.options.onComplete({ ...result("Recovered answer"), generationAttempts: [recoveredAttempt] });
      recovered.done.resolve();
      await drain;
      await checkpoint();

      expect(h.saved.get(params.assistantMessage.id)?.visibleContent).toBe("Recovered answer");
      expect(h.saved.get(params.assistantMessage.id)?.generationAttempts).toEqual([initialAttempt, recoveredAttempt]);
      expect(h.complete).toHaveBeenCalledTimes(1);
      expect(h.settled.mock.calls).toEqual([["a"]]);
      expect(h.owner.read("a").phase).toBe("idle");
    });
  }

  test("changing external selection keeps tool execution and metadata bound to the sending workspace", async () => {
    const h = setup();
    let selected = launch("a");
    const sent = selected;
    sent.scopedTurnConfiguration = {
      projectIds: ["a-project"], focusProjectId: "a-project", riskLevel: "balanced",
      maxTurns: 10, models: {}, builtInTools: { read: true }, modeTools: {},
      allowedMcpServerIds: [], mcpServers: {},
    };
    const originalContext = structuredClone(sent.executionContext);
    const originalConfiguration = structuredClone(sent.scopedTurnConfiguration);
    const originalPlan = structuredClone(sent.architectPlanAtSend);
    const streamA = h.start(selected);
    const tool = deferred<string>();
    h.execute.mockImplementationOnce(async () => tool.promise);
    const toolResult = streamA.options.onToolCall?.("read", { path: "file.txt" }, "read-a");
    selected = launch("b");
    const streamB = h.start(selected);
    // Simulate reuse of mutable configuration objects by an external selection owner.
    sent.executionContext.workspacePath = selected.executionContext.workspacePath;
    sent.executionContext.workspacePathsByProjectId["a-project"] = "/workspaces/b-project";
    sent.executionContext.projectIds.push("b-project");
    sent.scopedTurnConfiguration.projectIds.push("b-project");
    sent.scopedTurnConfiguration.focusProjectId = "b-project";
    sent.allowedToolIds.push("write");
    sent.architectPlanAtSend!.planId = "b-plan";
    sent.architectPlanAtSend!.targetBranch = "branch-b";
    tool.resolve("A file contents");
    expect(await toolResult).toBe("A file contents");

    const expectedOperation = {
      conversationId: "a", sessionId: sent.sessionId, turnId: sent.assistantMessage.turn_id,
      assistantMessageId: sent.assistantMessage.id, mode: "Architect", taskId: sent.resolvedTaskId,
      executionContext: originalContext, scopedTurnConfiguration: originalConfiguration,
      allowedToolIds: ["read"], architectPlanAtSend: originalPlan,
      signal: sent.abortController!.signal,
    };
    expect(h.execute.mock.calls[0][0]).toMatchObject(expectedOperation);
    expect(h.preserve.mock.calls[0][0]).toBe(h.execute.mock.calls[0][0]);
    expect(streamA.options.workspacePath).toBe(originalContext.workspacePath);
    expect(streamA.options.workspacePath).not.toBe(selected.executionContext.workspacePath);
    await streamA.options.onToolCall?.("read", { path: "second.txt" }, "read-a-2");
    expect(h.execute.mock.calls[1][0]).toMatchObject(expectedOperation);

    streamA.options.onComplete(result("A finished"));
    streamA.done.resolve();
    await h.owner.drain("a");
    expect(h.sync.mock.calls).toEqual([["Architect", "a", originalPlan]]);
    expect(h.owner.read("b")).toMatchObject({ phase: "streaming", sessionId: selected.sessionId });
    expect(h.messages.get(selected.assistantMessage.id)?.content).toBe("");

    streamB.options.onComplete(result("B finished"));
    streamB.done.resolve();
    await h.owner.drain("b");
    expect(h.sync.mock.calls[1]).toEqual(["Architect", "b", selected.architectPlanAtSend]);
  });

  test("metadata keeps the plan captured at start when the source plan is mutated", async () => {
    const h = setup();
    const params = launch("a");
    const originalPlan = structuredClone(params.architectPlanAtSend);
    const stream = h.start(params);
    params.architectPlanAtSend!.planId = "b-plan";
    params.architectPlanAtSend!.targetBranch = "feature/other-workspace";

    stream.options.onComplete(result("A finished"));
    stream.done.resolve();
    await h.owner.drain("a");

    expect(h.sync.mock.calls).toEqual([["Architect", "a", originalPlan]]);
  });
});

async function mcpFixture() {
  let generation = 1;
  const calls: number[] = [];
  let connects = 0;
  const deps: ScopedMcpRuntimeDeps = {
    mcpRuntimeConnect: async selector => {
      connects++;
      return { key: { serverId: selector.serverId, projectId: null, projectIds: [...selector.projectIds], configGeneration: generation },
        status: "ready", requestedProtocolMode: null, negotiatedEra: null, negotiatedProtocolVersion: null,
        protocolDecisionReason: null, lastError: null, updatedAt: "2026-01-01" };
    },
    mcpRuntimeRefreshCatalog: async key => ({ key, tools: [{ id: "mcp__docs__read", serverId: "docs", name: "read", enabled: true }], refreshedAt: "2026-01-01" }),
    mcpRuntimeCallTool: async input => { calls.push(input.key.configGeneration); return { content: "ok", isError: false, rawResult: {} }; },
    mcpRuntimeCancelOperation: async () => true,
  };
  const scoped = await resolveScopedMcpRuntime({ docs: { enabled: true, name: "Docs", transport: { type: "stdio", command: "never-executed" } } }, [], { projectIds: ["a-project"], deps });
  expect(scoped.failures).toEqual([]);
  return { scoped, deps, calls, connects: () => connects, advance: () => { generation = 2; } };
}


test("stream snapshot preserves MCP generation and isolates mutable server data", async () => {
  const mcp = await mcpFixture();
  const h = setup();
  const params = launch("a");
  params.allowedToolIds = ["mcp__docs__read"];
  params.mcpTools = mcp.scoped.tools;
  params.mcpServers = mcp.scoped.servers;
  h.execute.mockImplementation((operation, name, args) => callScopedMcpTool(name, args, operation.mcpServers, {
    projectIds: operation.executionContext.projectIds, signal: operation.signal, deps: mcp.deps,
  }));
  const stream = h.start(params);
  mcp.advance();
  mcp.scoped.servers[0].tools = [];
  const answer = await stream.options.onToolCall?.("mcp__docs__read", {}, "call");
  expect(answer).toBe("ok");
  stream.options.onComplete(result("done"));
  stream.done.resolve();
  await h.owner.drain("a");
  expect(mcp.calls).toEqual([1]);
  expect(mcp.connects()).toBe(1);
});

for (const agentAtSend of ["build", "plan"] as const) {
  test(`overflow retains ${agentAtSend} tool capabilities after selecting the other agent`, async () => {
    const h = setup();
    const params = launch("a");
    params.modeAtSend = "Implement";
    params.agentTypeAtSend = agentAtSend;
    params.allowedToolIds = ["read", "write"].filter(id => getImplementAgentToolPolicy(agentAtSend).allowedToolIds.includes(id));
    params.riskLevel = "yolo";
    params.providerSupportsNativeToolCalling = true;
    const prep = chatRequestPreparationFixture();
    prep.prepared.executionContext = params.executionContext;
    let selectedAgent: AgentType = agentAtSend;
    // Match the product adapter's fallback to the current selection if no agent was captured.
    prep.ports.tools.allowedForMode = async (_profile, _mode, agent) =>
      ["read", "write"].filter(id => getImplementAgentToolPolicy(agent ?? selectedAgent).allowedToolIds.includes(id));
    prep.ports.tools.mcpSnapshot = () => ({ servers: [], enabledTools: () => [] });
    prep.ports.tools.resolveScopedMcp = async () => ({ servers: [], tools: [], failures: [] });
    h.prepare.mockImplementation(request => prepareAssistantStreamLaunch(request, prep.ports));
    const old = h.start(params);
    selectedAgent = agentAtSend === "build" ? "plan" : "build";
    old.options.onError(new Error("maximum context length is 128000 tokens"));
    await checkpoint();
    expect(h.calls).toHaveLength(2);
    const recovered = h.calls[1];
    expect(h.prepare.mock.calls[0][0].agentTypeAtSend).toBe(agentAtSend);
    expect(recovered.options.allowedToolIds).toEqual(old.options.allowedToolIds);
    old.done.resolve();
    recovered.options.onComplete(result("done"));
    recovered.done.resolve();
    await h.owner.drain("a");
  });
}

test("send handles a synchronous diagnostic failure after the real runtime claims streaming", async () => {
  const h = setup();
  const sending = chatSendFixture("Implement");
  sending.ports.owner = h.owner;
  const projectAssistant = sending.ports.projection.publishAssistant;
  sending.ports.projection.publishAssistant = (message, mode, agent) => {
    projectAssistant(message, mode, agent);
    h.messages.set(message.id, message);
  };
  sending.ports.projection.launchError = mock((id, sessionId, _assistantId, error) => ({
    applied: h.owner.failLaunch(id, sessionId, error.message),
  }));
  sending.ports.stream.start = request => h.runtime.start({
    ...launch(request.conversationId, request.sessionId), ...request,
    selectedProviderId: request.providerId, selectedModelId: request.modelId,
  });
  h.record.mockImplementation(() => {
    expect(h.owner.read(sending.input.conversationId).phase).toBe("streaming");
    throw new Error("diagnostics failed after claim");
  });
  await expect(sending.run()).rejects.toThrow("diagnostics failed after claim");
  expect(sending.ports.tasks.rollbackDraft).toHaveBeenCalledTimes(1);
  expect(sending.ports.projection.launchError).toHaveBeenCalledTimes(1);
  expect(h.owner.read(sending.input.conversationId)).toMatchObject({ phase: "error", lastError: "diagnostics failed after claim" });
  expect(h.calls).toHaveLength(0);
});

for (const changeGeneration of [false, true]) {
  test(`overflow reuses captured tool authority with MCP generation change=${changeGeneration}`, async () => {
    const mcp = await mcpFixture();
    const h = setup();
    const params = launch("a");
    params.modeAtSend = "Chat";
    params.allowedToolIds = ["read", "mcp__docs__read"];
    params.mcpTools = mcp.scoped.tools;
    params.mcpServers = mcp.scoped.servers;
    params.riskLevel = "yolo";
    params.maxTurns = 7;
    params.providerSupportsNativeToolCalling = true;
    const prep = chatRequestPreparationFixture();
    prep.prepared.executionContext = params.executionContext;
    // These ports represent settings changed after the first transport started.
    prep.ports.tools.allowedForMode = mock(async () => ["write"]);
    prep.ports.tools.resolveScopedMcp = mock((definitions, servers, options) =>
      resolveScopedMcpRuntime(definitions, servers, { ...options, deps: mcp.deps }));
    prep.ports.configuration.loadRiskLevel = async () => "balanced";
    prep.ports.configuration.loadMaxTurns = async () => 1;
    prep.ports.configuration.webSearch = () => ({ enableWebSearch: true, enableWebFetch: true, webSearchOptions: undefined });
    prep.ports.skills.toolIdsForRequest = () => ({ skillToolIds: ["new-skill"], runnableSkillToolIds: [] });
    h.prepare.mockImplementation(request => prepareAssistantStreamLaunch(request, prep.ports));
    h.execute.mockImplementation((operation, name, args) => {
      expect(operation.riskLevel).toBe("yolo");
      return callScopedMcpTool(name, args, operation.mcpServers, {
        projectIds: operation.executionContext.projectIds, signal: operation.signal, deps: mcp.deps,
      });
    });
    const first = h.start(params);
    if (changeGeneration) mcp.advance();
    first.options.onError(new Error("maximum context length is 128000 tokens"));
    await checkpoint();
    expect(h.calls).toHaveLength(2);
    const recovered = h.calls[1];
    expect(recovered.options.allowedToolIds).toEqual(params.allowedToolIds);
    expect(recovered.options.maxTurns).toBe(7);
    expect(recovered.options.enableWebSearch).toBe(false);
    expect(recovered.options.enableWebFetch).toBe(false);
    expect(recovered.options.skillToolIds).toEqual([]);
    expect(await recovered.options.onToolCall?.("mcp__docs__read", {}, "after-overflow")).toBe("ok");
    recovered.options.onComplete(result("done"));
    first.done.resolve();
    recovered.done.resolve();
    await h.owner.drain("a");
    expect(mcp.calls).toEqual([1]);
    expect(mcp.connects()).toBe(1);
    expect(prep.ports.tools.resolveScopedMcp).not.toHaveBeenCalled();
    expect(prep.ports.tools.allowedForMode).not.toHaveBeenCalled();
  });
}
