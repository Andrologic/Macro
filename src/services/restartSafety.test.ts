import { describe, expect, it } from "bun:test";
import { selectRestartSafetySnapshot } from "./restartSafety";

describe("selectRestartSafetySnapshot", () => {
  it("collects active conversation runtimes and keeps their titles", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [
        { id: "conversation-1", title: "Build the release" },
        { id: "conversation-2", title: "  " },
        { id: "conversation-3", title: "Finished work" },
      ],
      conversationRuntimeById: {
        "conversation-1": { phase: "streaming", sessionId: "session-1" },
        "conversation-2": { phase: "preparing", sessionId: "session-2" },
        "conversation-3": { phase: "error", sessionId: "session-3" },
      },
    });

    expect(snapshot).toEqual({
      activeAgents: [
        {
          id: "conversation-1",
          kind: "agent",
          phase: "streaming",
          title: "Build the release",
        },
        {
          id: "conversation-2",
          kind: "agent",
          phase: "preparing",
          title: "conversation-2",
        },
      ],
      activeImplementations: [],
      activeAgentCount: 2,
      activeImplementationCount: 0,
      activeWorkCount: 2,
      hasActiveWork: true,
    });
  });

  it("treats overflow recovery and transient compaction as active agent work", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [
        { id: "conversation-1", title: "Recovering stream" },
        { id: "conversation-2", title: "Compacting context" },
        { id: "conversation-3", title: "Stable" },
      ],
      conversationRuntimeById: {
        "conversation-1": {
          phase: "overflow_recovery",
          sessionId: "session-1",
        },
        "conversation-3": { phase: "idle", sessionId: null },
      },
      conversationCompactionStatusById: {
        "conversation-2": { phase: "safety_compacting" },
        "conversation-3": { phase: "compacted" },
      },
    });

    expect(snapshot.activeAgents).toEqual([
      {
        id: "conversation-1",
        kind: "agent",
        phase: "overflow_recovery",
        title: "Recovering stream",
      },
      {
        id: "conversation-2",
        kind: "agent",
        phase: "safety_compacting",
        title: "Compacting context",
      },
    ]);
    expect(snapshot.activeAgentCount).toBe(2);
  });

  it("deduplicates a conversation when runtime and compaction are both active", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [{ id: "conversation-1", title: "Agent" }],
      conversationRuntimeById: {
        "conversation-1": { phase: "streaming", sessionId: "session-1" },
      },
      conversationCompactionStatusById: {
        "conversation-1": { phase: "compacting" },
      },
    });

    expect(snapshot.activeAgents).toHaveLength(1);
    expect(snapshot.activeAgents[0]?.phase).toBe("streaming");
  });

  it("collects running and cancelling Implement command runs with task titles", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [],
      conversationRuntimeById: {},
      tasks: [
        { id: "task-1", title: "Run checks" },
        { id: "task-2", title: "  " },
        { id: "task-3", title: "Finished" },
      ],
      taskCommandRuns: {
        "task-1": { taskId: "task-1", status: "running" },
        "task-2": { taskId: "task-2", status: "cancelling" },
      },
    });

    expect(snapshot.activeImplementations).toEqual([
      {
        id: "task-1",
        kind: "implement",
        phase: "running",
        title: "Run checks",
      },
      {
        id: "task-2",
        kind: "implement",
        phase: "cancelling",
        title: "task-2",
      },
    ]);
    expect(snapshot.activeImplementationCount).toBe(2);
    expect(snapshot.activeWorkCount).toBe(2);
  });

  it("uses the record id when a command run omits its task id", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [],
      conversationRuntimeById: {},
      taskCommandRuns: {
        "task-fallback": {
          taskId: "",
          status: "running",
        },
      },
    });

    expect(snapshot.activeImplementations[0]).toEqual({
      id: "task-fallback",
      kind: "implement",
      phase: "running",
      title: "task-fallback",
    });
  });

  it("returns only plain data that survives JSON serialization", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [{ id: "conversation-1", title: "Agent" }],
      conversationRuntimeById: {
        "conversation-1": {
          phase: "streaming",
          sessionId: "session-1",
          abortController: new AbortController(),
        },
      },
    });

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("does not treat durable task statuses or errored runtimes as active", () => {
    const snapshot = selectRestartSafetySnapshot({
      conversations: [{ id: "conversation-1", title: "Agent" }],
      conversationRuntimeById: {
        "conversation-1": { phase: "error", sessionId: "session-1" },
      },
      tasks: [{ id: "task-1", title: "Awaiting work" }],
      taskCommandRuns: {},
    });

    expect(snapshot.hasActiveWork).toBe(false);
    expect(snapshot.activeWorkCount).toBe(0);
  });
});
