import { describe, expect, it } from "bun:test";
import type {
  ApplyConversationGoalVerdictInput,
  ConversationGoal,
  GoalCasOutcome,
} from "../../types/generated/ipc";
import {
  ConversationGoalProductRepository,
  type ConversationGoalProductPorts,
} from "./productRepository";

const nativeGoal = (): ConversationGoal => ({
  conversationId: "conversation-1",
  goalId: "goal-1",
  revision: 4,
  isCurrent: true,
  objective: "Ship the migration",
  successCriteria: ["Tests pass", "Documentation updated"],
  status: "awaiting_user",
  providerId: "provider-1",
  modelId: "model-1",
  reasoningEffort: "high",
  latestVerdict: {
    verdict: "needs_user",
    summary: "A decision is needed.",
    criteria: [{ criterion: "Tests pass", status: "met", evidence: [{ source: "test", finding: "Passed" }] }],
    feedback: "Ask the user.",
    questionForUser: "Which option?",
    confidence: 0.9,
  },
  auditCount: 2,
  continuationCount: 1,
  executorTurnCount: 3,
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-02T10:00:00Z",
  lastAuditedAt: "2026-09-02T09:00:00Z",
  lastExecutorTurnAt: "2026-09-02T08:00:00Z",
  awaitingUserSinceAt: "2026-09-02T10:00:00Z",
  lastError: "Previous provider failure",
});

const ports = (overrides: Partial<ConversationGoalProductPorts> = {}): ConversationGoalProductPorts => ({
  isAvailable: () => true,
  getCurrentGoal: async () => nativeGoal(),
  activateGoal: async () => nativeGoal(),
  updateGoal: async () => "applied",
  applyVerdict: async () => "applied",
  deactivateGoal: async () => "applied",
  ...overrides,
});

describe("ConversationGoalProductRepository", () => {
  it("hydrates all durable fields needed by the banner after restart", async () => {
    const repository = new ConversationGoalProductRepository(ports());
    const goal = await repository.loadCurrentGoal("conversation-1");
    const native = nativeGoal();
    expect(goal).toEqual({
      conversationId: native.conversationId,
      goalId: native.goalId,
      revision: native.revision,
      objective: native.objective,
      successCriteria: native.successCriteria,
      status: native.status,
      providerId: native.providerId,
      modelId: native.modelId,
      reasoningEffort: native.reasoningEffort,
      latestVerdict: native.latestVerdict,
      auditCount: native.auditCount,
      continuationCount: native.continuationCount,
      executorTurnCount: native.executorTurnCount,
      createdAt: native.createdAt,
      updatedAt: native.updatedAt,
      lastAuditedAt: native.lastAuditedAt,
      lastExecutorTurnAt: native.lastExecutorTurnAt,
      awaitingUserSinceAt: native.awaitingUserSinceAt,
      lastError: native.lastError,
    });
    expect(await new ConversationGoalProductRepository(ports({ getCurrentGoal: async () => null }))
      .loadCurrentGoal("conversation-1")).toBeNull();
  });

  it("uses native activation and replacement with the expected CAS identity", async () => {
    const inputs: Parameters<ConversationGoalProductPorts["activateGoal"]>[0][] = [];
    const repository = new ConversationGoalProductRepository(ports({
      async activateGoal(input) { inputs.push(input); return nativeGoal(); },
    }));
    const input = {
      conversationId: "conversation-1",
      goalId: "goal-2",
      objective: "Ship the migration",
      successCriteria: ["Tests pass"],
      providerId: null,
      modelId: null,
      reasoningEffort: null,
    };
    await repository.activateGoal(input);
    await repository.replaceGoal({ ...input, replaceGoalId: "goal-1", replaceRevision: 4 });
    expect(inputs).toEqual([
      { ...input, replaceGoalId: null, replaceRevision: null },
      { ...input, replaceGoalId: "goal-1", replaceRevision: 4 },
    ]);
  });

  it("passes the current revision and criteria to status CAS and preserves every outcome", async () => {
    const calls: Parameters<ConversationGoalProductPorts["updateGoal"]>[0][] = [];
    let outcome: GoalCasOutcome = "applied";
    const repository = new ConversationGoalProductRepository(ports({
      async updateGoal(input) { calls.push(input); return outcome; },
    }));
    const goal = (await repository.loadCurrentGoal("conversation-1"))!;
    for (const next of ["applied", "stale", "missing", "duplicate"] as const) {
      outcome = next;
      expect(await repository.updateGoalStatus(goal, "error", "Provider failed")).toBe(next);
    }
    expect(calls[0]).toEqual({
      conversationId: goal.conversationId,
      goalId: goal.goalId,
      expectedRevision: 4,
      objective: goal.objective,
      successCriteria: ["Tests pass", "Documentation updated"],
      status: "error",
      reason: "Provider failed",
    });
  });

  it("applies verdicts through the native port and exposes duplicate", async () => {
    let received: ApplyConversationGoalVerdictInput | undefined;
    const repository = new ConversationGoalProductRepository(ports({
      async applyVerdict(input) { received = input; return "duplicate"; },
    }));
    const input: ApplyConversationGoalVerdictInput = {
      auditId: "audit-1", conversationId: "conversation-1", goalId: "goal-1",
      expectedRevision: 4, executorTurnId: "turn-1", runId: "run-1",
      verdict: nativeGoal().latestVerdict!,
    };
    expect(await repository.applyVerdict(input)).toBe("duplicate");
    expect(received).toEqual(input);
  });

  it("commits Stop through native CAS before a caller clears local state", async () => {
    const calls: string[] = [];
    let outcome: GoalCasOutcome = "applied";
    const repository = new ConversationGoalProductRepository(ports({
      async deactivateGoal(input) {
        calls.push(`${input.conversationId}:${input.goalId}:${input.expectedRevision}`);
        return outcome;
      },
      async getCurrentGoal() { return null; },
    }));
    expect(await repository.stopGoal(nativeGoal())).toBe("applied");
    outcome = "stale";
    expect(await repository.stopGoal(nativeGoal())).toBe("stale");
    outcome = "missing";
    expect(await repository.stopGoal(nativeGoal())).toBe("missing");
    expect(calls).toEqual(Array(3).fill("conversation-1:goal-1:4"));
    expect(await repository.loadCurrentGoal("conversation-1")).toBeNull();
  });

  it("propagates DB failures and refuses calls when Tauri is unavailable", async () => {
    const failure = new Error("SQLite unavailable");
    const repository = new ConversationGoalProductRepository(ports({
      getCurrentGoal: async () => { throw failure; },
      deactivateGoal: async () => { throw failure; },
    }));
    await expect(repository.loadCurrentGoal("conversation-1")).rejects.toBe(failure);
    await expect(repository.stopGoal(nativeGoal())).rejects.toBe(failure);

    let called = false;
    const unavailable = new ConversationGoalProductRepository(ports({
      isAvailable: () => false,
      getCurrentGoal: async () => { called = true; return null; },
    }));
    await expect(unavailable.loadCurrentGoal("conversation-1")).rejects.toThrow("requires the Tauri runtime");
    expect(called).toBe(false);
  });
});
